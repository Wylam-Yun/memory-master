import type { Core } from "../core/memaster.ts";
import type { MemasterConfig } from "../types/index.ts";
import {
	type EditorAvailabilityChecker,
	type PromptRunner,
	runAdvancedConfigWizard,
} from "./advanced-config-wizard.ts";

interface ConfigureAdvancedOptions {
	promptImpl?: PromptRunner;
	isEditorAvailable?: EditorAvailabilityChecker;
	cancelMessage?: string;
}

export async function configureAdvancedSettings(
	core: Core,
	{ promptImpl, isEditorAvailable, cancelMessage = "Aborting configuration." }: ConfigureAdvancedOptions = {},
): Promise<{ mergedConfig: MemasterConfig; installClaudeAgent: boolean; installShellCompletions: boolean }> {
	const existingConfig = await core.filesystem.loadConfig();
	if (!existingConfig) {
		throw new Error("No memaster project found. Initialize one first with: memaster init");
	}

	const wizardResult = await runAdvancedConfigWizard({
		existingConfig,
		cancelMessage,
		includeClaudePrompt: true,
		promptImpl,
		isEditorAvailable,
	});

	const mergedConfig: MemasterConfig = { ...existingConfig, ...wizardResult.config };
	await core.filesystem.saveConfig(mergedConfig);

	return {
		mergedConfig,
		installClaudeAgent: wizardResult.installClaudeAgent,
		installShellCompletions: wizardResult.installShellCompletions,
	};
}
