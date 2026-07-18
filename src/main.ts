import { Notice, Plugin, TFile } from "obsidian";
import {
	BatchItem,
	CardGenerationJob,
	FlashcardSet,
	GenerationSupports,
	PratiquerClient,
} from "./pratiquer-client";
import {
	DEFAULT_SETTINGS,
	PratiquerSettings,
	PratiquerSettingTab,
	resolveBaseUrl,
} from "./settings";
import { SetPickerModal } from "./set-picker-modal";
import { CreateSetModal } from "./create-set-modal";
import { RefinementModal } from "./refinement-modal";

// needs_review is terminal for polling purposes -- the job won't change
// status again on its own, it's waiting on a human correction in the web
// app's spelling review queue (see backend generation_job_service.py).
const TERMINAL_STATUSES = new Set(["complete", "partial", "failed", "needs_review"]);
const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = 120_000;

const FM_SET_ID = "pratiquer-set-id";
const FM_SYNCED_COUNT = "pratiquer-synced-line-count";
const FM_REFINEMENTS = "pratiquer-refinements";

/** Same line-splitting rule as the web app's paste box
 * (frontend/src/app/pages/batch-create/batch-create.component.ts:544) so a
 * note with one term per line maps 1:1 to a flashcard front, no new parsing
 * convention invented for the plugin. */
function splitLines(text: string): string[] {
	return text
		.split("\n")
		.map((l) => l.trim())
		.filter(Boolean);
}

export default class PratiquerPlugin extends Plugin {
	settings: PratiquerSettings;

	async onload(): Promise<void> {
		await this.loadSettings();

		this.addSettingTab(new PratiquerSettingTab(this.app, this));

		this.addCommand({
			id: "send-to-pratiquer",
			name: "Send to Pratiquer",
			callback: () => this.sendToPratiquer(),
		});

		this.addRibbonIcon("send", "Send to Pratiquer", () => this.sendToPratiquer());
	}

	async loadSettings(): Promise<void> {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	getClient(): PratiquerClient {
		if (!this.settings.token) {
			throw new Error("No API token configured -- set one in Send to Pratiquer's settings.");
		}
		return new PratiquerClient(resolveBaseUrl(this.settings), this.settings.token);
	}

	/** Strips the note's own YAML frontmatter (if any) before splitting into
	 * flashcard lines. Uses the metadata cache's exact frontmatterPosition
	 * offset rather than a hand-rolled `---`-delimiter regex, since that's
	 * what Obsidian itself already computed from the real parse.
	 *
	 * Found 2026-07-17 via real-device testing: without this, a note that had
	 * ever been sent before (and so already carries this plugin's own
	 * pratiquer-refinements/pratiquer-set-id/pratiquer-synced-line-count keys)
	 * gets its frontmatter's raw YAML lines sent as flashcard content on the
	 * *next* send -- "pratiquer-refinements:", "translate: true", "---", etc.
	 * each became their own nonsense card. This wasn't caught earlier because
	 * every send exercised in this environment's testing was a note's FIRST
	 * send, which has no frontmatter yet to leak. */
	private stripFrontmatter(content: string, file: TFile): string {
		const pos = this.app.metadataCache.getFileCache(file)?.frontmatterPosition;
		return pos ? content.slice(pos.end.offset) : content;
	}

	private async sendToPratiquer(): Promise<void> {
		const file = this.app.workspace.getActiveFile();
		if (!file) {
			new Notice("No active note.");
			return;
		}

		const rawContent = await this.app.vault.cachedRead(file);
		const allLines = splitLines(this.stripFrontmatter(rawContent, file));
		if (allLines.length === 0) {
			new Notice("This note has no lines to send.");
			return;
		}

		let client: PratiquerClient;
		try {
			client = this.getClient();
		} catch (e) {
			new Notice(e instanceof Error ? e.message : String(e));
			return;
		}

		let sets: FlashcardSet[];
		try {
			sets = await client.listSets();
		} catch (e) {
			new Notice(`Couldn't reach Pratiquer: ${e instanceof Error ? e.message : e}`, 8000);
			return;
		}

		// Dedup (added 2026-07-17, prompted by real testing surfacing both
		// this bug and the request for it): a note that's already been sent
		// once carries pratiquer-set-id + pratiquer-synced-line-count in its
		// frontmatter. If that target set still exists/is still visible to
		// this account, skip the picker entirely and only send lines past
		// the offset -- known limitation carried over from the parent design
		// doc: inserting a line ABOVE previously-synced ones re-sends it,
		// since this is a line-count offset, not a content hash. Good enough
		// for a running list that only ever grows at the bottom.
		const cache = this.app.metadataCache.getFileCache(file);
		const stickySetId = cache?.frontmatter?.[FM_SET_ID] as number | undefined;
		const syncedCount = (cache?.frontmatter?.[FM_SYNCED_COUNT] as number | undefined) ?? 0;
		const stickySet = stickySetId !== undefined ? sets.find((s) => s.id === stickySetId) : undefined;

		if (stickySet) {
			const newLines = allLines.slice(syncedCount);
			if (newLines.length === 0) {
				new Notice(`Nothing new to send -- all ${allLines.length} line(s) already sent to "${stickySet.name}".`);
				return;
			}
			await this.chooseRefinementsAndSend(file, client, stickySet, allLines, newLines);
			return;
		}

		// Only fetched when the picker is actually going to be shown (a sticky
		// note-frontmatter target skips it entirely, above) -- no point paying
		// for the extra round trip otherwise. A failure here (e.g. the
		// OBSIDIAN_INTEGRATION_ENABLED flag being off) degrades to an empty
		// list rather than blocking the send, since recentSets() itself never
		// throws -- see PratiquerClient.recentSets().
		const recentSets = await client.recentSets();

		new SetPickerModal(this.app, sets, recentSets, async (result) => {
			if (result.createNew) {
				new CreateSetModal(this.app, async (input) => {
					try {
						const created = await client.createSet(input.name, input.sourceLang, input.targetLang);
						await this.chooseRefinementsAndSend(file, client, created, allLines, allLines);
					} catch (e) {
						new Notice(`Failed to create set: ${e instanceof Error ? e.message : e}`, 8000);
					}
				}).open();
			} else {
				await this.chooseRefinementsAndSend(file, client, result.set, allLines, allLines);
			}
		}).open();
	}

	/** Per-file default resolution (2026-07-17 revision of Open Question 1):
	 * a note's own pratiquer-refinements frontmatter wins if present; falls
	 * back to the plugin's global last-used setting when the note has none
	 * yet. */
	private resolveDefaultSupports(file: TFile): GenerationSupports {
		const cache = this.app.metadataCache.getFileCache(file);
		const perFile = cache?.frontmatter?.[FM_REFINEMENTS] as GenerationSupports | undefined;
		return perFile ?? this.settings.lastUsedSupports;
	}

	private async chooseRefinementsAndSend(
		file: TFile,
		client: PratiquerClient,
		targetSet: FlashcardSet,
		allLines: string[],
		linesToSend: string[]
	): Promise<void> {
		const defaults = this.resolveDefaultSupports(file);
		new RefinementModal(this.app, targetSet, defaults, client, async (supports) => {
			this.settings.lastUsedSupports = supports;
			await this.saveSettings();

			await this.doSend(file, client, targetSet, allLines, linesToSend, supports);
		}).open();
	}

	private async doSend(
		file: TFile,
		client: PratiquerClient,
		targetSet: FlashcardSet,
		allLines: string[],
		linesToSend: string[],
		supports: GenerationSupports
	): Promise<void> {
		const items: BatchItem[] = linesToSend.map((line) => ({ side_a_text: line }));
		let batchId: string;
		try {
			const result = await client.submitBatch(targetSet.id, items, supports);
			batchId = result.batch_id;
		} catch (e) {
			new Notice(`Send failed: ${e instanceof Error ? e.message : e}`, 8000);
			return;
		}

		// Persist dedup + per-file refinement bookkeeping now, right after a
		// successful submit -- the cards are queued at this point regardless
		// of how polling below goes, so re-running the command before
		// polling finishes must not re-submit the same lines a second time.
		await this.app.fileManager.processFrontMatter(file, (fm) => {
			fm[FM_SET_ID] = targetSet.id;
			fm[FM_SYNCED_COUNT] = allLines.length;
			fm[FM_REFINEMENTS] = supports;
		});

		new Notice(`Sending ${linesToSend.length} card(s) to "${targetSet.name}"...`);
		await this.pollUntilDone(client, targetSet, batchId, linesToSend.length);
	}

	/** Phase 7: plain polling, not the web app's WebSocket channel --
	 * extending PAT auth to a WS handshake is real extra scope this POC
	 * deliberately defers (see OBSIDIAN_PLUGIN_POC_PLAN.md Phase 7). */
	private async pollUntilDone(
		client: PratiquerClient,
		targetSet: FlashcardSet,
		batchId: string,
		expectedCount: number
	): Promise<void> {
		const startedAt = Date.now();
		// eslint-disable-next-line no-constant-condition
		while (true) {
			let jobs: CardGenerationJob[];
			try {
				jobs = await client.pollBatch(targetSet.id, batchId);
			} catch (e) {
				new Notice(`Lost track of the batch's progress: ${e instanceof Error ? e.message : e}`);
				return;
			}

			const allDone = jobs.length > 0 && jobs.every((j) => TERMINAL_STATUSES.has(j.status));
			if (allDone) {
				const failed = jobs.filter((j) => j.status === "failed").length;
				const needsReview = jobs.filter((j) => j.status === "needs_review").length;
				const succeeded = jobs.length - failed - needsReview;

				const parts = [`${succeeded}/${jobs.length} card(s) added to "${targetSet.name}"`];
				if (needsReview > 0) {
					parts.push(`${needsReview} need spelling review in the Pratiquer web app`);
				}
				if (failed > 0) {
					parts.push(`${failed} failed`);
				}
				new Notice(parts.join(", ") + ".");
				return;
			}

			if (Date.now() - startedAt > POLL_TIMEOUT_MS) {
				new Notice(
					`Still processing "${targetSet.name}" in the background -- check Pratiquer for the final result.`
				);
				return;
			}

			await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
		}
	}
}
