import { App, Modal, Notice, Setting, setIcon } from "obsidian";
import { FlashcardSet, GenerationSupports, PratiquerClient, TtsVoice } from "./pratiquer-client";
import { langLabel } from "./lang-utils";

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
		private onSubmit: (supports: GenerationSupports, listSide: "a" | "b") => void,
		/** Closes this modal and hands control back to main.ts's destination
		 * picker -- lets the user redirect a note to a different (or brand
		 * new) set right from the send confirmation, instead of having to
		 * hand-edit the note's `pratiquer-set-id` frontmatter to do it. */
		private onChangeDestination: () => void
	) {
		super(app);
		// Shallow copy -- never mutate the caller's default object in place.
		this.supports = { ...initialSupports };
		this.listSide = forceListSide ?? "a";
	}

	onOpen(): void {
		this.render();
		// If this note already has an audio default (from a previous send, or
		// the plugin's global last-used setting), the toggle's own onChange
		// below never fires -- audio starts "on" without ever running the
		// fetch that populates voicesA/voicesB. Without this, that first
		// render's Audio section finds both arrays empty and silently omits
		// the voice dropdowns entirely (no error, no message), and Send goes
		// out with audio=true but no audio_voice_a/b for the backend to use.
		if (this.supports.audio) {
			void this.ensureVoicesLoaded().then(() => this.render());
		}
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

	/** Small labelled section header, purely visual grouping so the settings
	 * list below doesn't read as one undifferentiated wall of rows. */
	private sectionHeader(parent: HTMLElement, text: string): void {
		parent.createEl("div", { text, cls: "pratiquer-section-header" });
	}

	/** A TtsVoice.id is "<provider>:<voice>" (see backend tts_service.py's
	 * get_available_voices) -- opaque to the dropdown, but the backend's
	 * per-side audio step reads provider and voice as two separate
	 * GenerationSupports keys (generation_job_service.py), same as the web
	 * app's own splitTtsVoiceId. Sending the combined id through as
	 * audio_voice_a un-split resolves to a voice string the provider doesn't
	 * recognize and synthesis fails outright. */
	private splitVoiceId(id: string): { provider: string; voice: string } {
		const idx = id.indexOf(":");
		return idx === -1 ? { provider: id, voice: "" } : { provider: id.slice(0, idx), voice: id.slice(idx + 1) };
	}

	private setVoice(side: "a" | "b", id: string): void {
		const { provider, voice } = this.splitVoiceId(id);
		if (side === "a") {
			this.supports.audio_provider_a = provider;
			this.supports.audio_voice_a = voice;
		} else {
			this.supports.audio_provider_b = provider;
			this.supports.audio_voice_b = voice;
		}
	}

	/** Renders side `side`'s voice picker, or a "no voices available" notice
	 * in its place once the fetch has actually resolved empty -- silently
	 * showing nothing here is what let a note go out with audio on and no
	 * voice at all, since there'd be no dropdown *and* no explanation. */
	private renderVoicePicker(parent: HTMLElement, side: "a" | "b"): void {
		const voices = side === "a" ? this.voicesA : this.voicesB;
		if (voices.length === 0) {
			if (this.voicesLoaded) {
				parent.createDiv({
					text: `No voices are currently available for Side ${side.toUpperCase()}'s language.`,
					cls: "pratiquer-voice-unavailable",
				});
			}
			return;
		}
		// Accepting the pre-selected default without ever touching the
		// dropdown must still count as a real choice -- addDropdown's
		// setValue() only changes what's displayed, it doesn't fire onChange
		// or write back to `supports`. Without this, a user who leaves the
		// default voice as-is (the common case) sent audio_voice_a/b as
		// undefined, and the backend's "no voice selected" fallback fired
		// even though a voice was, in fact, showing right there in the UI.
		const currentVoice = side === "a" ? this.supports.audio_voice_a : this.supports.audio_voice_b;
		const currentProvider = side === "a" ? this.supports.audio_provider_a : this.supports.audio_provider_b;
		// Prefer an exact "provider:voice" match once both halves are known
		// (the normal case post-fix) -- falling straight to the endsWith
		// suffix match would risk picking a different provider's voice that
		// happens to share the same trailing slug.
		const exact = currentProvider && currentVoice ? `${currentProvider}:${currentVoice}` : undefined;
		const currentId =
			(exact && voices.some((v) => v.id === exact) ? exact : undefined) ??
			(currentVoice ? voices.find((v) => v.id.endsWith(`:${currentVoice}`))?.id : undefined);
		const defaultId = currentId ?? voices[0].id;
		this.setVoice(side, defaultId);
		new Setting(parent).setName(`Voice (side ${side.toUpperCase()})`).addDropdown((dd) => {
			for (const v of voices) dd.addOption(v.id, v.label);
			dd.setValue(defaultId).onChange((v) => this.setVoice(side, v));
		});
	}

	/** Gates the Send button: audio can't go out for a side with no voice
	 * resolvable at all (no reachable/language-matched TTS provider), since
	 * the backend has no fallback voice and would just silently drop that
	 * side's audio. Doesn't block on `!voicesLoaded` -- the fetch is already
	 * in flight by the time a user could reach this button (kicked off by
	 * either onOpen or the Audio toggle, both of which re-render on
	 * completion), so treating "not loaded yet" as blocking would only cause
	 * a flash of a disabled button before the real state settles in. */
	private canSend(): boolean {
		if (!this.supports.audio) return true;
		const target = this.supports.audio_target ?? "a";
		const sides: ("a" | "b")[] = target === "both" ? ["a", "b"] : [target];
		return sides.every((side) => {
			if (!this.voicesLoaded) return true;
			const voices = side === "a" ? this.voicesA : this.voicesB;
			return voices.length > 0;
		});
	}

	private render(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("pratiquer-modal");
		const header = contentEl.createDiv({ cls: "pratiquer-modal-header" });
		setIcon(header.createDiv({ cls: "pratiquer-modal-header-icon" }), "send");
		header.createEl("h2", { text: "Send to Pratiquer" });

		const destCard = contentEl.createDiv({ cls: "pratiquer-dest-card" });
		const destIcon = destCard.createDiv({ cls: "pratiquer-dest-icon" });
		setIcon(destIcon, "layers");
		const destInfo = destCard.createDiv({ cls: "pratiquer-dest-info" });
		destInfo.createDiv({ text: "Destination", cls: "pratiquer-dest-label" });
		destInfo.createDiv({ text: this.targetSet.name, cls: "pratiquer-dest-name" });
		const changeBtn = destCard.createEl("button", {
			text: "Change...",
			cls: "pratiquer-dest-change",
		});
		changeBtn.addEventListener("click", () => {
			this.close();
			this.onChangeDestination();
		});

		this.sectionHeader(contentEl, "Content");

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

		this.sectionHeader(contentEl, "Media");

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
			if (target === "a" || target === "both") this.renderVoicePicker(contentEl, "a");
			if (target === "b" || target === "both") this.renderVoicePicker(contentEl, "b");
		}

		new Setting(contentEl).addButton((btn) =>
			btn
				.setButtonText("Send")
				.setCta()
				.setDisabled(!this.canSend())
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
