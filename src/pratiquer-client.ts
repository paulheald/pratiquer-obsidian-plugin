import { requestUrl } from "obsidian";

/**
 * All HTTP calls to the Pratiquer backend live in this one file, kept
 * deliberately isolated from Obsidian-specific UI code (commands, modals,
 * settings tab). This is the one piece of the plugin that's a direct,
 * literal port target for a future KOReader (or other platform) client --
 * see docs/development/OBSIDIAN_PLUGIN_POC_PLAN.md §6 in the main
 * flashy_cards repo. Every endpoint/shape here is a straight mirror of the
 * backend, not a plugin-side invention.
 *
 * Uses Obsidian's requestUrl (not fetch) deliberately: fetch() from
 * app://obsidian.md is CORS-blocked, and requestUrl bypasses that on both
 * desktop and mobile Obsidian. Never add a CORS allowance for this plugin's
 * origin on the backend -- it isn't needed and won't fix anything, since
 * requestUrl doesn't send an Origin header for the backend to allow.
 */

export interface FlashcardSet {
	id: number;
	name: string;
	is_folder: boolean;
	source_lang: string;
	target_lang: string | null;
}

export interface GenerationSupports {
	translate?: boolean;
	image?: "none" | "ai" | "pixabay";
	image_target?: "a" | "b" | "both";
	audio?: boolean;
	audio_target?: "a" | "b" | "both";
	audio_voice_a?: string;
	audio_provider_a?: string;
	audio_voice_b?: string;
	audio_provider_b?: string;
}

export interface BatchItem {
	side_a_text?: string;
	side_b_text?: string;
}

export interface CardGenerationJob {
	id: number;
	batch_id: string;
	set_id: number;
	status: string;
	error_message: string | null;
	flashcard_id: number | null;
}

export interface TtsVoice {
	id: string;
	label: string;
}

export class PratiquerApiError extends Error {
	constructor(public status: number, message: string) {
		super(message);
	}
}

export class PratiquerClient {
	constructor(private baseUrl: string, private token: string) {}

	private async request<T>(
		method: string,
		path: string,
		body?: unknown
	): Promise<T> {
		const url = `${this.baseUrl.replace(/\/$/, "")}${path}`;
		let res;
		try {
			res = await requestUrl({
				url,
				method,
				headers: {
					Authorization: `Bearer ${this.token}`,
					"Content-Type": "application/json",
				},
				body: body !== undefined ? JSON.stringify(body) : undefined,
				throw: false,
			});
		} catch (e) {
			// requestUrl throws on network-level failure (DNS, connection refused,
			// TLS trust failure -- the last of which is the expected failure mode
			// when "Local" points at a dev backend whose mkcert cert isn't trusted
			// on this device) rather than returning a response object.
			throw new PratiquerApiError(0, `Network error contacting ${url}: ${e}`);
		}
		if (res.status >= 400) {
			let detail = res.text;
			try {
				detail = res.json?.detail ?? detail;
			} catch {
				/* body wasn't JSON -- fall back to raw text above */
			}
			throw new PratiquerApiError(res.status, detail || `HTTP ${res.status}`);
		}
		return res.json as T;
	}

	/** Excludes folders -- only real flashcard sets are valid push/pull
	 * destinations. Called without `page`, so the backend returns the plain
	 * array form of GET /sets rather than the paginated {items,total,...}
	 * shape (see flashcards.py's list_groups). */
	async listSets(): Promise<FlashcardSet[]> {
		const sets = await this.request<FlashcardSet[]>("GET", "/sets");
		return sets.filter((s) => !s.is_folder);
	}

	async createSet(
		name: string,
		sourceLang: string,
		targetLang: string
	): Promise<FlashcardSet> {
		return this.request<FlashcardSet>("POST", "/sets", {
			name,
			source_lang: sourceLang,
			target_lang: targetLang,
		});
	}

	async submitBatch(
		setId: number,
		items: BatchItem[],
		supports: GenerationSupports
	): Promise<{ batch_id: string; jobs: CardGenerationJob[] }> {
		return this.request("POST", `/sets/${setId}/flashcards/batch-jobs`, {
			items,
			supports,
			source: "paste",
		});
	}

	async pollBatch(setId: number, batchId: string): Promise<CardGenerationJob[]> {
		const res = await this.request<{ jobs: CardGenerationJob[] }>(
			"GET",
			`/sets/${setId}/flashcards/batch-jobs`
		);
		return res.jobs.filter((j) => j.batch_id === batchId);
	}

	async listVoices(lang: string): Promise<TtsVoice[]> {
		const res = await this.request<{ voices: TtsVoice[] }>(
			"GET",
			`/flashcards/audio/voices?lang=${encodeURIComponent(lang)}`
		);
		return res.voices;
	}
}
