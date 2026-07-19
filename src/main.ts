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
import { langLabel } from "./lang-utils";

// needs_review is terminal for polling purposes -- the job won't change
// status again on its own, it's waiting on a human correction in the web
// app's spelling review queue (see backend generation_job_service.py).
const TERMINAL_STATUSES = new Set(["complete", "partial", "failed", "needs_review"]);
const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = 120_000;

const FM_SET_ID = "pratiquer-set-id";
const FM_SYNCED_COUNT = "pratiquer-synced-line-count";
const FM_LIST_SIDE = "pratiquer-list-side";

// Flat per-refinement frontmatter keys (v0.6.0+) -- each shows up in
// Obsidian's native Properties panel as its own proper Checkbox/Text field.
// Previously this was one `pratiquer-refinements` key holding the whole
// GenerationSupports object as a nested YAML blob, which the Properties
// panel can't render as anything but raw-looking text -- exactly what a
// user asked to get away from ("I was expecting UI instead of JSON").
const FM_SPELLCHECK = "pratiquer-spellcheck";
const FM_TRANSLATE = "pratiquer-translate";
const FM_IMAGE = "pratiquer-image";
const FM_IMAGE_TARGET = "pratiquer-image-target";
const FM_AUDIO = "pratiquer-audio";
const FM_AUDIO_TARGET = "pratiquer-audio-target";
const FM_AUDIO_VOICE_A = "pratiquer-audio-voice-a";
const FM_AUDIO_PROVIDER_A = "pratiquer-audio-provider-a";
const FM_AUDIO_VOICE_B = "pratiquer-audio-voice-b";
const FM_AUDIO_PROVIDER_B = "pratiquer-audio-provider-b";
/** Superseded by the flat FM_* keys above -- kept read-only so notes sent by
 * an older plugin version don't silently lose their per-note refinement
 * defaults on the first send after upgrading. Never written again. */
const FM_REFINEMENTS_LEGACY = "pratiquer-refinements";

/** Writes `supports` as the flat FM_* keys above, and clears any leftover
 * nested legacy blob. Keys for a refinement that's off/unset are deleted
 * rather than written as empty, so the Properties panel only ever shows
 * what's actually active (no "audio-voice-a: " clutter when audio is off). */
function writeSupportsToFrontmatter(fm: Record<string, unknown>, supports: GenerationSupports): void {
	delete fm[FM_REFINEMENTS_LEGACY];

	fm[FM_SPELLCHECK] = !!supports.spellcheck;
	fm[FM_TRANSLATE] = !!supports.translate;
	fm[FM_IMAGE] = supports.image ?? "none";
	fm[FM_AUDIO] = !!supports.audio;

	if (supports.image && supports.image !== "none") {
		fm[FM_IMAGE_TARGET] = supports.image_target ?? "a";
	} else {
		delete fm[FM_IMAGE_TARGET];
	}

	if (supports.audio) {
		fm[FM_AUDIO_TARGET] = supports.audio_target ?? "a";
		if (supports.audio_voice_a) fm[FM_AUDIO_VOICE_A] = supports.audio_voice_a;
		else delete fm[FM_AUDIO_VOICE_A];
		if (supports.audio_provider_a) fm[FM_AUDIO_PROVIDER_A] = supports.audio_provider_a;
		else delete fm[FM_AUDIO_PROVIDER_A];
		if (supports.audio_voice_b) fm[FM_AUDIO_VOICE_B] = supports.audio_voice_b;
		else delete fm[FM_AUDIO_VOICE_B];
		if (supports.audio_provider_b) fm[FM_AUDIO_PROVIDER_B] = supports.audio_provider_b;
		else delete fm[FM_AUDIO_PROVIDER_B];
	} else {
		delete fm[FM_AUDIO_TARGET];
		delete fm[FM_AUDIO_VOICE_A];
		delete fm[FM_AUDIO_PROVIDER_A];
		delete fm[FM_AUDIO_VOICE_B];
		delete fm[FM_AUDIO_PROVIDER_B];
	}
}

/** A voice fixed by an older, buggy plugin build stored the dropdown's raw
 * "<provider>:<voice>" id directly in audio_voice_a/b with no
 * audio_provider_a/b at all (see RefinementModal's splitVoiceId -- that fix
 * landed 2026-07-19). Splits it back apart here so a note last sent before
 * that fix doesn't keep failing audio generation forever with a voice string
 * no provider recognizes. */
function repairLegacyVoice(voice: string | undefined, provider: string | undefined): { voice?: string; provider?: string } {
	if (provider || !voice || !voice.includes(":")) return { voice, provider };
	const idx = voice.indexOf(":");
	return { provider: voice.slice(0, idx), voice: voice.slice(idx + 1) };
}

/** Reads a per-note refinement default back out of frontmatter -- prefers
 * the flat FM_* keys, falling back to the legacy nested blob for notes sent
 * before v0.6.0 so they don't reset to the plugin's global default on their
 * first post-upgrade send. */
function readSupportsFromFrontmatter(fm: Record<string, unknown> | undefined): GenerationSupports | undefined {
	if (!fm) return undefined;
	if (FM_SPELLCHECK in fm || FM_TRANSLATE in fm || FM_IMAGE in fm || FM_AUDIO in fm) {
		const a = repairLegacyVoice(fm[FM_AUDIO_VOICE_A] as string | undefined, fm[FM_AUDIO_PROVIDER_A] as string | undefined);
		const b = repairLegacyVoice(fm[FM_AUDIO_VOICE_B] as string | undefined, fm[FM_AUDIO_PROVIDER_B] as string | undefined);
		return {
			spellcheck: !!fm[FM_SPELLCHECK],
			translate: !!fm[FM_TRANSLATE],
			image: (fm[FM_IMAGE] as GenerationSupports["image"]) ?? "none",
			image_target: fm[FM_IMAGE_TARGET] as GenerationSupports["image_target"],
			audio: !!fm[FM_AUDIO],
			audio_target: fm[FM_AUDIO_TARGET] as GenerationSupports["audio_target"],
			audio_voice_a: a.voice,
			audio_provider_a: a.provider,
			audio_voice_b: b.voice,
			audio_provider_b: b.provider,
		};
	}
	return fm[FM_REFINEMENTS_LEGACY] as GenerationSupports | undefined;
}

/** Formats `pratiquer-list-side` as "Side A (French)" instead of a bare "a"
 * -- readable directly in Obsidian's Properties panel without having to
 * cross-reference which side of the set "a" even means. */
function formatListSide(side: "a" | "b", targetSet: FlashcardSet): string {
	const lang = side === "b" ? targetSet.target_lang : targetSet.source_lang;
	return `Side ${side.toUpperCase()} (${langLabel(lang)})`;
}

/** Parses a stored list-side value back to "a"/"b". Accepts both the
 * friendly "Side A (French)" format (v0.6.0+) and the bare "a"/"b" a note
 * may still carry from an older plugin version. */
function parseListSide(value: unknown): "a" | "b" | undefined {
	if (value === "a" || value === "b") return value;
	if (typeof value !== "string") return undefined;
	if (/^side\s*a\b/i.test(value)) return "a";
	if (/^side\s*b\b/i.test(value)) return "b";
	return undefined;
}

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

		this.addCommand({
			id: "change-pratiquer-destination",
			name: "Change destination flashcard set",
			callback: () => this.changeDestinationCommand(),
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
			// Reuse the list-side answer from this note's first send (stored in
			// its frontmatter below) rather than asking again on every follow-up
			// send to the same running list.
			const stickyListSide = parseListSide(cache?.frontmatter?.[FM_LIST_SIDE]);
			await this.chooseRefinementsAndSend(file, client, stickySet, allLines, newLines, stickyListSide ?? null);
			return;
		}

		await this.pickDestinationAndSend(file, client, allLines);
	}

	/** Standalone entry point for retargeting a note that's already sticky to
	 * a set, without needing new lines to send -- sendToPratiquer's sticky
	 * path bails early with "Nothing new to send" in that case, which would
	 * otherwise make the destination unreachable from the picker/RefinementModal
	 * flow entirely. Always does a full resend of every line in the note
	 * against the newly chosen set, same as picking a destination for a note
	 * that's never been sent before -- none of those lines have reached the
	 * new set yet, however many already went to the old one. */
	private async changeDestinationCommand(): Promise<void> {
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

		await this.pickDestinationAndSend(file, client, allLines);
	}

	/** Shared by the first-ever send for a note and by explicit
	 * "change destination" (both the command and RefinementModal's "Change"
	 * button) -- always offers the full set list + recently-used shortcut,
	 * and always resends every line in `allLines`, since a newly (re)chosen
	 * destination has none of them yet. */
	private async pickDestinationAndSend(
		file: TFile,
		client: PratiquerClient,
		allLines: string[]
	): Promise<void> {
		let sets: FlashcardSet[];
		try {
			sets = await client.listSets();
		} catch (e) {
			new Notice(`Couldn't reach Pratiquer: ${e instanceof Error ? e.message : e}`, 8000);
			return;
		}
		// A failure here (e.g. the OBSIDIAN_INTEGRATION_ENABLED flag being off)
		// degrades to an empty list rather than blocking the send, since
		// recentSets() itself never throws -- see PratiquerClient.recentSets().
		const recentSets = await client.recentSets();

		new SetPickerModal(this.app, sets, recentSets, async (result) => {
			if (result.createNew) {
				new CreateSetModal(this.app, client, async (input) => {
					try {
						// listLang -> source_lang (side A), knownLang -> target_lang
						// (side B) -- matches the fact every line always lands in
						// side_a_text below, so side A must be the note's own language.
						const created = await client.createSet(input.name, input.listLang, input.knownLang, input.subject);
						// Freshly created with source_lang = the note's own language, so
						// side A is guaranteed correct -- no need to ask again.
						await this.chooseRefinementsAndSend(file, client, created, allLines, allLines, "a");
					} catch (e) {
						new Notice(`Failed to create set: ${e instanceof Error ? e.message : e}`, 8000);
					}
				}).open();
			} else {
				// An existing set's source_lang/target_lang were fixed whenever it
				// was first created and may not match which language *this* note's
				// words are in -- chooseRefinementsAndSend asks via RefinementModal.
				await this.chooseRefinementsAndSend(file, client, result.set, allLines, allLines, null);
			}
		}).open();
	}

	/** Per-file default resolution (2026-07-17 revision of Open Question 1):
	 * a note's own refinement frontmatter wins if present; falls back to the
	 * plugin's global last-used setting when the note has none yet. */
	private resolveDefaultSupports(file: TFile): GenerationSupports {
		const cache = this.app.metadataCache.getFileCache(file);
		const perFile = readSupportsFromFrontmatter(cache?.frontmatter);
		return perFile ?? this.settings.lastUsedSupports;
	}

	/** forceListSide: "a" when the caller already knows the note's language
	 * matches the set's side A (e.g. a set just created from this note, whose
	 * source_lang was set from this same input) -- skips asking again. `null`
	 * lets RefinementModal ask, for an existing set whose side A may or may
	 * not match this particular note's language. */
	private async chooseRefinementsAndSend(
		file: TFile,
		client: PratiquerClient,
		targetSet: FlashcardSet,
		allLines: string[],
		linesToSend: string[],
		forceListSide: "a" | "b" | null
	): Promise<void> {
		const defaults = this.resolveDefaultSupports(file);
		new RefinementModal(
			this.app,
			targetSet,
			defaults,
			client,
			forceListSide,
			async (supports, listSide) => {
				this.settings.lastUsedSupports = supports;
				await this.saveSettings();

				await this.doSend(file, client, targetSet, allLines, linesToSend, supports, listSide);
			},
			// Re-picking a destination always means a full resend against
			// whatever's newly chosen -- linesToSend (which may be a
			// sticky-set's trailing-offset slice) doesn't apply once the
			// target itself has changed.
			() => this.pickDestinationAndSend(file, client, allLines)
		).open();
	}

	private async doSend(
		file: TFile,
		client: PratiquerClient,
		targetSet: FlashcardSet,
		allLines: string[],
		linesToSend: string[],
		supports: GenerationSupports,
		listSide: "a" | "b"
	): Promise<void> {
		// Source attribution: which note a card came from, same field the web
		// app already labels "Personal Notes & Usage Context" and shows right
		// on the card in the editor -- costs nothing extra to send (the note
		// is already being read/transmitted for its line content) and gives
		// every card a "where did I meet this word" hook, the same value an
		// e-reader's book title/author would eventually add. See
		// obsidian-plugin-plan.md's #2.
		const sourceNote = `Captured from Obsidian note "${file.basename}"`;
		const items: BatchItem[] = linesToSend.map((line) =>
			listSide === "b"
				? { side_b_text: line, notes: sourceNote }
				: { side_a_text: line, notes: sourceNote }
		);
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
			fm[FM_LIST_SIDE] = formatListSide(listSide, targetSet);
			writeSupportsToFrontmatter(fm, supports);
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
