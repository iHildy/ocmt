import * as p from "@clack/prompts";
import color from "picocolors";
import { confirmAction, confirmWithMode } from "../utils/confirm";
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
import { getConfig } from "./config";
import {
	getAiEditedOutputsContext,
	recordAiEditedOutput,
	recordAiEditedOutputSession,
} from "./ai-edits";
import { generateBranchName } from "./opencode";
import { createSpinner } from "../utils/ui";

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
): Promise<string | null> {
	const s = createSpinner();
	s.start("Generating branch name");

	const context = await getAiEditedOutputsContext("branch");

	let branchName = await generateBranchName({ diff, context });
	s.stop("Branch name generated");

	branchName = normalizeBranchName(branchName);
	let originalBranchName = branchName;
	let wasEdited = false;

	if (yes) {
		p.log.step(`Proposed branch name:\n${color.white(`  "${branchName}"`)}`);
		return branchName;
	}

	// Check mode-aware confirmation first
	const confirmResult = await confirmWithMode({
		content: branchName,
		contentLabel: "Proposed branch name",
	});

	if (confirmResult === "cancel") {
		return null;
	}

	if (confirmResult === "accept") {
		return branchName;
	}

	// Interactive mode - full action loop
	while (true) {
		const action = await p.select({
			message: "What would you like to do?",
			options: [
				{ value: "create", label: "Create branch with this name" },
				{ value: "intent", label: "Change intent" },
				{ value: "edit", label: "Edit name" },
				{ value: "regenerate", label: "Regenerate name" },
				{ value: "cancel", label: "Cancel" },
			],
		});

		if (p.isCancel(action) || action === "cancel") {
			return null;
		}

		if (action === "create") {
			if (wasEdited && branchName.trim() !== originalBranchName.trim()) {
				await recordAiEditedOutput({
					kind: "branch-name",
					generated: originalBranchName,
					edited: branchName,
				});
			}
			return branchName;
		}

		if (action === "intent") {
			const currentIntent = detectBranchIntent(branchName);
			const newIntent = await promptForIntent(currentIntent);

			if (p.isCancel(newIntent)) {
				continue;
			}

			branchName = replaceBranchIntent(branchName, newIntent as string);
			branchName = normalizeBranchName(branchName);
			wasEdited = true;
			recordAiEditedOutputSession({
				kind: "branch-name",
				generated: originalBranchName,
				edited: branchName,
			});
			p.log.step(`Proposed branch name:\n${color.white(`  "${branchName}"`)}`);
			continue;
		}

		if (action === "edit") {
			const editedName = await p.text({
				message: "Enter branch name:",
				initialValue: branchName,
				validate: (value) => {
					if (!value.trim()) return "Branch name cannot be empty";
					if (/\s/.test(value)) return "Branch name cannot contain spaces";
				},
			});

			if (p.isCancel(editedName)) {
				continue;
			}

			branchName = normalizeBranchName(editedName);
			wasEdited = true;
			recordAiEditedOutputSession({
				kind: "branch-name",
				generated: originalBranchName,
				edited: branchName,
			});
			p.log.step(`Proposed branch name:\n${color.white(`  "${branchName}"`)}`);
			continue;
		}

		if (action === "regenerate") {
			const regenSpinner = createSpinner();
			regenSpinner.start("Regenerating branch name");

			branchName = await generateBranchName({ diff, context });
			regenSpinner.stop("Branch name regenerated");

			branchName = normalizeBranchName(branchName);
			originalBranchName = branchName;
			wasEdited = false;
			p.log.step(`Proposed branch name:\n${color.white(`  "${branchName}"`)}`);
			continue;
		}
	}
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
		const message = isDefaultBranch
			? `You're on default branch "${currentBranch}". Create a new branch for this commit?`
			: "Create a new branch for this commit?";
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
	let branchName: string | null = null;
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
