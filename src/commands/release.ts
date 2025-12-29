import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as p from "@clack/prompts";
import color from "picocolors";
import { maybeCreateBranchForCommit } from "../lib/branch";
import {
	getAndValidateStagedDiff,
	maybeDeslopStagedChanges,
} from "../lib/deslop";
import { addHistoryEntry } from "../lib/history";
import {
	cleanup,
	generateChangelog,
	generateCommitMessage,
	updateChangelogFile,
} from "../lib/opencode";
import {
	commit,
	detectVersionBump,
	type GitStatus,
	getCommitsBetween,
	getCurrentVersion,
	getStagedDiff,
	getStatus,
	git,
	isGitRepo,
	stageAll,
} from "../utils/git";

export interface ReleaseOptions {
	from?: string;
	version?: string;
	yes?: boolean;
	tag?: boolean;
	push?: boolean;
	skipChangelog?: boolean;
	commitMessage?: string;
}

async function getRepoRoot(): Promise<string> {
	return git("rev-parse --show-toplevel");
}

async function getChangelogPath(): Promise<string> {
	const repoRoot = await getRepoRoot();
	return join(repoRoot, "CHANGELOG.md");
}

async function changelogExists(): Promise<boolean> {
	const changelogPath = await getChangelogPath();
	return existsSync(changelogPath);
}

async function saveChangelog(
	content: string,
	useAI: boolean = true,
): Promise<string> {
	const changelogPath = await getChangelogPath();

	const cleanContent = content
		.replace(/^```markdown\n?/i, "")
		.replace(/^```\n?/, "")
		.replace(/\n?```$/i, "")
		.trim();

	if (existsSync(changelogPath)) {
		const existing = readFileSync(changelogPath, "utf-8");

		if (useAI) {
			const updatedContent = await updateChangelogFile({
				newChangelog: cleanContent,
				existingChangelog: existing,
			});
			writeFileSync(changelogPath, `${updatedContent}\n`, "utf-8");
		} else {
			const headerMatch = existing.match(/^#\s+Changelog\s*\n/i);
			if (headerMatch) {
				const headerEnd = (headerMatch.index ?? 0) + headerMatch[0].length;
				const before = existing.slice(0, headerEnd);
				const after = existing.slice(headerEnd);
				writeFileSync(
					changelogPath,
					`${before}\n${cleanContent}\n${after}`,
					"utf-8",
				);
			} else {
				writeFileSync(changelogPath, `${cleanContent}\n\n${existing}`, "utf-8");
			}
		}
	} else {
		const newFile = `# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

${cleanContent}
`;
		writeFileSync(changelogPath, newFile, "utf-8");
	}

	return changelogPath;
}

function hasChanges(status: GitStatus): boolean {
	return (
		status.staged.length > 0 ||
		status.unstaged.length > 0 ||
		status.untracked.length > 0
	);
}

/**
 * Release command
 * Flow: commit -> changelog -> tag -> push
 *
 * 1. Commit current changes (like `oc`)
 * 2. Generate and commit changelog
 * 3. Create git tag
 * 4. Push to remote
 */
export async function releaseCommand(options: ReleaseOptions): Promise<void> {
	p.intro(color.bgMagenta(color.white(" release ")));

	if (!(await isGitRepo())) {
		p.cancel("Not a git repository");
		cleanup();
		process.exit(1);
	}

	p.log.step(color.bold("Step 1: Commit changes"));

	let status = await getStatus();
	let _madeCommit = false;

	if (hasChanges(status)) {
		// Stage all if there are unstaged changes
		if (status.unstaged.length > 0 || status.untracked.length > 0) {
			if (status.staged.length === 0) {
				// Nothing staged, offer to stage all
				if (!options.yes) {
					const filesPreview = [...status.unstaged, ...status.untracked]
						.slice(0, 5)
						.map((f) => `  ${color.dim(f)}`)
						.join("\n");
					const moreCount =
						status.unstaged.length + status.untracked.length - 5;

					p.log.info(
						`Unstaged changes:\n${filesPreview}${moreCount > 0 ? `\n  ${color.dim(`...and ${moreCount} more`)}` : ""}`,
					);

					const shouldStage = await p.confirm({
						message: "Stage all changes?",
						initialValue: true,
					});

					if (p.isCancel(shouldStage) || !shouldStage) {
						p.cancel("Aborted. Stage changes first with `git add`");
						cleanup();
						process.exit(0);
					}
				}

				const stageSpinner = p.spinner();
				stageSpinner.start("Staging all changes");
				await stageAll();
				stageSpinner.stop("All changes staged");
				status = await getStatus();
			}
		}

		if (status.staged.length > 0) {
			const stagedPreview = status.staged
				.slice(0, 5)
				.map((f) => `  ${color.green("+")} ${f}`)
				.join("\n");
			const moreCount = status.staged.length - 5;
			p.log.success(
				`Staged changes:\n${stagedPreview}${moreCount > 0 ? `\n  ${color.dim(`...and ${moreCount} more`)}` : ""}`,
			);

			let diff: string | null = await getStagedDiff();

			if (diff) {
				const deslopResult = await maybeDeslopStagedChanges({
					stagedDiff: diff,
					yes: options.yes,
				});

				if (deslopResult === "abort") {
					cleanup();
					process.exit(0);
				}

				if (deslopResult === "updated") {
					diff = await getAndValidateStagedDiff(
						"No staged diff to commit after deslop",
					);
				}

				if (!diff) {
				} else {
					const branchFlow = await maybeCreateBranchForCommit({
						diff,
						yes: options.yes,
					});

					if (branchFlow === "abort") {
						cleanup();
						process.exit(0);
					}

					const genSpinner = p.spinner();
					genSpinner.start("Generating commit message");

					const commitMessage = await generateCommitMessage({ diff });
					genSpinner.stop("Commit message generated");

					p.log.info(`Commit message: ${color.cyan(`"${commitMessage}"`)}`);

					if (!options.yes) {
						const confirmCommit = await p.confirm({
							message: "Commit with this message?",
							initialValue: true,
						});

						if (p.isCancel(confirmCommit) || !confirmCommit) {
							p.cancel("Aborted");
							cleanup();
							process.exit(0);
						}
					}

					const commitSpinner = p.spinner();
					commitSpinner.start("Committing");
					await commit(commitMessage);
					commitSpinner.stop("Changes committed");
					_madeCommit = true;
				}
			}
		}
	} else {
		p.log.info(color.dim("No changes to commit"));
	}

	if (options.skipChangelog) {
		p.log.info(color.dim("Skipping changelog generation (--skip-changelog)"));
	} else {
		p.log.step(color.bold("Step 2: Generate changelog"));

		let fromRef = options.from;

		if (!fromRef) {
			try {
				const tags = await git("tag --sort=-creatordate");
				const tagList = tags.split("\n").filter(Boolean);
				const versionTags = tagList.filter((tag) =>
					/^v?\d+\.\d+\.\d+/.test(tag),
				);

				if (versionTags.length > 0) {
					fromRef = versionTags[0];
					p.log.info(
						`Using latest tag ${color.cyan(fromRef)} as starting point`,
					);
				} else {
					const firstCommit = await git("rev-list --max-parents=0 HEAD");
					fromRef = firstCommit.split("\n")[0];
					p.log.warn("No tags found, using first commit");
				}
			} catch {
				p.cancel("Could not determine starting point. Use --from to specify.");
				cleanup();
				process.exit(1);
			}
		}

		const toRef = "HEAD";
		const commits = await getCommitsBetween(fromRef, toRef);

		if (commits.length === 0) {
			p.log.info(color.dim("No commits since last release"));
		} else {
			p.log.info(
				`Found ${commits.length} commits since ${color.cyan(fromRef)}`,
			);

			let version = options.version;

			if (!version) {
				const versionBump = await detectVersionBump(fromRef, toRef);
				if (versionBump?.newVersion) {
					version = versionBump.newVersion;
					p.log.success(`Version detected: ${color.cyan(version)}`);
				} else {
					const currentVersion = await getCurrentVersion();

					if (!options.yes) {
						const inputVersion = await p.text({
							message: "Enter version for this release:",
							placeholder: currentVersion || "1.0.0",
							initialValue: currentVersion || "",
							validate: (value) => {
								if (!value.trim()) return "Version is required";
								if (!/^\d+\.\d+\.\d+/.test(value))
									return "Invalid semver format (X.Y.Z)";
							},
						});

						if (p.isCancel(inputVersion)) {
							p.cancel("Aborted");
							cleanup();
							process.exit(0);
						}
						version = inputVersion as string;
					} else {
						version = currentVersion || undefined;
					}
				}
			}

			if (!version) {
				p.cancel("Version is required for release");
				cleanup();
				process.exit(1);
			}

			p.log.step(`Release version: ${color.cyan(version)}`);

			const changelogSpinner = p.spinner();
			changelogSpinner.start("Generating changelog");

			const changelog = await generateChangelog({
				commits,
				fromRef,
				toRef,
				version,
			});

			changelogSpinner.stop("Changelog generated");
			p.log.info(
				`Changelog preview:\n${color.dim(changelog.slice(0, 500))}${changelog.length > 500 ? "..." : ""}`,
			);

			const saveSpinner = p.spinner();
			const changelogFileExists = await changelogExists();
			saveSpinner.start(
				`${changelogFileExists ? "Updating" : "Creating"} CHANGELOG.md`,
			);

			await saveChangelog(changelog, changelogFileExists);
			saveSpinner.stop(
				`${changelogFileExists ? "Updated" : "Created"} CHANGELOG.md`,
			);

			const changelogCommitSpinner = p.spinner();
			changelogCommitSpinner.start("Committing changelog");

			await git("add CHANGELOG.md");
			const changelogCommitMsg =
				options.commitMessage || `chore(release): v${version}`;
			await commit(changelogCommitMsg);
			changelogCommitSpinner.stop(`Committed changelog for v${version}`);

			await addHistoryEntry(fromRef, toRef, commits.length);

			p.log.step(color.bold("Step 3: Create tag"));

			const tagName = version.startsWith("v") ? version : `v${version}`;

			let shouldTag = options.tag ?? true; // Default to true for release

			if (!options.yes && !options.tag) {
				const tagConfirm = await p.confirm({
					message: `Create tag ${color.cyan(tagName)}?`,
					initialValue: true,
				});

				if (p.isCancel(tagConfirm)) {
					p.cancel("Aborted");
					cleanup();
					process.exit(0);
				}
				shouldTag = tagConfirm;
			}

			if (shouldTag) {
				const tagSpinner = p.spinner();
				tagSpinner.start(`Creating tag ${tagName}`);

				try {
					await git(`tag ${tagName}`);
					tagSpinner.stop(`Created tag ${color.cyan(tagName)}`);

					p.log.step(color.bold("Step 4: Push to remote"));

					let shouldPush = options.push ?? false;

					if (!options.yes && !options.push) {
						const pushConfirm = await p.confirm({
							message: "Push to remote with tags?",
							initialValue: true,
						});

						if (!p.isCancel(pushConfirm)) {
							shouldPush = pushConfirm;
						}
					}

					if (shouldPush) {
						const pushSpinner = p.spinner();
						pushSpinner.start("Pushing to remote");

						try {
							await git("push origin HEAD --tags");
							pushSpinner.stop("Pushed to remote with tags");
						} catch (error) {
							pushSpinner.stop("Failed to push");
							p.log.warn(
								`Push failed: ${error instanceof Error ? error.message : String(error)}`,
							);
							p.log.info(
								`Push manually: ${color.cyan("git push origin HEAD --tags")}`,
							);
						}
					} else {
						p.log.info(
							`Push when ready: ${color.cyan("git push origin HEAD --tags")}`,
						);
					}
				} catch (error) {
					tagSpinner.stop("Failed to create tag");
					p.log.error(
						`Tag failed: ${error instanceof Error ? error.message : String(error)}`,
					);
					p.log.info(`Create manually: ${color.cyan(`git tag ${tagName}`)}`);
				}
			} else {
				p.log.info(
					`Create tag when ready: ${color.cyan(`git tag ${tagName}`)}`,
				);
			}
		}
	} // end skipChangelog else block

	p.log.success("Release complete!");
	p.outro(color.green("Done!"));
	cleanup();
	process.exit(0);
}
