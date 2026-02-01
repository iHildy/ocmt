import * as p from "@clack/prompts";
import { confirmWithMode } from "./confirm";

export type ActionLoopResult<T> = T | "skip" | null;

export interface ActionLoopConfig<T> {
	content: T;
	contentLabel: string;
	confirmContent?: string;
	displayContent: (content: T) => void;
	onEdit?: (current: T) => Promise<T | null>;
	onIntent?: (current: T) => Promise<T | null>;
	onRegenerate?: () => Promise<T>;
	trackEdit?: (generated: T, edited: T) => void | Promise<void>;
	primaryActionLabel: string;
	skipLabel?: string;
	intentLabel?: string;
	editLabel?: string;
	regenerateLabel?: string;
	yes?: boolean;
	skipInitialDisplay?: boolean;
}

export async function interactiveContentLoop<T>(
	config: ActionLoopConfig<T>,
): Promise<ActionLoopResult<T>> {
	const confirmContent =
		config.confirmContent ??
		(typeof config.content === "string" ? config.content : config.contentLabel);
	const shouldDisplay = !config.skipInitialDisplay;

	if (shouldDisplay) {
		config.displayContent(config.content);
	}

	if (config.yes) {
		return config.content;
	}

	const confirmResult = await confirmWithMode({
		content: confirmContent,
		contentLabel: config.contentLabel,
		skipDisplay: shouldDisplay,
	});

	if (confirmResult === "cancel") {
		return null;
	}

	if (confirmResult === "accept") {
		return config.content;
	}

	let current = config.content;
	let generated = config.content;
	let wasEdited = false;

	const intentLabel = config.intentLabel ?? "Change intent";
	const editLabel = config.editLabel ?? "Edit content";
	const regenerateLabel = config.regenerateLabel ?? "Regenerate content";

	while (true) {
		const options: Array<{ value: string; label: string }> = [
			{ value: "primary", label: config.primaryActionLabel },
		];

		if (config.onIntent) {
			options.push({ value: "intent", label: intentLabel });
		}
		if (config.onEdit) {
			options.push({ value: "edit", label: editLabel });
		}
		if (config.onRegenerate) {
			options.push({ value: "regenerate", label: regenerateLabel });
		}
		if (config.skipLabel) {
			options.push({ value: "skip", label: config.skipLabel });
		}

		options.push({ value: "cancel", label: "Cancel" });

		const action = await p.select({
			message: "What would you like to do?",
			options,
		});

		if (p.isCancel(action) || action === "cancel") {
			return null;
		}

		if (action === "skip") {
			return "skip";
		}

		if (action === "primary") {
			if (wasEdited && config.trackEdit) {
				await config.trackEdit(generated, current);
			}
			return current;
		}

		if (action === "intent" && config.onIntent) {
			const result = await config.onIntent(current);
			if (result !== null) {
				current = result;
				wasEdited = true;
				config.displayContent(current);
			}
			continue;
		}

		if (action === "edit" && config.onEdit) {
			const result = await config.onEdit(current);
			if (result !== null) {
				current = result;
				wasEdited = true;
				config.displayContent(current);
			}
			continue;
		}

		if (action === "regenerate" && config.onRegenerate) {
			current = await config.onRegenerate();
			generated = current;
			wasEdited = false;
			config.displayContent(current);
		}
	}
}
