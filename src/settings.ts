import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type PratiquerPlugin from "./main";
import { GenerationSupports } from "./pratiquer-client";

export type ServerMode = "production" | "local" | "custom";

// Same four languages as the main app's own `LANGUAGES` constant
// (frontend/src/app/services/language.service.ts) -- deliberately the short
// list, not the full ALL_LANGUAGES set, per the POC plan's Open Question 2.
export const SUPPORTED_LANGUAGES = [
	{ code: "en", label: "English" },
	{ code: "fr", label: "French" },
	{ code: "es", label: "Spanish" },
	{ code: "de", label: "German" },
];

// Fill in the real production origin before shipping past local testing.
export const PRODUCTION_URL = "https://app.pratiquer.co";
export const DEFAULT_LOCAL_URL = "https://localhost:8000";

export interface PratiquerSettings {
	serverMode: ServerMode;
	customUrl: string;
	token: string;
	/** Global fallback used when a note has no pratiquer-refinements
	 * frontmatter of its own yet -- see main.ts's resolveDefaultSupports(). */
	lastUsedSupports: GenerationSupports;
}

export const DEFAULT_SETTINGS: PratiquerSettings = {
	serverMode: "production",
	customUrl: "",
	token: "",
	lastUsedSupports: {
		spellcheck: true,
		translate: true,
		image: "none",
		audio: false,
	},
};

export function resolveBaseUrl(settings: PratiquerSettings): string {
	switch (settings.serverMode) {
		case "local":
			return DEFAULT_LOCAL_URL;
		case "custom":
			return settings.customUrl;
		case "production":
		default:
			return PRODUCTION_URL;
	}
}

export class PratiquerSettingTab extends PluginSettingTab {
	plugin: PratiquerPlugin;

	constructor(app: App, plugin: PratiquerPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl("h2", { text: "Send to Pratiquer" });

		new Setting(containerEl)
			.setName("Server")
			.setDesc(
				"Which Pratiquer backend the plugin talks to. Switch freely between your local dev server and production -- no rebuild needed."
			)
			.addDropdown((dd) =>
				dd
					.addOption("production", "Production")
					.addOption("local", `Local (${DEFAULT_LOCAL_URL})`)
					.addOption("custom", "Custom URL")
					.setValue(this.plugin.settings.serverMode)
					.onChange(async (value: ServerMode) => {
						this.plugin.settings.serverMode = value;
						await this.plugin.saveSettings();
						this.display();
					})
			);

		if (this.plugin.settings.serverMode === "custom") {
			new Setting(containerEl)
				.setName("Custom server URL")
				.setDesc("e.g. https://staging.pratiquer.co or https://192.168.1.50:8000")
				.addText((text) =>
					text
						.setPlaceholder("https://...")
						.setValue(this.plugin.settings.customUrl)
						.onChange(async (value) => {
							this.plugin.settings.customUrl = value.trim();
							await this.plugin.saveSettings();
						})
				);
		}

		new Setting(containerEl)
			.setName("API token")
			.setDesc(
				"Generate one from Pratiquer: Settings -> API Access -> Create Token. Stored locally in this vault's plugin data -- treat it like a password."
			)
			.addText((text) => {
				text.inputEl.type = "password";
				text
					.setPlaceholder("pratiquer_pat_...")
					.setValue(this.plugin.settings.token)
					.onChange(async (value) => {
						this.plugin.settings.token = value.trim();
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("Test connection")
			.setDesc("Verifies the server + token combination above by listing your flashcard sets.")
			.addButton((btn) =>
				btn.setButtonText("Test connection").onClick(async () => {
					btn.setButtonText("Testing...").setDisabled(true);
					try {
						const client = this.plugin.getClient();
						const sets = await client.listSets();
						new Notice(`Connected -- found ${sets.length} flashcard set(s).`);
					} catch (e) {
						new Notice(`Connection failed: ${e instanceof Error ? e.message : e}`, 8000);
					} finally {
						btn.setButtonText("Test connection").setDisabled(false);
					}
				})
			);
	}
}
