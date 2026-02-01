import * as p from "@clack/prompts";
import color from "picocolors";
import { confirmAction } from "../utils/confirm";
import {
	branchExists,
	createBranch,
	getCurrentBranch,
	getDefaultBranch,
} from "../utils/git";
import {
	detectBranchIntent,
	promptForIntent,
	replaceBranchIntent,
} from "../utils/intent";
import { interactiveContentLoop } from "../utils/interactive-content";
import { createSpinner } from "../utils/ui";
import {
	getAiEditedOutputsContext,
	recordAiEditedOutput,
	recordAiEditedOutputSession,
} from "./ai-edits";
import { getConfig } from "./config";
import { generateBranchName } from "./opencode";

export type BranchFlowResult = "continue" | "abort";

export interface BranchFlowOptions {
	diff: string;
	yes?: boolean;
	branchName?: string;
	skipBranch?: boolean;
}

function normalizeBranchName(name: string): string {
	let normalized = name.trim().replace(/^["']|["']$/g, "");
	normalized = normalized.replace(/\s+/g, "-");
	normalized = normalized.replace(/[^a-zA-Z0-9._/-]+/g, "-");
	normalized = normalized.replace(/-+/g, "-");
	normalized = normalized.replace(/^[-/]+|[-/]+$/g, "");
	return normalized.toLowerCase();
}

async function resolveBranchName(
	diff: string,
	yes?: boolean,
): Promise<string | null | "skip"> {
	const s = createSpinner();
	s.start("Generating branch name");

	const context = await getAiEditedOutputsContext("branch");

	let branchName = await generateBranchName({ diff, context });
	s.stop("Branch name generated");

	branchName = normalizeBranchName(branchName);
	let originalBranchName = branchName;

	const recordBranchEdit = (edited: string) => {
		recordAiEditedOutputSession({
			kind: "branch-name",
			generated: originalBranchName,
			edited,
		});
	};

	const result = await interactiveContentLoop({
		content: branchName,
		contentLabel: "Proposed branch name",
		displayContent: (name) => {
			p.log.step(`Proposed branch name:\n${color.white(`  "${name}"`)}`);
		},
		onEdit: async (current) => {
			const editedName = await p.text({
				message: "Enter branch name:",
				initialValue: current,
				validate: (value) => {
					if (!value.trim()) return "Branch name cannot be empty";
					if (/\s/.test(value)) return "Branch name cannot contain spaces";
				},
			});

			if (p.isCancel(editedName)) {
				return null;
			}

			const normalized = normalizeBranchName(editedName);
			recordBranchEdit(normalized);
			return normalized;
		},
		onIntent: async (current) => {
			const currentIntent = detectBranchIntent(current);
			const newIntent = await promptForIntent(currentIntent);

			if (p.isCancel(newIntent)) {
				return null;
			}

			const updated = normalizeBranchName(
				replaceBranchIntent(current, newIntent as string),
			);
			recordBranchEdit(updated);
			return updated;
		},
		onRegenerate: async () => {
			const regenSpinner = createSpinner();
			regenSpinner.start("Regenerating branch name");

			const regenerated = await generateBranchName({ diff, context });
			regenSpinner.stop("Branch name regenerated");

			const normalized = normalizeBranchName(regenerated);
			originalBranchName = normalized;
			return normalized;
		},
		trackEdit: async (generated, edited) => {
			if (edited.trim() !== generated.trim()) {
				await recordAiEditedOutput({
					kind: "branch-name",
					generated,
					edited,
				});
			}
		},
		primaryActionLabel: "Create branch with this name",
		skipLabel: "Skip new branch",
		editLabel: "Edit name",
		regenerateLabel: "Regenerate name",
		yes,
	});

	return result;
}

async function ensureUniqueBranchName(
	name: string,
	yes?: boolean,
): Promise<string | null> {
	let branchName = name;

	while (await branchExists(branchName)) {
		if (yes) {
			p.cancel(`Branch "${branchName}" already exists`);
			return null;
		}

		p.log.warn(`Branch "${branchName}" already exists`);
		const editedName = await p.text({
			message: "Enter a different branch name:",
			initialValue: branchName,
			validate: (value) => {
				if (!value.trim()) return "Branch name cannot be empty";
				if (/\s/.test(value)) return "Branch name cannot contain spaces";
			},
		});

		if (p.isCancel(editedName)) {
			return null;
		}

		branchName = normalizeBranchName(editedName);
	}

	return branchName;
}

export async function maybeCreateBranchForCommit(
	options: BranchFlowOptions,
): Promise<BranchFlowResult> {
	const { diff, yes, branchName: providedBranchName, skipBranch } = options;

	// Skip branch creation if --skip-branch is set
	if (skipBranch) {
		return "continue";
	}

	const config = await getConfig();

	const currentBranch = await getCurrentBranch();
	if (!currentBranch) {
		return "continue";
	}

	const defaultBranch = await getDefaultBranch();
	const isDefaultBranch = defaultBranch && currentBranch === defaultBranch;

	const forceOnDefault = !!config.commit?.forceNewBranchOnDefault;
	const autoOnDefault = !!config.commit?.autoCreateBranchOnDefault;
	const autoOnNonDefault = !!config.commit?.autoCreateBranchOnNonDefault;

	let shouldCreate = false;

	// If branch name is provided via CLI, always create
	if (providedBranchName) {
		shouldCreate = true;
	} else if (isDefaultBranch && forceOnDefault) {
		shouldCreate = true;
	} else if (yes) {
		shouldCreate = isDefaultBranch ? autoOnDefault : autoOnNonDefault;
	} else {
		const branchInfo =
			color.white(`"${currentBranch}"`) +
			(isDefaultBranch ? ` ${color.dim("(default)")}` : "");
		const message = `Create a new branch for this commit?\n${color.white("  Current branch: ")}${branchInfo}`;
		const defaultValue = isDefaultBranch ? autoOnDefault : autoOnNonDefault;
		const confirmResult = await confirmAction(message, defaultValue);
		if (confirmResult === null) {
			return "abort";
		}
		shouldCreate = confirmResult;
	}

	if (!shouldCreate) {
		return "continue";
	}

	// Use provided branch name or generate one
	let branchName: string | null | "skip" = null;
	if (providedBranchName) {
		branchName = normalizeBranchName(providedBranchName);
	} else {
		try {
			branchName = await resolveBranchName(diff, yes);
		} catch (error) {
			p.cancel(error instanceof Error ? error.message : String(error));
			return "abort";
		}
	}
	if (!branchName) return "abort";
	if (branchName === "skip") {
		return "continue";
	}

	branchName = await ensureUniqueBranchName(branchName, yes);
	if (!branchName) return "abort";

	const s = createSpinner();
	s.start(`Creating branch "${branchName}"`);

	try {
		await createBranch(branchName);
		s.stop(`Switched to "${branchName}"`);
	} catch (error) {
		s.stop("Failed to create branch");
		p.cancel(error instanceof Error ? error.message : String(error));
		return "abort";
	}

	return "continue";
}
