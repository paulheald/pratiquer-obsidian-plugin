import { App, Modal, Notice, setIcon } from "obsidian";
import { DueCard, FlashcardSet, PratiquerClient, ReviewRating } from "./pratiquer-client";

/** Cards this plugin's quiz UI can actually render -- a plain modal has no
 * hotspot-region-occlusion or cloze-blank rendering, so a card needing
 * either would either look broken or leak the answer outright. Filtered
 * out of the queue before ReviewModal ever opens; those cards stay due and
 * reviewable normally in the web app. */
export function isReviewable(card: DueCard): boolean {
	if (card.is_header) return false;
	if (card.side_a.primary_type === "hotspot" || card.side_b.primary_type === "hotspot") return false;
	if (card.cloze_options && card.cloze_options.length > 0) return false;
	return true;
}

const GRADE_LABELS: Record<ReviewRating, string> = { 1: "Again", 2: "Hard", 3: "Good", 4: "Easy" };
const GRADE_CLASSES: Record<ReviewRating, string> = {
	1: "pratiquer-grade-again",
	2: "pratiquer-grade-hard",
	3: "pratiquer-grade-good",
	4: "pratiquer-grade-easy",
};

/**
 * On-demand study session (roadmap idea #3, 2026-07-20): a due card's front,
 * a reveal step, then the same FSRS 4-button grade scale the web app uses --
 * grading immediately loads the next due card, closing itself once the
 * queue's empty. Deliberately a Modal, not a generated note: Markdown has
 * no clean way to host "click to grade," and a session like this isn't
 * really note content at all. Nothing here touches the vault.
 *
 * Requires the backend's PAT-review-access gate (2026-07-20): grading (and
 * the due-card fetch that built this queue) only ever succeeds for a set
 * the caller owns and never for a STUDENT-role account -- see
 * pratiquer-client.ts's getDueCards/submitReview docstrings. A 403 here is
 * that gate, surfaced directly via the caught error's message.
 */
export class ReviewModal extends Modal {
	private index = 0;
	private revealed = false;
	private cardStartedAt = Date.now();
	private reviewedCount = 0;
	private grading = false;

	constructor(
		app: App,
		private targetSet: FlashcardSet,
		private queue: DueCard[],
		private client: PratiquerClient
	) {
		super(app);
	}

	onOpen(): void {
		if (this.queue.length === 0) {
			new Notice(`No cards due in "${this.targetSet.name}" right now.`);
			this.close();
			return;
		}
		this.render();
	}

	private currentCard(): DueCard {
		return this.queue[this.index];
	}

	private renderSide(parent: HTMLElement, side: { text: string; image_url: string | null; audio_url: string | null }): void {
		parent.createDiv({ text: side.text, cls: "pratiquer-review-text" });
		if (side.image_url) {
			parent.createEl("img", { attr: { src: side.image_url }, cls: "pratiquer-review-image" });
		}
		if (side.audio_url) {
			parent.createEl("audio", { attr: { src: side.audio_url, controls: "true" }, cls: "pratiquer-review-audio" });
		}
	}

	private render(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("pratiquer-modal");

		const header = contentEl.createDiv({ cls: "pratiquer-modal-header" });
		setIcon(header.createDiv({ cls: "pratiquer-modal-header-icon" }), "brain");
		header.createEl("h2", { text: `Review: ${this.targetSet.name}` });

		contentEl.createDiv({
			text: `Card ${this.index + 1} of ${this.queue.length}`,
			cls: "pratiquer-review-progress",
		});

		const card = this.currentCard();
		const front = contentEl.createDiv({ cls: "pratiquer-review-side" });
		this.renderSide(front, card.side_a);

		if (!this.revealed) {
			const revealBtn = contentEl.createEl("button", { cls: "pratiquer-review-reveal" });
			setIcon(revealBtn.createSpan(), "eye");
			revealBtn.createSpan({ text: "Show Answer" });
			revealBtn.addEventListener("click", () => {
				this.revealed = true;
				this.render();
			});
			return;
		}

		contentEl.createEl("hr");
		const back = contentEl.createDiv({ cls: "pratiquer-review-side" });
		this.renderSide(back, card.side_b);

		const gradeRow = contentEl.createDiv({ cls: "pratiquer-grade-row" });
		([1, 2, 3, 4] as ReviewRating[]).forEach((rating) => {
			const btn = gradeRow.createEl("button", {
				text: GRADE_LABELS[rating],
				cls: `pratiquer-grade-btn ${GRADE_CLASSES[rating]}`,
			});
			btn.disabled = this.grading;
			btn.addEventListener("click", () => this.grade(rating));
		});
	}

	private async grade(rating: ReviewRating): Promise<void> {
		if (this.grading) return;
		this.grading = true;
		const card = this.currentCard();
		const durationMs = Date.now() - this.cardStartedAt;
		try {
			await this.client.submitReview(card.id, rating, durationMs);
		} catch (e) {
			new Notice(`Failed to record that review: ${e instanceof Error ? e.message : e}`, 8000);
			this.grading = false;
			return;
		}

		this.grading = false;
		this.reviewedCount++;
		this.index++;
		this.revealed = false;
		this.cardStartedAt = Date.now();

		if (this.index >= this.queue.length) {
			new Notice(`Reviewed ${this.reviewedCount} card${this.reviewedCount === 1 ? "" : "s"} in "${this.targetSet.name}". All done!`);
			this.close();
			return;
		}
		this.render();
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
