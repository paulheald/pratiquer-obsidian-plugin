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

const TERMINAL_STATUSES = new Set(["complete", "partial", "failed"]);
const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = 120_000;

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

	private async sendToPratiquer(): Promise<void> {
		const file = this.app.workspace.getActiveFile();
		if (!file) {
			new Notice("No active note.");
			return;
		}

		const content = await this.app.vault.cachedRead(file);
		const lines = splitLines(content);
		if (lines.length === 0) {
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

		new SetPickerModal(this.app, sets, async (result) => {
			if (result.createNew) {
				new CreateSetModal(this.app, async (input) => {
					try {
						const created = await client.createSet(input.name, input.sourceLang, input.targetLang);
						await this.chooseRefinementsAndSend(file, client, created, lines);
					} catch (e) {
						new Notice(`Failed to create set: ${e instanceof Error ? e.message : e}`, 8000);
					}
				}).open();
			} else {
				await this.chooseRefinementsAndSend(file, client, result.set, lines);
			}
		}).open();
	}

	/** Per-file default resolution (2026-07-17 revision of Open Question 1):
	 * a note's own pratiquer-refinements frontmatter wins if present; falls
	 * back to the plugin's global last-used setting when the note has none
	 * yet. This is a plain preference-memory mechanism, distinct from (and
	 * much simpler than) the frontmatter-based resend/dedup line-tracking
	 * that OBSIDIAN_PLUGIN_PLAN.md §4 describes and that this POC explicitly
	 * does not implement. */
	private resolveDefaultSupports(file: TFile): GenerationSupports {
		const cache = this.app.metadataCache.getFileCache(file);
		const perFile = cache?.frontmatter?.["pratiquer-refinements"] as
			| GenerationSupports
			| undefined;
		return perFile ?? this.settings.lastUsedSupports;
	}

	private async chooseRefinementsAndSend(
		file: TFile,
		client: PratiquerClient,
		targetSet: FlashcardSet,
		lines: string[]
	): Promise<void> {
		const defaults = this.resolveDefaultSupports(file);
		new RefinementModal(this.app, targetSet, defaults, client, async (supports) => {
			// Persist as both the per-file default (frontmatter) and the
			// global last-used fallback for files that have no default yet.
			await this.app.fileManager.processFrontMatter(file, (fm) => {
				fm["pratiquer-refinements"] = supports;
			});
			this.settings.lastUsedSupports = supports;
			await this.saveSettings();

			await this.doSend(client, targetSet, lines, supports);
		}).open();
	}

	private async doSend(
		client: PratiquerClient,
		targetSet: FlashcardSet,
		lines: string[],
		supports: GenerationSupports
	): Promise<void> {
		const items: BatchItem[] = lines.map((line) => ({ side_a_text: line }));
		let batchId: string;
		try {
			const result = await client.submitBatch(targetSet.id, items, supports);
			batchId = result.batch_id;
		} catch (e) {
			new Notice(`Send failed: ${e instanceof Error ? e.message : e}`, 8000);
			return;
		}

		new Notice(`Sending ${lines.length} card(s) to "${targetSet.name}"...`);
		await this.pollUntilDone(client, targetSet, batchId, lines.length);
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
				const succeeded = jobs.length - failed;
				new Notice(
					failed > 0
						? `${succeeded}/${jobs.length} added to "${targetSet.name}", ${failed} failed -- see Pratiquer for details.`
						: `${succeeded}/${jobs.length} card(s) added to "${targetSet.name}".`
				);
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
