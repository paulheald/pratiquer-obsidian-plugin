import { App, FuzzySuggestModal } from "obsidian";
import { FlashcardSet } from "./pratiquer-client";

const CREATE_NEW_SENTINEL = "__create_new_set__";

type PickerItem = FlashcardSet | { id: typeof CREATE_NEW_SENTINEL; name: string };

/**
 * Destination picker for "Send to Pratiquer" (POC plan Phase 4). Uses
 * Obsidian's own FuzzySuggestModal -- the same component behind the core
 * Quick Switcher -- so this needs no custom search/filter logic of its own.
 */
export class SetPickerModal extends FuzzySuggestModal<PickerItem> {
	constructor(
		app: App,
		private sets: FlashcardSet[],
		private onChoose: (result: { createNew: true } | { createNew: false; set: FlashcardSet }) => void
	) {
		super(app);
		this.setPlaceholder("Choose a flashcard set, or create a new one...");
	}

	getItems(): PickerItem[] {
		return [{ id: CREATE_NEW_SENTINEL, name: "+ Create new set" }, ...this.sets];
	}

	getItemText(item: PickerItem): string {
		return item.name;
	}

	onChooseItem(item: PickerItem): void {
		if (item.id === CREATE_NEW_SENTINEL) {
			this.onChoose({ createNew: true });
		} else {
			this.onChoose({ createNew: false, set: item as FlashcardSet });
		}
	}
}
