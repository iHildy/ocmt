import * as p from "@clack/prompts";
import color from "picocolors";
import { maybeCreateBranchForCommit } from "../lib/branch";
import { getConfig } from "../lib/config";
import {
	getAiEditedOutputsContext,
	recordAiEditedOutput,
	recordAiEditedOutputSession,
} from "../lib/ai-edits";
import { cleanup, generateCommitMessage } from "../lib/opencode";
import { maybeCreatePRAfterCommit } from "../lib/pr";
import { confirmAction, confirmWithMode } from "../utils/confirm";
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
	let wasEdited = false;

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
			wasEdited = false;
		} catch (error) {
			s.stop("Failed to generate commit message");
			p.cancel(error instanceof Error ? error.message : String(error));
			cleanup();
			process.exit(1);
		}
	}

	// Confirm commit (unless --yes or --accept)
	if (!options.yes && !options.accept) {
		// Check mode-aware confirmation first
		const confirmResult = await confirmWithMode({
			content: commitMessage,
			contentLabel: "Proposed commit message",
		});

		if (confirmResult === "cancel") {
			p.cancel("Aborted");
			cleanup();
			process.exit(0);
		}

		// Only enter full action loop if mode returned "interactive"
		if (confirmResult === "interactive") {
			let actionLoop = true;
			while (actionLoop) {
				const action = await p.select({
					message: "What would you like to do?",
					options: [
						{ value: "commit", label: "Commit with this message" },
						{ value: "intent", label: "Change intent" },
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

				if (action === "commit") {
					if (
						originalCommitMessage &&
						wasEdited &&
						commitMessage.trim() !== originalCommitMessage.trim()
					) {
						await recordAiEditedOutput({
							kind: "commit-message",
							generated: originalCommitMessage,
							edited: commitMessage,
						});
					}
					actionLoop = false;
					break;
				}

				if (action === "intent") {
					const currentIntent = detectCommitIntent(commitMessage);
					const newIntent = await promptForIntent(currentIntent);

					if (p.isCancel(newIntent)) {
						continue;
					}

					commitMessage = replaceCommitIntent(
						commitMessage,
						newIntent as string,
					);
					if (originalCommitMessage) {
						wasEdited = true;
						recordAiEditedOutputSession({
							kind: "commit-message",
							generated: originalCommitMessage,
							edited: commitMessage,
						});
					}
					p.log.step(
						`Proposed commit message:\n${color.white(`  "${commitMessage}"`)}`,
					);
					continue;
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
						continue;
					}

					commitMessage = editedMessage;
					if (originalCommitMessage) {
						wasEdited = true;
						recordAiEditedOutputSession({
							kind: "commit-message",
							generated: originalCommitMessage,
							edited: commitMessage,
						});
					}
					p.log.step(
						`Proposed commit message:\n${color.white(`  "${commitMessage}"`)}`,
					);
					continue;
				}

				if (action === "regenerate") {
					const s = createSpinner();
					s.start("Regenerating commit message");

					const context = await getAiEditedOutputsContext("commit");

					try {
						commitMessage = await generateCommitMessage({
							diff,
							context,
							modelOverride: options.model,
						});
						s.stop("Commit message regenerated");
						originalCommitMessage = commitMessage;
						wasEdited = false;
					} catch (error) {
						s.stop("Failed to regenerate commit message");
						p.cancel(error instanceof Error ? error.message : String(error));
						cleanup();
						process.exit(1);
					}

					p.log.step(
						`Proposed commit message:\n${color.white(`  "${commitMessage}"`)}`,
					);
					continue;
				}
			}
		}
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
