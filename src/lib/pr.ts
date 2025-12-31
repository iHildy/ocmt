import { exec, execFile } from "node:child_process";
import { promisify } from "node:util";
import * as p from "@clack/prompts";
import color from "picocolors";
import {
	getCommitsFromBranch,
	getCurrentBranch,
	getDefaultBranch,
	getDiffFromBranch,
	getRemoteBranches,
	hasUpstreamBranch,
	pushBranch,
} from "../utils/git";
import {
	detectCommitIntent,
	promptForIntent,
	replaceCommitIntent,
} from "../utils/intent";
import { getConfig } from "./config";
import { generatePRContent, type PRContent } from "./opencode";
import { createSpinner } from "../utils/ui";

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

export type PRFlowResult = "created" | "browser" | "skipped" | "abort";

export interface PRFlowOptions {
	yes?: boolean;
	targetBranch?: string;
	title?: string;
	body?: string;
	browser?: boolean;
	open?: boolean;
}

export interface PRInfo {
	url: string;
	number: number;
	title: string;
	state: string;
}

interface RepoInfo {
	owner: string;
	name: string;
	isFork: boolean;
	parent?: {
		owner: string;
		name: string;
	};
}

async function isGhInstalled(): Promise<boolean> {
	try {
		await execFileAsync("gh", ["--version"]);
		return true;
	} catch {
		return false;
	}
}

async function isGhAuthenticated(): Promise<boolean> {
	try {
		await execAsync("gh auth status");
		return true;
	} catch {
		return false;
	}
}

export async function checkExistingPR(): Promise<PRInfo | null> {
	try {
		const { stdout } = await execAsync(
			"gh pr view --json url,number,title,state 2>/dev/null",
		);
		const data = JSON.parse(stdout.trim());
		return {
			url: data.url,
			number: data.number,
			title: data.title,
			state: data.state,
		};
	} catch {
		return null;
	}
}

async function getRepoInfo(): Promise<RepoInfo | null> {
	try {
		const { stdout } = await execAsync(
			"gh repo view --json owner,name,isFork,parent",
		);
		const data = JSON.parse(stdout.trim());
		return {
			owner: data.owner.login,
			name: data.name,
			isFork: data.isFork,
			parent: data.parent
				? {
						owner: data.parent.owner.login,
						name: data.parent.name,
					}
				: undefined,
		};
	} catch {
		return null;
	}
}

async function createPRWithGh(
	title: string,
	body: string,
	base: string,
): Promise<string> {
	const { stdout } = await execFileAsync("gh", [
		"pr",
		"create",
		"--title",
		title,
		"--body",
		body,
		"--base",
		base,
	]);

	const urlMatch = stdout.match(/https:\/\/github\.com\/[^\s]+/);
	return urlMatch ? urlMatch[0] : stdout.trim();
}

async function openInBrowser(url: string): Promise<void> {
	const platform = process.platform;

	if (platform === "darwin") {
		await execFileAsync("open", [url]);
	} else if (platform === "win32") {
		await execAsync(`start "" "${url}"`);
	} else {
		await execFileAsync("xdg-open", [url]);
	}
}

function buildNewPRUrl(
	owner: string,
	repo: string,
	sourceBranch: string,
	targetBranch: string,
): string {
	return `https://github.com/${owner}/${repo}/compare/${targetBranch}...${sourceBranch}?expand=1`;
}

async function resolveTargetBranch(yes?: boolean): Promise<string | null> {
	const defaultBranch = await getDefaultBranch();
	const remoteBranches = await getRemoteBranches();

	const currentBranch = await getCurrentBranch();
	const availableBranches = remoteBranches.filter((b) => b !== currentBranch);

	if (yes) {
		return defaultBranch || "main";
	}

	const action = await p.select({
		message: "Which branch would you like to target?",
		options: [
			{
				value: "default",
				label: `Default branch (${defaultBranch || "main"})`,
			},
			{ value: "specific", label: "Choose a specific branch" },
		],
	});

	if (p.isCancel(action)) {
		return null;
	}

	if (action === "default") {
		return defaultBranch || "main";
	}

	if (availableBranches.length === 0) {
		p.log.warn("No other branches found. Using default branch.");
		return defaultBranch || "main";
	}

	const branchOptions = availableBranches.slice(0, 20).map((b) => ({
		value: b,
		label: b,
	}));

	const selectedBranch = await p.select({
		message: "Select target branch:",
		options: branchOptions,
	});

	if (p.isCancel(selectedBranch)) {
		return null;
	}

	return selectedBranch as string;
}

async function resolvePRContent(
	diff: string,
	commits: Array<{ hash: string; message: string }>,
	sourceBranch: string,
	targetBranch: string,
	yes?: boolean,
): Promise<PRContent | null> {
	const s = createSpinner();
	s.start("Generating PR title and description");

	let prContent: PRContent;
	try {
		prContent = await generatePRContent({
			diff,
			commits,
			sourceBranch,
			targetBranch,
		});
		s.stop("PR content generated");
	} catch (error) {
		s.stop("Failed to generate PR content");
		throw error;
	}

	if (yes) {
		return prContent;
	}

	p.log.step(`Proposed PR title:\n${color.white(`  "${prContent.title}"`)}`);
	p.log.step(`Proposed PR body:\n${color.dim(prContent.body)}`);

	while (true) {
		const action = await p.select({
			message: "What would you like to do?",
			options: [
				{ value: "create", label: "Create PR with this content" },
				{ value: "intent", label: "Change intent" },
				{ value: "edit", label: "Edit content" },
				{ value: "regenerate", label: "Regenerate content" },
				{ value: "cancel", label: "Cancel" },
			],
		});

		if (p.isCancel(action) || action === "cancel") {
			return null;
		}

		if (action === "create") {
			return prContent;
		}

		if (action === "intent") {
			const currentIntent = detectCommitIntent(prContent.title);
			const newIntent = await promptForIntent(currentIntent);

			if (p.isCancel(newIntent)) {
				continue;
			}

			prContent.title = replaceCommitIntent(
				prContent.title,
				newIntent as string,
			);
			p.log.step(
				`Proposed PR title:\n${color.white(`  "${prContent.title}"`)}`,
			);
			continue;
		}

		if (action === "edit") {
			const editedTitle = await p.text({
				message: "Enter PR title:",
				initialValue: prContent.title,
				validate: (value) => {
					if (!value.trim()) return "PR title cannot be empty";
				},
			});

			if (p.isCancel(editedTitle)) {
				return null;
			}

			const editedBody = await p.text({
				message: "Enter PR body:",
				initialValue: prContent.body,
			});

			if (p.isCancel(editedBody)) {
				return null;
			}

			prContent = {
				title: editedTitle,
				body: editedBody || "",
			};
			p.log.step(
				`Proposed PR title:\n${color.white(`  "${prContent.title}"`)}`,
			);
			p.log.step(`Proposed PR body:\n${color.dim(prContent.body)}`);
			continue;
		}

		if (action === "regenerate") {
			const regenSpinner = createSpinner();
			regenSpinner.start("Regenerating PR content");

			try {
				prContent = await generatePRContent({
					diff,
					commits,
					sourceBranch,
					targetBranch,
				});
				regenSpinner.stop("PR content regenerated");
			} catch (error) {
				regenSpinner.stop("Failed to regenerate PR content");
				throw error;
			}

			p.log.step(
				`Proposed PR title:\n${color.white(`  "${prContent.title}"`)}`,
			);
			p.log.step(`Proposed PR body:\n${color.dim(prContent.body)}`);
			continue;
		}
	}
}

async function ensureBranchPushed(): Promise<boolean> {
	if (await hasUpstreamBranch()) {
		return true;
	}

	const s = createSpinner();
	s.start("Pushing branch to remote");

	try {
		await pushBranch();
		s.stop("Branch pushed to remote");
		return true;
	} catch (error) {
		s.stop("Failed to push branch");
		p.log.error(error instanceof Error ? error.message : String(error));
		return false;
	}
}

export async function createPR(options: PRFlowOptions): Promise<PRFlowResult> {
	const { yes, browser } = options;

	const currentBranch = await getCurrentBranch();
	if (!currentBranch) {
		p.log.warn("Not on a branch, skipping PR creation");
		return "skipped";
	}

	const defaultBranch = await getDefaultBranch();
	if (currentBranch === defaultBranch) {
		p.log.warn(`Cannot create PR from default branch (${defaultBranch})`);
		return "skipped";
	}

	if (!(await isGhInstalled())) {
		p.log.warn("GitHub CLI (gh) is not installed");
		p.log.info(
			`Install it with: ${color.cyan("brew install gh")} or visit ${color.cyan("https://cli.github.com/")}`,
		);
		return "skipped";
	}

	if (!(await isGhAuthenticated())) {
		p.log.warn("GitHub CLI is not authenticated");
		p.log.info(`Run ${color.cyan("gh auth login")} to authenticate`);
		return "skipped";
	}

	const existingPR = await checkExistingPR();
	if (existingPR) {
		p.log.info(
			`PR already exists: ${color.cyan(existingPR.url)} (${existingPR.state})`,
		);
		return "skipped";
	}

	// Handle --browser flag
	if (browser) {
		return await handleBrowserPRCreation(currentBranch);
	}

	if (!yes) {
		const action = await p.select({
			message: "Would you like to create a pull request?",
			options: [
				{ value: "auto", label: "Create automatically" },
				{ value: "browser", label: "Create in browser" },
				{ value: "skip", label: "Skip" },
			],
		});

		if (p.isCancel(action) || action === "skip") {
			return "skipped";
		}

		if (action === "browser") {
			return await handleBrowserPRCreation(currentBranch);
		}
	}

	return await handleAutoPRCreation(currentBranch, options);
}

export async function maybeCreatePRAfterCommit(
	options: PRFlowOptions,
): Promise<PRFlowResult> {
	const config = await getConfig();
	const currentBranch = await getCurrentBranch();
	const defaultBranch = await getDefaultBranch();

	if (!currentBranch || currentBranch === defaultBranch) {
		return "skipped";
	}

	if (options.yes && !config.pr?.autoCreate) {
		return "skipped";
	}

	return createPR(options);
}

async function handleBrowserPRCreation(
	currentBranch: string,
): Promise<PRFlowResult> {
	if (!(await ensureBranchPushed())) {
		return "abort";
	}

	const repoInfo = await getRepoInfo();
	if (!repoInfo) {
		p.log.error("Could not get repository information");
		return "abort";
	}

	const defaultBranch = (await getDefaultBranch()) || "main";

	const url = buildNewPRUrl(
		repoInfo.owner,
		repoInfo.name,
		currentBranch,
		defaultBranch,
	);

	const s = createSpinner();
	s.start("Opening browser");

	try {
		await openInBrowser(url);
		s.stop("Opened browser");
		p.log.success(`Create your PR at: ${color.cyan(url)}`);
		return "browser";
	} catch (_error) {
		s.stop("Failed to open browser");
		p.log.info(`Open this URL manually: ${color.cyan(url)}`);
		return "browser";
	}
}

async function handleAutoPRCreation(
	currentBranch: string,
	options: PRFlowOptions,
): Promise<PRFlowResult> {
	const {
		yes,
		targetBranch: providedTargetBranch,
		title: providedTitle,
		body: providedBody,
		open,
	} = options;
	const config = await getConfig();

	// Use provided target branch or resolve interactively
	const targetBranch = providedTargetBranch || (await resolveTargetBranch(yes));
	if (!targetBranch) {
		return "abort";
	}

	const diff = await getDiffFromBranch(targetBranch);
	const commits = await getCommitsFromBranch(targetBranch);

	if (!diff && commits.length === 0) {
		p.log.warn("No changes found between branches");
		return "skipped";
	}

	let prContent: PRContent | null;

	// Use provided title/body or generate
	if (providedTitle && providedBody) {
		// Both provided - use directly
		prContent = { title: providedTitle, body: providedBody };
	} else if (providedTitle || providedBody) {
		// Partial - generate what's missing, then override
		try {
			const generated = await resolvePRContent(
				diff,
				commits,
				currentBranch,
				targetBranch,
				true, // Skip interactive prompts for generation
			);
			if (!generated) {
				return "abort";
			}
			prContent = {
				title: providedTitle || generated.title,
				body: providedBody || generated.body,
			};
		} catch (error) {
			p.cancel(error instanceof Error ? error.message : String(error));
			return "abort";
		}
	} else {
		// Neither provided - use normal flow
		try {
			prContent = await resolvePRContent(
				diff,
				commits,
				currentBranch,
				targetBranch,
				yes,
			);
		} catch (error) {
			p.cancel(error instanceof Error ? error.message : String(error));
			return "abort";
		}
	}

	if (!prContent) {
		return "abort";
	}

	if (!(await ensureBranchPushed())) {
		return "abort";
	}

	const s = createSpinner();
	s.start("Creating pull request");

	let prUrl: string;
	try {
		prUrl = await createPRWithGh(prContent.title, prContent.body, targetBranch);
		s.stop("Pull request created!");
	} catch (error) {
		s.stop("Failed to create pull request");
		p.log.error(error instanceof Error ? error.message : String(error));
		return "abort";
	}

	p.log.success(`PR created: ${color.cyan(prUrl)}`);

	// Handle --open flag or config/interactive
	const shouldOpen =
		open !== undefined
			? open
			: yes
				? config.pr?.autoOpenInBrowser
				: await p.confirm({
						message: "Open PR in browser?",
						initialValue: true,
					});

	if (!p.isCancel(shouldOpen) && shouldOpen) {
		try {
			await openInBrowser(prUrl);
		} catch {
			p.log.info(`Open this URL: ${color.cyan(prUrl)}`);
		}
	}

	return "created";
}

export async function runPRFlow(options: PRFlowOptions): Promise<PRFlowResult> {
	return createPR(options);
}
