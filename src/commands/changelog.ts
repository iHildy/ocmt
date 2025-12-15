import * as p from "@clack/prompts";
import color from "picocolors";
import {
  isGitRepo,
  getReleases,
  getCommitsBetween,
  getLog,
} from "../utils/git";
import { generateChangelog } from "../lib/opencode";

export interface ChangelogOptions {
  from?: string;
  to?: string;
}

/**
 * Changelog command (WIP)
 * - Shows previous commits/releases
 * - Lets you select a starting point
 * - Generates a changelog up to the selected point
 */
export async function changelogCommand(options: ChangelogOptions): Promise<void> {
  p.intro(color.bgYellow(color.black(" changelog (WIP) ")));

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

      // Ask what to do with it
      const action = await p.select({
        message: "What would you like to do?",
        options: [
          { value: "copy", label: "Copy to clipboard", hint: "not implemented" },
          { value: "save", label: "Save to CHANGELOG.md", hint: "not implemented" },
          { value: "done", label: "Done" },
        ],
      });

      if (p.isCancel(action)) {
        p.cancel("Aborted");
        process.exit(0);
      }

      if (action === "copy") {
        p.log.warn("Clipboard copy not yet implemented");
      } else if (action === "save") {
        p.log.warn("File save not yet implemented");
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
