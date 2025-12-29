import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

export interface GitStatus {
	staged: string[];
	unstaged: string[];
	untracked: string[];
}

export async function git(
	args: string,
	options?: { preserveWhitespace?: boolean },
): Promise<string> {
	try {
		const { stdout } = await execAsync(`git ${args}`);
		return options?.preserveWhitespace ? stdout : stdout.trim();
	} catch (error) {
		throw new Error(
			`Git: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

export async function isGitRepo(): Promise<boolean> {
	try {
		await git("rev-parse --is-inside-work-tree");
		return true;
	} catch {
		return false;
	}
}

export async function getStatus(): Promise<GitStatus> {
	const output = await git("status --porcelain", { preserveWhitespace: true });
	const lines = output.split("\n").filter((line) => line.length > 0);

	const staged: string[] = [];
	const unstaged: string[] = [];
	const untracked: string[] = [];

	for (const line of lines) {
		const index = line[0];
		const work = line[1];
		const file = line.slice(3);

		if (index === "?") untracked.push(file);
		else if (index !== " ") staged.push(file);

		if (work !== " " && work !== "?") unstaged.push(file);
	}
	return { staged, unstaged, untracked };
}

export async function getStagedDiff(): Promise<string> {
	return git("diff --cached");
}

export async function stageAll(): Promise<void> {
	await git("add -A");
}

export async function stageFiles(files: string[]): Promise<void> {
	if (files.length === 0) return;
	await git(`add ${files.map((f) => `"${f}"`).join(" ")}`);
}

export async function commit(message: string): Promise<string> {
	return git(`commit -m "${message.replace(/"/g, '\\"')}"`);
}

export async function getCurrentBranch(): Promise<string | null> {
	try {
		return (await git("rev-parse --abbrev-ref HEAD")) || null;
	} catch {
		return null;
	}
}

export async function branchExists(branch: string): Promise<boolean> {
	try {
		await git(`show-ref --verify --quiet refs/heads/${branch}`);
		return true;
	} catch {
		return false;
	}
}

export async function getDefaultBranch(): Promise<string | null> {
	try {
		const ref = await git("symbolic-ref refs/remotes/origin/HEAD");
		return ref.split("/").pop() || null;
	} catch {
		if (await branchExists("main")) return "main";
		if (await branchExists("master")) return "master";
		return null;
	}
}

export async function createBranch(name: string): Promise<void> {
	await git(`checkout -b "${name.replace(/"/g, '\\"')}"`);
}

export async function getLog(
	options: { from?: string; to?: string; limit?: number } = {},
): Promise<string> {
	const { from, to = "HEAD", limit } = options;
	let cmd = "log --oneline";
	if (limit) cmd += ` -n ${limit}`;
	if (from) cmd += ` ${from}..${to}`;
	return git(cmd);
}

export async function getTags(): Promise<string[]> {
	try {
		return (await git("tag --sort=-creatordate")).split("\n").filter(Boolean);
	} catch {
		return [];
	}
}

export async function getReleases(): Promise<string[]> {
	return (await getTags()).filter((tag) => /^v?\d+\.\d+\.\d+/.test(tag));
}

export async function getDiffBetween(
	from: string,
	to: string,
): Promise<string> {
	return git(`diff ${from}..${to}`);
}

export async function getCommitsBetween(
	from: string,
	to: string,
): Promise<Array<{ hash: string; message: string }>> {
	const output = await git(`log --oneline ${from}..${to}`);
	return output
		.split("\n")
		.filter(Boolean)
		.map((line) => {
			const [hash, ...msg] = line.split(" ");
			return { hash, message: msg.join(" ") };
		});
}

export interface VersionBump {
	oldVersion: string | null;
	newVersion: string | null;
	file: string;
}

export async function detectVersionBump(
	from: string,
	to: string,
): Promise<VersionBump | null> {
	try {
		const files = (await git(`diff --name-only ${from}..${to}`))
			.split("\n")
			.map((f) => f.trim());
		if (!files.includes("package.json")) return null;

		const getV = async (ref: string) => {
			try {
				return (
					JSON.parse(await git(`show ${ref}:package.json`)).version || null
				);
			} catch {
				return null;
			}
		};

		const oldV = await getV(from);
		const newV = await getV(to);
		return oldV !== newV && newV
			? { oldVersion: oldV, newVersion: newV, file: "package.json" }
			: null;
	} catch {
		return null;
	}
}

export async function hasUpstreamBranch(): Promise<boolean> {
	try {
		await git("rev-parse --abbrev-ref @{upstream}");
		return true;
	} catch {
		return false;
	}
}

export async function pushBranch(): Promise<string> {
	const branch = await getCurrentBranch();
	if (!branch) throw new Error("No branch");
	return git(`push -u origin ${branch}`);
}

export async function getRemoteBranches(): Promise<string[]> {
	try {
		return (await git('branch -r --format="%(refname:short)"'))
			.split("\n")
			.filter(Boolean)
			.map((b) => b.replace(/^origin\//, ""))
			.filter((b) => b !== "HEAD");
	} catch {
		return [];
	}
}

export async function getDiffFromBranch(target: string): Promise<string> {
	try {
		const base = await git(`merge-base ${target} HEAD`);
		return git(`diff ${base}..HEAD`);
	} catch {
		return git(`diff ${target}..HEAD`);
	}
}

export async function getCommitsFromBranch(
	target: string,
): Promise<Array<{ hash: string; message: string }>> {
	try {
		const base = await git(`merge-base ${target} HEAD`);
		const output = await git(`log --oneline ${base}..HEAD`);
		return output
			.split("\n")
			.filter(Boolean)
			.map((line) => {
				const [hash, ...msg] = line.split(" ");
				return { hash, message: msg.join(" ") };
			});
	} catch {
		return [];
	}
}

export async function getCurrentVersion(): Promise<string | null> {
	try {
		const packageJson = await git("show HEAD:package.json");
		const pkg = JSON.parse(packageJson);
		return pkg.version || null;
	} catch {
		return null;
	}
}
