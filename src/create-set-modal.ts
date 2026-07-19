import { App, Modal, Setting } from "obsidian";
import { SUPPORTED_LANGUAGES } from "./settings";

export interface NewSetInput {
	name: string;
	listLang: string;
	knownLang: string;
}

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

	constructor(app: App, private onSubmit: (input: NewSetInput) => void) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl("h2", { text: "Create a new flashcard set" });

		new Setting(contentEl).setName("Set name").addText((text) =>
			text.setPlaceholder("e.g. French Vocab").onChange((value) => {
				this.name = value;
			})
		);

		new Setting(contentEl)
			.setName("My list is in")
			.setDesc("The language the words in this note are actually written in.")
			.addDropdown((dd) => {
				for (const lang of SUPPORTED_LANGUAGES) dd.addOption(lang.code, lang.label);
				dd.setValue(this.listLang).onChange((value) => (this.listLang = value));
			});

		new Setting(contentEl).setName("I already know").addDropdown((dd) => {
			for (const lang of SUPPORTED_LANGUAGES) dd.addOption(lang.code, lang.label);
			dd.setValue(this.knownLang).onChange((value) => (this.knownLang = value));
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
					});
				})
		);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
