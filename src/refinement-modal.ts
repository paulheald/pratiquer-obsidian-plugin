import { App, Modal, Notice, Setting } from "obsidian";
import { FlashcardSet, GenerationSupports, PratiquerClient, TtsVoice } from "./pratiquer-client";
import { SUPPORTED_LANGUAGES } from "./settings";

/** Set languages may be short ("fr", from this plugin) or full locale codes
 * ("fr-fr", from the web app) -- normalize before the SUPPORTED_LANGUAGES
 * lookup, same trick as the web app's shortLangCode(). */
function langLabel(code: string | null | undefined): string {
	if (!code) return "?";
	const short = code.split("-")[0];
	return SUPPORTED_LANGUAGES.find((l) => l.code === short)?.label ?? code;
}

/**
 * Confirm-before-send dialog (POC plan Phase 5) -- shown on every send, not
 * just a settings-tab default, per the 2026-07-17 revision of Open Question 1.
 * Pre-filled from whatever the caller resolved as the default (per-file
 * frontmatter if present, else the plugin's global last-used setting) --
 * that resolution happens in main.ts, this modal just edits+confirms.
 */
export class RefinementModal extends Modal {
	private supports: GenerationSupports;
	private voicesA: TtsVoice[] = [];
	private voicesB: TtsVoice[] = [];
	private voicesLoaded = false;
	private listSide: "a" | "b";

	constructor(
		app: App,
		private targetSet: FlashcardSet,
		initialSupports: GenerationSupports,
		private client: PratiquerClient,
		/** Non-null when the caller already knows which side the note's
		 * language is on (e.g. a set just created from this same note) --
		 * skips showing the "My list is in" picker below. */
		private forceListSide: "a" | "b" | null,
		private onSubmit: (supports: GenerationSupports, listSide: "a" | "b") => void
	) {
		super(app);
		// Shallow copy -- never mutate the caller's default object in place.
		this.supports = { ...initialSupports };
		this.listSide = forceListSide ?? "a";
	}

	onOpen(): void {
		this.render();
	}

	private async ensureVoicesLoaded(): Promise<void> {
		if (this.voicesLoaded) return;
		try {
			const [a, b] = await Promise.all([
				this.client.listVoices(this.targetSet.source_lang),
				this.targetSet.target_lang
					? this.client.listVoices(this.targetSet.target_lang)
					: Promise.resolve([]),
			]);
			this.voicesA = a;
			this.voicesB = b;
			this.voicesLoaded = true;
		} catch (e) {
			new Notice(`Failed to load voices: ${e instanceof Error ? e.message : e}`);
		}
	}

	private render(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h2", { text: `Send to "${this.targetSet.name}"` });

		// Only asked for an existing set (forceListSide is null) with a real
		// language pair -- this set's source_lang/target_lang were fixed when
		// it was first created and may not match which language *this* note's
		// words happen to be in. Getting this wrong is the exact bug reported
		// 2026-07-18: a French note sent into a set whose side A was assumed
		// to be French produced an inverted/mistranslated set. See
		// batch-import-language-pairing-fix.md for the web app's version of
		// the same fix (its "My list is in" selector).
		if (this.forceListSide === null && this.targetSet.target_lang) {
			new Setting(contentEl)
				.setName("My list is in")
				.setDesc(`Which language these lines are written in -- decides which side of "${this.targetSet.name}" they land on.`)
				.addDropdown((dd) =>
					dd
						.addOption("a", langLabel(this.targetSet.source_lang))
						.addOption("b", langLabel(this.targetSet.target_lang))
						.setValue(this.listSide)
						.onChange((v: "a" | "b") => (this.listSide = v))
				);
		}

		new Setting(contentEl)
			.setName("Spell check on import")
			.setDesc(
				"Catch missing accents and typos (e.g. \"maitresse\" -> \"maîtresse\") before a card is created. Flagged lines pause for review in the Pratiquer web app instead of becoming bad cards."
			)
			.addToggle((tg) =>
				tg.setValue(!!this.supports.spellcheck).onChange((v) => (this.supports.spellcheck = v))
			);

		new Setting(contentEl)
			.setName("Auto-fill other side")
			.setDesc("Translate each line into the set's other language.")
			.addToggle((tg) =>
				tg.setValue(!!this.supports.translate).onChange((v) => (this.supports.translate = v))
			);

		new Setting(contentEl).setName("Image").addDropdown((dd) =>
			dd
				.addOption("none", "None")
				.addOption("ai", "AI generated")
				.addOption("pixabay", "Pixabay photo")
				.setValue(this.supports.image ?? "none")
				.onChange((v: "none" | "ai" | "pixabay") => {
					this.supports.image = v;
					this.render();
				})
		);

		if (this.supports.image && this.supports.image !== "none") {
			new Setting(contentEl).setName("Image on side").addDropdown((dd) =>
				dd
					.addOption("a", "Side A")
					.addOption("b", "Side B")
					.addOption("both", "Both sides")
					.setValue(this.supports.image_target ?? "a")
					.onChange((v: "a" | "b" | "both") => (this.supports.image_target = v))
			);
		}

		new Setting(contentEl)
			.setName("Audio")
			.setDesc("Generate spoken-word audio via text-to-speech.")
			.addToggle((tg) =>
				tg.setValue(!!this.supports.audio).onChange(async (v) => {
					this.supports.audio = v;
					if (v) await this.ensureVoicesLoaded();
					this.render();
				})
			);

		if (this.supports.audio) {
			new Setting(contentEl).setName("Audio on side").addDropdown((dd) =>
				dd
					.addOption("a", "Side A")
					.addOption("b", "Side B")
					.addOption("both", "Both sides")
					.setValue(this.supports.audio_target ?? "a")
					.onChange((v: "a" | "b" | "both") => (this.supports.audio_target = v))
			);

			const target = this.supports.audio_target ?? "a";
			if ((target === "a" || target === "both") && this.voicesA.length > 0) {
				new Setting(contentEl).setName("Voice (side A)").addDropdown((dd) => {
					for (const v of this.voicesA) dd.addOption(v.id, v.label);
					dd.setValue(this.supports.audio_voice_a ?? this.voicesA[0].id).onChange(
						(v) => (this.supports.audio_voice_a = v)
					);
				});
			}
			if ((target === "b" || target === "both") && this.voicesB.length > 0) {
				new Setting(contentEl).setName("Voice (side B)").addDropdown((dd) => {
					for (const v of this.voicesB) dd.addOption(v.id, v.label);
					dd.setValue(this.supports.audio_voice_b ?? this.voicesB[0].id).onChange(
						(v) => (this.supports.audio_voice_b = v)
					);
				});
			}
		}

		new Setting(contentEl).addButton((btn) =>
			btn
				.setButtonText("Send")
				.setCta()
				.onClick(() => {
					this.close();
					this.onSubmit(this.supports, this.listSide);
				})
		);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
