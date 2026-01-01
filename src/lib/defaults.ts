import * as p from "@clack/prompts";
import type { ExecutionMode } from "../types/mode";
import { getConfig } from "./config";
import { setExecutionMode } from "../utils/ui";

/**
 * Prompt user to select execution mode at startup.
 * Returns the selected mode.
 */
export async function promptForExecutionMode(): Promise<ExecutionMode | null> {
	const action = await p.select({
		message: "How would you like to proceed?",
		options: [
			{
				value: "confirm-each",
				label: "Use defaults and approve each",
				hint: "AI generates content, you confirm with Enter",
			},
			{
				value: "auto-accept",
				label: "Use defaults and auto-accept",
				hint: "AI generates content, proceeds automatically",
			},
			{
				value: "interactive",
				label: "Don't use defaults",
				hint: "Full interactive mode with all options",
			},
		],
	});

	if (p.isCancel(action)) {
		return null;
	}

	return action as ExecutionMode;
}

/**
 * Initialize execution mode for the session.
 * Checks config for persisted preference, otherwise prompts.
 * Respects --interactive flag override.
 */
export async function initializeExecutionMode(options: {
	interactive?: boolean;
	yes?: boolean;
}): Promise<boolean> {
	// --interactive flag always forces interactive mode
	if (options.interactive) {
		setExecutionMode("interactive");
		return true;
	}

	// --yes flag implies auto-accept (backwards compatibility)
	if (options.yes) {
		setExecutionMode("auto-accept");
		return true;
	}

	const config = await getConfig();

	// Check for persisted preference in config file
	if (config.defaults?.skipModePrompt && config.defaults?.executionMode) {
		setExecutionMode(config.defaults.executionMode);
		return true;
	}

	// Prompt user
	const mode = await promptForExecutionMode();

	if (!mode) {
		return false; // User cancelled
	}

	setExecutionMode(mode);
	return true;
}
