import * as p from "@clack/prompts";
import color from "picocolors";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import {
  isGitRepo,
  getReleases,
  getCommitsBetween,
  getLog,
  git,
} from "../utils/git";
import { generateChangelog } from "../lib/opencode";

export interface ChangelogOptions {
  from?: string;
  to?: string;
}

/**
 * Get the git repository root directory
 */
async function getRepoRoot(): Promise<string> {
  return git("rev-parse --show-toplevel");
}

/**
 * Check if CHANGELOG.md exists in the repo root
 */
async function changelogExists(): Promise<boolean> {
  const repoRoot = await getRepoRoot();
  const changelogPath = join(repoRoot, "CHANGELOG.md");
  return existsSync(changelogPath);
}

/**
 * Save changelog to CHANGELOG.md
 * If file exists, prepend new content after the header
 */
async function saveChangelog(content: string): Promise<string> {
  const repoRoot = await getRepoRoot();
  const changelogPath = join(repoRoot, "CHANGELOG.md");

  // Clean up the content - remove markdown code blocks if present
  let cleanContent = content
    .replace(/^```markdown\n?/i, "")
    .replace(/\n?```$/i, "")
    .trim();

  if (existsSync(changelogPath)) {
    // File exists - prepend new content
    const existing = readFileSync(changelogPath, "utf-8");

    // Check if there's a main header (# Changelog)
    const headerMatch = existing.match(/^#\s+Changelog\s*\n/i);

    if (headerMatch) {
      // Insert after header
      const headerEnd = headerMatch.index! + headerMatch[0].length;
      const before = existing.slice(0, headerEnd);
      const after = existing.slice(headerEnd);
      const newContent = `${before}\n${cleanContent}\n${after}`;
      writeFileSync(changelogPath, newContent, "utf-8");
    } else {
      // No header, prepend to file
      writeFileSync(changelogPath, `${cleanContent}\n\n${existing}`, "utf-8");
    }
  } else {
    // Create new file with header
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

/**
 * Copy text to clipboard (cross-platform)
 */
async function copyToClipboard(text: string): Promise<void> {
  const { exec } = await import("child_process");
  const { promisify } = await import("util");
  const execAsync = promisify(exec);

  const platform = process.platform;

  try {
    if (platform === "darwin") {
      // macOS
      await execAsync(`echo ${JSON.stringify(text)} | pbcopy`);
    } else if (platform === "linux") {
      // Linux - try xclip first, then xsel
      try {
        await execAsync(`echo ${JSON.stringify(text)} | xclip -selection clipboard`);
      } catch {
        await execAsync(`echo ${JSON.stringify(text)} | xsel --clipboard --input`);
      }
    } else if (platform === "win32") {
      // Windows
      await execAsync(`echo ${JSON.stringify(text)} | clip`);
    } else {
      throw new Error(`Unsupported platform: ${platform}`);
    }
  } catch (error: any) {
    throw new Error(`Failed to copy to clipboard: ${error.message}`);
  }
}

/**
 * Changelog command
 * - Shows previous commits/releases
 * - Lets you select a starting point
 * - Generates a changelog up to the selected point
 */
export async function changelogCommand(options: ChangelogOptions): Promise<void> {
  p.intro(color.bgYellow(color.black(" changelog ")));

  // Check if we're in a git repo
  if (!(await isGitRepo())) {
    p.cancel("Not a git repository");
    process.exit(1);
  }

  let fromRef = options.from;
  const toRef = options.to || "HEAD";

  // If no --from specified, show options to select
  if (!fromRef) {
    const s = p.spinner();
    s.start("Fetching releases and commits");

    const releases = await getReleases();
    const recentLog = await getLog({ limit: 20 });
    const recentCommits = recentLog.split("\n").filter(Boolean);

    s.stop("Found releases and commits");

    // Build choices
    type SelectOption = { value: string; label: string; hint?: string };
    const selectOptions: SelectOption[] = [];

    if (releases.length > 0) {
      releases.slice(0, 10).forEach((tag) => {
        selectOptions.push({
          value: tag,
          label: tag,
          hint: "release",
        });
      });
    }

    if (recentCommits.length > 0) {
      recentCommits.forEach((commitLine) => {
        const [hash, ...msg] = commitLine.split(" ");
        selectOptions.push({
          value: hash,
          label: `${color.yellow(hash)} ${msg.join(" ")}`,
        });
      });
    }

    if (selectOptions.length === 0) {
      p.outro(color.yellow("No releases or commits found"));
      process.exit(0);
    }

    const selectedRef = await p.select({
      message: "Select starting point for changelog:",
      options: selectOptions,
    });

    if (p.isCancel(selectedRef)) {
      p.cancel("Aborted");
      process.exit(0);
    }

    fromRef = selectedRef as string;
  }

  // Get commits between refs
  const s = p.spinner();
  s.start(`Fetching commits ${fromRef}..${toRef}`);

  try {
    const commits = await getCommitsBetween(fromRef!, toRef);
    s.stop(`Found ${commits.length} commits`);

    if (commits.length === 0) {
      p.outro(color.yellow("No commits found in the specified range"));
      process.exit(0);
    }

    // Display commits
    const commitsList = commits
      .map((c) => color.dim(`  ${c.hash} ${c.message}`))
      .join("\n");
    p.log.info(`Commits to include in changelog:\n${commitsList}`);

    // Generate changelog
    const genSpinner = p.spinner();
    genSpinner.start("Generating changelog");

    try {
      const changelog = await generateChangelog({
        commits,
        fromRef: fromRef!,
        toRef,
      });

      genSpinner.stop("Changelog generated");

      p.log.step(`Generated Changelog:\n\n${changelog}`);

      // Check if CHANGELOG.md exists to customize the label
      const changelogFileExists = await changelogExists();
      const saveLabel = changelogFileExists
        ? "Update CHANGELOG.md"
        : "Create CHANGELOG.md";

      // Ask what to do with it
      const action = await p.select({
        message: "What would you like to do?",
        options: [
          { value: "save", label: saveLabel },
          { value: "copy", label: "Copy to clipboard" },
          { value: "done", label: "Done" },
        ],
      });

      if (p.isCancel(action)) {
        p.cancel("Aborted");
        process.exit(0);
      }

      if (action === "copy") {
        try {
          await copyToClipboard(changelog);
          p.log.success("Copied to clipboard!");
        } catch (error: any) {
          p.log.error(`Failed to copy: ${error.message}`);
        }
      } else if (action === "save") {
        try {
          const filePath = await saveChangelog(changelog);
          const actionWord = changelogFileExists ? "Updated" : "Created";
          p.log.success(`${actionWord} ${color.cyan(filePath)}`);
        } catch (error: any) {
          p.log.error(`Failed to save: ${error.message}`);
        }
      }

      p.outro(color.green("Done!"));
    } catch (error: any) {
      genSpinner.stop("Failed to generate changelog");
      p.cancel(error.message);
      process.exit(1);
    }
  } catch (error: any) {
    s.stop("Failed to fetch commits");
    p.cancel(error.message);
    process.exit(1);
  }
}
