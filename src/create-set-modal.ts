import { App, Modal, Setting, setIcon } from "obsidian";
import { SUPPORTED_LANGUAGES } from "./settings";
import { PratiquerClient, SubjectOption } from "./pratiquer-client";
import { detectLanguage } from "./lang-detect";

export interface NewSetInput {
	name: string;
	listLang: string;
	knownLang: string;
	subject: string;
}

/** Shown immediately while the real list loads from GET /subjects, and kept
 * as the only option if that fetch degrades to empty (old backend, or a
 * network failure) -- "general" is also the backend's own default
 * (flashcards.py's create_group), so a set created before/without the real
 * list still lands exactly where it would have with no subject picker at all. */
const FALLBACK_SUBJECTS: SubjectOption[] = [{ value: "general", label: "General Education", icon: "school" }];

/** Phase 6: create-new-set flow. Deliberately asks for both languages
 * explicitly rather than silently defaulting source_lang server-side
 * (FlashcardSetCreate's default is "en-us") -- a silent default would
 * produce a confusingly-labeled set the user didn't actually choose.
 *
 * Asks in "my list is in / I already know" terms (same wording as the web
 * app's csv-import-language-dialog), not "source/target" -- because whatever
 * the user answers for "my list is in" MUST become source_lang (side A),
 * since every line sent from the note always lands in side_a_text (see
 * main.ts's doSend). An earlier version of this modal asked "I know this
 * language" for source_lang, which silently inverted the set's languages
 * against the actual note content: a French vocab note through "I know
 * English / Studying French" created a set labeled source_lang=en but whose
 * side A was actually full of French words -- the same root cause as the
 * web app's CSV import bug (see batch-import-language-pairing-fix.md), just
 * never ported to this modal when that one was fixed. */
export class CreateSetModal extends Modal {
	private name = "";
	private listLang = "fr";
	private knownLang = "en";
	private subject = FALLBACK_SUBJECTS[0].value;
	private subjectOptions: SubjectOption[] = FALLBACK_SUBJECTS;
	private detectedLang: string | null = null;

	constructor(
		app: App,
		private client: PratiquerClient,
		private onSubmit: (input: NewSetInput) => void,
		/** The note's own lines, used only to guess `listLang` -- never asked
		 * for beyond that, and always just a pre-selected default the user can
		 * still freely change. See lang-detect.ts's docstring for why this is
		 * a small hand-rolled heuristic rather than a real language-ID library. */
		sampleLines: string[] = []
	) {
		super(app);
		this.detectedLang = detectLanguage(sampleLines);
		if (this.detectedLang) {
			this.listLang = this.detectedLang;
			// Avoid a nonsensical "My list is in French / I already know French"
			// default when the detected language happens to match the other
			// dropdown's own hardcoded default.
			if (this.knownLang === this.detectedLang) {
				this.knownLang = this.detectedLang === "en" ? "fr" : "en";
			}
		}
	}

	onOpen(): void {
		this.render();
		void this.loadSubjects();
	}

	private async loadSubjects(): Promise<void> {
		const subjects = await this.client.subjects();
		if (subjects.length > 0) {
			this.subjectOptions = subjects;
			this.render();
		}
	}

	private render(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("pratiquer-modal");

		const header = contentEl.createDiv({ cls: "pratiquer-modal-header" });
		const icon = header.createDiv({ cls: "pratiquer-modal-header-icon" });
		setIcon(icon, "plus-circle");
		header.createEl("h2", { text: "Create a new flashcard set" });

		// .setValue(this.name) here (not just onChange) so a re-render
		// triggered by loadSubjects() resolving mid-typing doesn't visually
		// wipe out whatever the user's already entered.
		new Setting(contentEl).setName("Set name").addText((text) =>
			text
				.setPlaceholder("e.g. French Vocab")
				.setValue(this.name)
				.onChange((value) => {
					this.name = value;
				})
		);

		new Setting(contentEl)
			.setName("My list is in")
			.setDesc(
				this.detectedLang
					? "Auto-detected from your note -- change it if this guessed wrong."
					: "The language the words in this note are actually written in."
			)
			.addDropdown((dd) => {
				for (const lang of SUPPORTED_LANGUAGES) dd.addOption(lang.code, lang.label);
				dd.setValue(this.listLang).onChange((value) => (this.listLang = value));
			});

		new Setting(contentEl).setName("I already know").addDropdown((dd) => {
			for (const lang of SUPPORTED_LANGUAGES) dd.addOption(lang.code, lang.label);
			dd.setValue(this.knownLang).onChange((value) => (this.knownLang = value));
		});

		new Setting(contentEl)
			.setName("Subject")
			.setDesc("Tags this set the same way the web app's set settings would.")
			.addDropdown((dd) => {
				for (const opt of this.subjectOptions) dd.addOption(opt.value, opt.label);
				dd.setValue(this.subject).onChange((value) => (this.subject = value));
			});

		new Setting(contentEl).addButton((btn) =>
			btn
				.setButtonText("Create")
				.setCta()
				.onClick(() => {
					if (!this.name.trim()) return;
					this.close();
					this.onSubmit({
						name: this.name.trim(),
						listLang: this.listLang,
						knownLang: this.knownLang,
						subject: this.subject,
					});
				})
		);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
