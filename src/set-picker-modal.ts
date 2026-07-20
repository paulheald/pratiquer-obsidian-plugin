import { App, FuzzySuggestModal, FuzzyMatch } from "obsidian";
import { FlashcardSet } from "./pratiquer-client";

const CREATE_NEW_SENTINEL = "__create_new_set__";

type PickerItem = FlashcardSet | { id: typeof CREATE_NEW_SENTINEL; name: string };

/**
 * Destination picker for "Send to Pratiquer" (POC plan Phase 4). Uses
 * Obsidian's own FuzzySuggestModal -- the same component behind the core
 * Quick Switcher -- so this needs no custom search/filter logic of its own.
 *
 * recentSets (added alongside GET /account/recent-obsidian-sets) float to
 * the top of the list ahead of the rest, so merging a fresh word list into
 * a set you've already been sending into repeatedly doesn't require
 * scrolling or typing to search for it -- the frontmatter-based "sticky
 * set" dedup in main.ts already handles the *same note* case; this handles
 * picking a *different* note into the *same* set.
 */
export class SetPickerModal extends FuzzySuggestModal<PickerItem> {
	private recentIds: Set<number>;

	constructor(
		app: App,
		private sets: FlashcardSet[],
		private recentSets: FlashcardSet[],
		private onChoose: (result: { createNew: true } | { createNew: false; set: FlashcardSet }) => void,
		/** False for pickers where "create new" makes no sense -- e.g.
		 * reviewing due cards, since a brand-new set has nothing due yet. */
		private allowCreateNew: boolean = true
	) {
		super(app);
		this.setPlaceholder(
			allowCreateNew ? "Choose a flashcard set, or create a new one..." : "Choose a flashcard set..."
		);
		this.recentIds = new Set(recentSets.map((s) => s.id));
	}

	getItems(): PickerItem[] {
		const rest = this.sets.filter((s) => !this.recentIds.has(s.id));
		const items: PickerItem[] = [...this.recentSets, ...rest];
		if (this.allowCreateNew) items.unshift({ id: CREATE_NEW_SENTINEL, name: "+ Create new set" });
		return items;
	}

	getItemText(item: PickerItem): string {
		return item.name;
	}

	renderSuggestion(match: FuzzyMatch<PickerItem>, el: HTMLElement): void {
		super.renderSuggestion(match, el);
		if (match.item.id === CREATE_NEW_SENTINEL) {
			el.addClass("pratiquer-create-new-item");
			return;
		}
		if (this.recentIds.has(match.item.id as number)) {
			el.createSpan({ text: " recently used", cls: "pratiquer-recent-tag" });
		}
	}

	onChooseItem(item: PickerItem): void {
		if (item.id === CREATE_NEW_SENTINEL) {
			this.onChoose({ createNew: true });
		} else {
			this.onChoose({ createNew: false, set: item as FlashcardSet });
		}
	}
}
