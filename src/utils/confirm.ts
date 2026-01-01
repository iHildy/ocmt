import * as p from "@clack/prompts";
import color from "picocolors";
import { isAutoAcceptMode, isConfirmEachMode } from "./ui";

export interface ConfirmWithModeOptions {
	/** Content to display before confirmation */
	content: string;
	/** Label for the content (e.g., "Commit message", "Branch name") */
	contentLabel: string;
	/** Delay in ms for auto-accept mode to show content */
	autoAcceptDelay?: number;
	/** Skip content display (if already displayed by caller) */
	skipDisplay?: boolean;
}

export type ConfirmWithModeResult = "accept" | "interactive" | "cancel";

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Display AI-generated content and get user confirmation.
 * Behavior depends on execution mode:
 * - auto-accept: Shows content briefly, returns "accept"
 * - confirm-each: Shows content, waits for Enter, returns "accept"
 * - interactive: Returns "interactive" to signal full action loop needed
 */
export async function confirmWithMode(
	options: ConfirmWithModeOptions,
): Promise<ConfirmWithModeResult> {
	const { content, contentLabel, autoAcceptDelay = 500, skipDisplay } = options;

	// Display the content (unless caller already displayed it)
	if (!skipDisplay) {
		p.log.step(`${contentLabel}:\n${color.white(`  "${content}"`)}`);
	}

	if (isAutoAcceptMode()) {
		// Brief pause to show content, then proceed
		await sleep(autoAcceptDelay);
		return "accept";
	}

	if (isConfirmEachMode()) {
		// Simple confirmation - press Enter to continue
		const confirmed = await p.confirm({
			message: `Accept this ${contentLabel.toLowerCase()}?`,
			initialValue: true,
		});

		if (p.isCancel(confirmed) || !confirmed) {
			return "cancel";
		}

		return "accept";
	}

	// Interactive mode - return control to caller for full action loop
	return "interactive";
}

/**
 * Wrapper for simple yes/no confirmations that respects mode.
 * In auto-accept and confirm-each modes, returns the default value.
 */
export async function confirmAction(
	message: string,
	defaultValue = true,
): Promise<boolean> {
	if (isAutoAcceptMode() || isConfirmEachMode()) {
		return defaultValue;
	}

	const result = await p.confirm({
		message,
		initialValue: defaultValue,
	});

	if (p.isCancel(result)) {
		return false;
	}

	return result;
}
