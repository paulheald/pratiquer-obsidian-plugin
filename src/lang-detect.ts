import { SUPPORTED_LANGUAGES } from "./settings";

/** Lightweight, dependency-free language guess across just the plugin's 4
 * supported languages (en/fr/es/de) -- not a general-purpose detector, and
 * deliberately not one (a real language-ID library like franc would pull in
 * a data table + wasm-scale bundle weight for a 4-way choice this small).
 * Combines two signals: language-exclusive diacritics (weighted heavily --
 * a single "ß" or "ñ" is close to certain) and common short stopwords
 * (weighted lightly -- only fires on full sentences, not bare word lists,
 * since "maison"/"casa"/"chien" carry no stopwords of their own). Returns
 * null when no signal clears the bar, so the caller can just keep its
 * existing default instead of confidently guessing wrong. */

const DIACRITIC_WEIGHTS: Record<string, Record<string, number>> = {
	fr: { à: 2, â: 2, ç: 3, é: 2, è: 2, ê: 2, ë: 2, î: 2, ï: 2, ô: 2, ù: 2, û: 2, œ: 4, æ: 3 },
	es: { ñ: 4, á: 2, í: 2, ó: 2, ú: 2, "¿": 4, "¡": 4 },
	de: { ä: 3, ö: 3, ü: 2, ß: 4 },
};

const STOPWORDS: Record<string, Set<string>> = {
	en: new Set(["the", "and", "is", "are", "was", "were", "with", "for", "that", "this", "you", "your", "have", "has", "of", "to", "in", "on", "at", "it", "be", "we", "they", "not", "but", "from"]),
	fr: new Set(["le", "la", "les", "un", "une", "des", "et", "est", "être", "avec", "pour", "dans", "que", "qui", "ce", "cette", "il", "elle", "nous", "vous", "ils", "elles", "ne", "pas", "du", "au", "aux", "sur", "mais"]),
	es: new Set(["el", "la", "los", "las", "un", "una", "y", "es", "con", "para", "en", "que", "quien", "este", "esta", "ella", "nosotros", "ellos", "no", "pero", "del", "al", "se", "más", "muy"]),
	de: new Set(["der", "die", "das", "und", "ist", "mit", "für", "in", "dass", "wer", "dieser", "diese", "wir", "ihr", "sie", "nicht", "ein", "eine", "von", "zu", "auf", "aber", "sehr", "mehr"]),
};

const SUPPORTED_CODES = new Set(SUPPORTED_LANGUAGES.map((l) => l.code));

/** `lines` should be the note's own content, unmodified -- capped by the
 * caller if very large, though a typical vocab-list note is tiny anyway. */
export function detectLanguage(lines: string[]): string | null {
	const text = lines.join(" ").toLowerCase();
	const words = text.split(/[^\p{L}\p{M}]+/u).filter(Boolean);

	const scores: Record<string, number> = { en: 0, fr: 0, es: 0, de: 0 };

	for (const [lang, weights] of Object.entries(DIACRITIC_WEIGHTS)) {
		for (const [ch, weight] of Object.entries(weights)) {
			for (const _ of text.matchAll(new RegExp(ch, "gu"))) {
				scores[lang] += weight;
			}
		}
	}

	for (const word of words) {
		for (const [lang, set] of Object.entries(STOPWORDS)) {
			if (set.has(word)) scores[lang] += 1;
		}
	}

	let best: string | null = null;
	let bestScore = 0;
	let tied = false;
	for (const [lang, score] of Object.entries(scores)) {
		if (!SUPPORTED_CODES.has(lang)) continue;
		if (score > bestScore) {
			best = lang;
			bestScore = score;
			tied = false;
		} else if (score === bestScore && score > 0) {
			tied = true;
		}
	}

	if (bestScore === 0 || tied) return null;
	return best;
}
