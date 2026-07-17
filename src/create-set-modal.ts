import { App, Modal, Setting } from "obsidian";
import { SUPPORTED_LANGUAGES } from "./settings";

export interface NewSetInput {
	name: string;
	sourceLang: string;
	targetLang: string;
}

/** Phase 6: create-new-set flow. Deliberately asks for both languages
 * explicitly rather than silently defaulting source_lang server-side
 * (FlashcardSetCreate's default is "en-us") -- a silent default would
 * produce a confusingly-labeled set the user didn't actually choose. */
export class CreateSetModal extends Modal {
	private name = "";
	private sourceLang = "en";
	private targetLang = "fr";

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

		new Setting(contentEl).setName("I know this language").addDropdown((dd) => {
			for (const lang of SUPPORTED_LANGUAGES) dd.addOption(lang.code, lang.label);
			dd.setValue(this.sourceLang).onChange((value) => (this.sourceLang = value));
		});

		new Setting(contentEl).setName("Studying this language").addDropdown((dd) => {
			for (const lang of SUPPORTED_LANGUAGES) dd.addOption(lang.code, lang.label);
			dd.setValue(this.targetLang).onChange((value) => (this.targetLang = value));
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
						sourceLang: this.sourceLang,
						targetLang: this.targetLang,
					});
				})
		);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
