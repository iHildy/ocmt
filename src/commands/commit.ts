import * as p from "@clack/prompts";
import color from "picocolors";
import {
	getAiEditedOutputsContext,
	recordAiEditedOutput,
	recordAiEditedOutputSession,
} from "../lib/ai-edits";
import { maybeCreateBranchForCommit } from "../lib/branch";
import { getConfig } from "../lib/config";
import { cleanup, generateCommitMessage } from "../lib/opencode";
import { maybeCreatePRAfterCommit } from "../lib/pr";
import { confirmAction } from "../utils/confirm";
import {
	commit,
	type GitStatus,
	getStagedDiff,
	getStatus,
	isGitRepo,
	pushBranch,
	stageAll,
} from "../utils/git";
import {
	detectCommitIntent,
	promptForIntent,
	replaceCommitIntent,
} from "../utils/intent";
import { interactiveContentLoop } from "../utils/interactive-content";
import { createSpinner } from "../utils/ui";

export interface CommitOptions {
	message?: string;
	all?: boolean;
	yes?: boolean;
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
			const shouldStage = await confirmAction("Stage all changes?", true);

			if (shouldStage === null || !shouldStage) {
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
	const diff = await getStagedDiff();
	if (!diff) {
		p.outro(color.yellow("No diff content to analyze"));
		cleanup();
		process.exit(0);
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
	let originalCommitMessage: string | null = null;

	const recordCommitEdit = (edited: string) => {
		if (originalCommitMessage) {
			recordAiEditedOutputSession({
				kind: "commit-message",
				generated: originalCommitMessage,
				edited,
			});
		}
	};

	if (!commitMessage) {
		// Generate commit message using AI
		const s = createSpinner();
		s.start("Generating commit message");

		const context = await getAiEditedOutputsContext("commit");

		try {
			commitMessage = await generateCommitMessage({
				diff,
				context,
				modelOverride: options.model,
			});
			s.stop("Commit message generated");
			originalCommitMessage = commitMessage;
		} catch (error) {
			s.stop("Failed to generate commit message");
			p.cancel(error instanceof Error ? error.message : String(error));
			cleanup();
			process.exit(1);
		}
	}

	// Confirm commit (unless --yes or --accept)
	if (!options.yes && !options.accept) {
		const result = await interactiveContentLoop({
			content: commitMessage,
			contentLabel: "Proposed commit message",
			displayContent: (message) => {
				p.log.step(
					`Proposed commit message:\n${color.white(`  "${message}"`)}`,
				);
			},
			onEdit: async (current) => {
				const editedMessage = await p.text({
					message: "Enter commit message:",
					initialValue: current,
					validate: (value) => {
						if (!value.trim()) return "Commit message cannot be empty";
					},
				});

				if (p.isCancel(editedMessage)) {
					return null;
				}

				recordCommitEdit(editedMessage);
				return editedMessage;
			},
			onIntent: async (current) => {
				const currentIntent = detectCommitIntent(current);
				const newIntent = await promptForIntent(currentIntent);

				if (p.isCancel(newIntent)) {
					return null;
				}

				const updated = replaceCommitIntent(current, newIntent as string);
				recordCommitEdit(updated);
				return updated;
			},
			onRegenerate: async () => {
				const s = createSpinner();
				s.start("Regenerating commit message");

				const context = await getAiEditedOutputsContext("commit");

				try {
					const regenerated = await generateCommitMessage({
						diff,
						context,
						modelOverride: options.model,
					});
					s.stop("Commit message regenerated");
					originalCommitMessage = regenerated;
					return regenerated;
				} catch (error) {
					s.stop("Failed to regenerate commit message");
					p.cancel(error instanceof Error ? error.message : String(error));
					cleanup();
					process.exit(1);
				}
			},
			trackEdit: async (generated, edited) => {
				if (!originalCommitMessage) {
					return;
				}
				if (edited.trim() !== generated.trim()) {
					await recordAiEditedOutput({
						kind: "commit-message",
						generated,
						edited,
					});
				}
			},
			primaryActionLabel: "Commit with this message",
			skipLabel: "Skip commit",
			editLabel: "Edit message",
			regenerateLabel: "Regenerate message",
		});

		if (result === null) {
			p.cancel("Aborted");
			cleanup();
			process.exit(0);
		}

		if (result === "skip") {
			cleanup();
			process.exit(0);
		}

		commitMessage = result;
	} else {
		// Show the commit message when using --yes or --accept
		p.log.step(
			`Proposed commit message:\n${color.white(`  "${commitMessage}"`)}`,
		);
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

	const config = await getConfig();
	if (config.commit?.autoPush) {
		const pushSpinner = createSpinner();
		pushSpinner.start("Pushing to remote");

		try {
			await pushBranch();
			pushSpinner.stop("Pushed to remote");
		} catch (error) {
			pushSpinner.stop("Failed to push");
			p.log.warn(
				`Push failed: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

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
