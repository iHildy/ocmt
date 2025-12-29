import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

export interface GitStatus {
  staged: string[];
  unstaged: string[];
  untracked: string[];
}

export async function git(args: string, options?: { preserveWhitespace?: boolean }): Promise<string> {
  try {
    const { stdout } = await execAsync(`git ${args}`);
    return options?.preserveWhitespace ? stdout : stdout.trim();
  } catch (error) {
    throw new Error(`Git command failed: ${error instanceof Error ? error.message : String(error)}`);
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
    const indexStatus = line[0];
    const workTreeStatus = line[1];
    const file = line.slice(3);

    if (indexStatus === "?") {
      untracked.push(file);
    } else if (indexStatus !== " ") {
      staged.push(file);
    }

    if (workTreeStatus !== " " && workTreeStatus !== "?") {
      unstaged.push(file);
    }
  }

  return { staged, unstaged, untracked };
}

export async function getStagedDiff(): Promise<string> {
  return git("diff --cached");
}

export async function getUnstagedDiff(): Promise<string> {
  return git("diff");
}

export async function stageAll(): Promise<void> {
  await git("add -A");
}

export async function stageFiles(files: string[]): Promise<void> {
  if (files.length === 0) return;
  const escaped = files.map((f) => `"${f}"`).join(" ");
  await git(`add ${escaped}`);
}

export async function commit(message: string): Promise<string> {
  return git(`commit -m "${message.replace(/"/g, '\\"')}"`);
}

export async function getCurrentBranch(): Promise<string | null> {
  try {
    const branch = await git("rev-parse --abbrev-ref HEAD");
    return branch || null;
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
    const parts = ref.split("/");
    return parts[parts.length - 1] || null;
  } catch {
    if (await branchExists("main")) return "main";
    if (await branchExists("master")) return "master";
    return null;
  }
}

export async function createBranch(name: string): Promise<void> {
  const safeName = name.replace(/"/g, '\\"');
  await git(`checkout -b "${safeName}"`);
}

export async function getLog(
  options: { from?: string; to?: string; limit?: number } = {}
): Promise<string> {
  const { from, to = "HEAD", limit } = options;
  let cmd = "log --oneline";

  if (limit) {
    cmd += ` -n ${limit}`;
  }

  if (from) {
    cmd += ` ${from}..${to}`;
  }

  return git(cmd);
}

export async function getTags(): Promise<string[]> {
  try {
    const output = await git("tag --sort=-creatordate");
    return output.split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

export async function getReleases(): Promise<string[]> {
  const tags = await getTags();
  return tags.filter((tag) => /^v?\d+\.\d+\.\d+/.test(tag));
}

export async function getDiffBetween(from: string, to: string): Promise<string> {
  return git(`diff ${from}..${to}`);
}

export async function getCommitsBetween(
  from: string,
  to: string
): Promise<Array<{ hash: string; message: string }>> {
  const output = await git(`log --oneline ${from}..${to}`);
  const lines = output.split("\n").filter(Boolean);

  return lines.map((line) => {
    const [hash, ...messageParts] = line.split(" ");
    return { hash, message: messageParts.join(" ") };
  });
}

export interface VersionBump {
  oldVersion: string | null;
  newVersion: string | null;
  file: string;
}

export async function detectVersionBump(
  from: string,
  to: string
): Promise<VersionBump | null> {
  try {
    const changedFiles = await git(`diff --name-only ${from}..${to}`);
    const changedFilesList = changedFiles.split("\n").map(f => f.trim()).filter(Boolean);
    
    if (!changedFilesList.includes("package.json")) {
      return null;
    }

    let oldVersion: string | null = null;
    try {
      const oldPackageJson = await git(`show ${from}:package.json`);
      const oldPkg = JSON.parse(oldPackageJson);
      oldVersion = oldPkg.version || null;
    } catch {
    }

    let newVersion: string | null = null;
    try {
      const newPackageJson = await git(`show ${to}:package.json`);
      const newPkg = JSON.parse(newPackageJson);
      newVersion = newPkg.version || null;
    } catch {
    }

    if (oldVersion !== newVersion && newVersion) {
      return {
        oldVersion,
        newVersion,
        file: "package.json",
      };
    }

    return null;
  } catch {
    return null;
  }
}

export async function getCurrentVersion(): Promise<string | null> {
  try {
    const repoRoot = await git("rev-parse --show-toplevel");
    const { readFileSync, existsSync } = await import("fs");
    const { join } = await import("path");
    
    const packageJsonPath = join(repoRoot, "package.json");
    
    if (!existsSync(packageJsonPath)) {
      return null;
    }

    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf-8"));
    return packageJson.version || null;
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
  if (!branch) {
    throw new Error("Not on a branch");
  }
  return git(`push -u origin ${branch}`);
}

export async function getRemoteUrl(): Promise<string | null> {
  try {
    const url = await git("remote get-url origin");
    return url || null;
  } catch {
    return null;
  }
}

export async function getRemoteBranches(): Promise<string[]> {
  try {
    const output = await git('branch -r --format="%(refname:short)"');
    return output
      .split("\n")
      .filter(Boolean)
      .map((b) => b.replace(/^origin\//, ""))
      .filter((b) => b !== "HEAD");
  } catch {
    return [];
  }
}

export async function getLocalBranches(): Promise<string[]> {
  try {
    const output = await git("branch --format='%(refname:short)'");
    return output.split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

export function parseRepoFromUrl(url: string): { owner: string; repo: string } | null {
  const sshMatch = url.match(/git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (sshMatch) {
    return { owner: sshMatch[1], repo: sshMatch[2] };
  }

  const httpsMatch = url.match(/https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (httpsMatch) {
    return { owner: httpsMatch[1], repo: httpsMatch[2] };
  }

  return null;
}

export async function getDiffFromBranch(targetBranch: string): Promise<string> {
  try {
    const mergeBase = await git(`merge-base ${targetBranch} HEAD`);
    return git(`diff ${mergeBase}..HEAD`);
  } catch {
    return git(`diff ${targetBranch}..HEAD`);
  }
}

export async function getCommitsFromBranch(
  targetBranch: string
): Promise<Array<{ hash: string; message: string }>> {
  try {
    const mergeBase = await git(`merge-base ${targetBranch} HEAD`);
    const output = await git(`log --oneline ${mergeBase}..HEAD`);
    const lines = output.split("\n").filter(Boolean);

    return lines.map((line) => {
      const [hash, ...messageParts] = line.split(" ");
      return { hash, message: messageParts.join(" ") };
    });
  } catch {
    return [];
  }
}
