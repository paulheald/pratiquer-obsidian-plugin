import { SUPPORTED_LANGUAGES } from "./settings";

/** Set languages may be short ("fr", from this plugin) or full locale codes
 * ("fr-fr", from the web app) -- normalize before the SUPPORTED_LANGUAGES
 * lookup, same trick as the web app's shortLangCode(). */
export function langLabel(code: string | null | undefined): string {
	if (!code) return "?";
	const short = code.split("-")[0];
	return SUPPORTED_LANGUAGES.find((l) => l.code === short)?.label ?? code;
}
