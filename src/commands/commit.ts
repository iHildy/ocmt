import * as p from "@clack/prompts";
import color from "picocolors";
import { maybeCreateBranchForCommit } from "../lib/branch";
import {
	getAndValidateStagedDiff,
	maybeDeslopStagedChanges,
} from "../lib/deslop";
import { cleanup, generateCommitMessage } from "../lib/opencode";
import { maybeCreatePRAfterCommit } from "../lib/pr";
import {
	commit,
	type GitStatus,
	getStatus,
	isGitRepo,
	stageAll,
} from "../utils/git";
import { createSpinner } from "../utils/ui";

export interface CommitOptions {
	message?: string;
	all?: boolean;
	yes?: boolean;
	deslop?: string;
	model?: string;
	accept?: boolean;
	branch?: string;
	skipBranch?: boolean;
}

export async function commitCommand(options: CommitOptions): Promise<void> {
	p.intro(color.bgCyan(color.black(" oc ")));

	// Check if we're in a git repo
	if (!(await isGitRepo())) {
		p.cancel("Not a git repository");
		cleanup();
		process.exit(1);
	}

	// Get current status
	let status = await getStatus();

	// If --all flag, stage everything first
	if (options.all && hasChanges(status)) {
		const s = createSpinner();
		s.start("Staging all changes");
		await stageAll();
		s.stop("All changes staged");
		status = await getStatus();
	}

	// Check for staged changes
	if (status.staged.length === 0) {
		// No staged changes - check if there are unstaged changes
		if (status.unstaged.length === 0 && status.untracked.length === 0) {
			p.outro(color.yellow("Nothing to commit, working tree clean"));
			cleanup();
			process.exit(0);
		}

		// Show unstaged/untracked files
		p.log.warn("No staged changes found");
		const unstagedFiles = [...status.unstaged, ...status.untracked]
			.map((file) => `  ${color.dim(file)}`)
			.join("\n");
		p.log.info(`Unstaged/Untracked files:\n${unstagedFiles}`);

		if (!options.yes) {
			const shouldStage = await p.confirm({
				message: "Stage all changes?",
				initialValue: true,
			});

			if (p.isCancel(shouldStage) || !shouldStage) {
				p.cancel("Aborted. Stage changes with `git add` first.");
				cleanup();
				process.exit(0);
			}
		}

		const s = createSpinner();
		s.start("Staging all changes");
		await stageAll();
		s.stop("All changes staged");
		status = await getStatus();
	}

	// Display staged files
	const stagedFiles = status.staged
		.map((file) => `  ${color.green("+")} ${file}`)
		.join("\n");
	p.log.success(`Staged changes:\n${stagedFiles}`);

	// Get the diff
	let diff = await getAndValidateStagedDiff();
	if (!diff) {
		cleanup();
		process.exit(0);
	}

	const deslopResult = await maybeDeslopStagedChanges({
		stagedDiff: diff,
		yes: options.yes,
		deslopOverride: options.deslop,
	});

	if (deslopResult === "abort") {
		cleanup();
		process.exit(0);
	}

	if (deslopResult === "updated") {
		diff = await getAndValidateStagedDiff();
		if (!diff) {
			cleanup();
			process.exit(0);
		}
	}

	// Show diff summary
	const diffLines = diff.split("\n").length;
	p.log.info(`Diff: ${diffLines} lines`);

	const branchFlow = await maybeCreateBranchForCommit({
		diff,
		yes: options.yes,
		branchName: options.branch,
		skipBranch: options.skipBranch,
	});

	if (branchFlow === "abort") {
		cleanup();
		process.exit(0);
	}

	// If message provided, use it directly
	let commitMessage = options.message;

	if (!commitMessage) {
		// Generate commit message using AI
		const s = createSpinner();
		s.start("Generating commit message");

		try {
			commitMessage = await generateCommitMessage({
				diff,
				modelOverride: options.model,
			});
			s.stop("Commit message generated");
		} catch (error) {
			s.stop("Failed to generate commit message");
			p.cancel(error instanceof Error ? error.message : String(error));
			cleanup();
			process.exit(1);
		}
	}

	// Show the commit message
	p.log.step(
		`Proposed commit message:\n${color.white(`  "${commitMessage}"`)}`,
	);

	// Confirm commit (unless --yes or --accept)
	if (!options.yes && !options.accept) {
		const action = await p.select({
			message: "What would you like to do?",
			options: [
				{ value: "commit", label: "Commit with this message" },
				{ value: "edit", label: "Edit message" },
				{ value: "regenerate", label: "Regenerate message" },
				{ value: "cancel", label: "Cancel" },
			],
		});

		if (p.isCancel(action) || action === "cancel") {
			p.cancel("Aborted");
			cleanup();
			process.exit(0);
		}

		if (action === "edit") {
			const editedMessage = await p.text({
				message: "Enter commit message:",
				initialValue: commitMessage,
				validate: (value) => {
					if (!value.trim()) return "Commit message cannot be empty";
				},
			});

			if (p.isCancel(editedMessage)) {
				p.cancel("Aborted");
				cleanup();
				process.exit(0);
			}

			commitMessage = editedMessage;
		}

		if (action === "regenerate") {
			const s = createSpinner();
			s.start("Regenerating commit message");

			try {
				commitMessage = await generateCommitMessage({
					diff,
					modelOverride: options.model,
				});
				s.stop("Commit message regenerated");
			} catch (error) {
				s.stop("Failed to regenerate commit message");
				p.cancel(error instanceof Error ? error.message : String(error));
				cleanup();
				process.exit(1);
			}

			p.log.step(`New commit message:\n${color.white(`  "${commitMessage}"`)}`);

			const confirmNew = await p.confirm({
				message: "Use this message?",
				initialValue: true,
			});

			if (p.isCancel(confirmNew) || !confirmNew) {
				p.cancel("Aborted");
				cleanup();
				process.exit(0);
			}
		}
	}

	// Perform the commit
	if (!commitMessage) {
		p.cancel("No commit message available");
		cleanup();
		process.exit(1);
	}

	const s = createSpinner();
	s.start("Committing");

	try {
		const result = await commit(commitMessage);
		s.stop(`Committed successfully!\n${color.dim(result)}`);
	} catch (error) {
		s.stop("Commit failed");
		p.cancel(error instanceof Error ? error.message : String(error));
		cleanup();
		process.exit(1);
	}

	// Offer to create PR after successful commit
	await maybeCreatePRAfterCommit({ yes: options.yes });

	p.outro(color.green("Done!"));
	cleanup();
	process.exit(0);
}

function hasChanges(status: GitStatus): boolean {
	return (
		status.staged.length > 0 ||
		status.unstaged.length > 0 ||
		status.untracked.length > 0
	);
}
