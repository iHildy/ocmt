import * as p from "@clack/prompts";
import color from "picocolors";
import {
	branchExists,
	createBranch,
	getCurrentBranch,
	getDefaultBranch,
} from "../utils/git";
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
): Promise<string | null> {
	const s = p.spinner();
	s.start("Generating branch name");

	let branchName = await generateBranchName({ diff });
	s.stop("Branch name generated");

	branchName = normalizeBranchName(branchName);

	if (yes) {
		return branchName;
	}

	p.log.step(`Proposed branch name:\n${color.white(`  "${branchName}"`)}`);

	const action = await p.select({
		message: "What would you like to do?",
		options: [
			{ value: "create", label: "Create branch with this name" },
			{ value: "edit", label: "Edit name" },
			{ value: "regenerate", label: "Regenerate name" },
			{ value: "cancel", label: "Cancel" },
		],
	});

	if (p.isCancel(action) || action === "cancel") {
		return null;
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
			return null;
		}

		branchName = normalizeBranchName(editedName);
		return branchName;
	}

	if (action === "regenerate") {
		const regenSpinner = p.spinner();
		regenSpinner.start("Regenerating branch name");

		branchName = await generateBranchName({ diff });
		regenSpinner.stop("Branch name regenerated");

		branchName = normalizeBranchName(branchName);

		p.log.step(`New branch name:\n${color.white(`  "${branchName}"`)}`);

		const confirmNew = await p.confirm({
			message: "Use this name?",
			initialValue: true,
		});

		if (p.isCancel(confirmNew) || !confirmNew) {
			return null;
		}
	}

	return branchName;
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
		const confirm = await p.confirm({
			message,
			initialValue: isDefaultBranch ? autoOnDefault : autoOnNonDefault,
		});

		if (p.isCancel(confirm)) {
			return "abort";
		}

		shouldCreate = !!confirm;
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

	const s = p.spinner();
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
