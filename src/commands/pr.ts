import * as p from "@clack/prompts";
import color from "picocolors";
import { isGitRepo, getCurrentBranch, getDefaultBranch } from "../utils/git";
import { runPRFlow } from "../lib/pr";
import { cleanup } from "../lib/opencode";

export interface PROptions {
  yes?: boolean;
}

export async function prCommand(options: PROptions): Promise<void> {
  p.intro(color.bgCyan(color.black(" oc pr ")));

  if (!(await isGitRepo())) {
    p.cancel("Not a git repository");
    cleanup();
    process.exit(1);
  }

  const currentBranch = await getCurrentBranch();
  if (!currentBranch) {
    p.cancel("Not on a branch");
    cleanup();
    process.exit(1);
  }

  const defaultBranch = await getDefaultBranch();
  if (currentBranch === defaultBranch) {
    p.cancel(`Cannot create PR from default branch (${defaultBranch})`);
    cleanup();
    process.exit(1);
  }

  p.log.info(`Current branch: ${color.cyan(currentBranch)}`);

  try {
    const result = await runPRFlow(options);

    switch (result) {
      case "created":
        p.outro(color.green("Done!"));
        break;
      case "browser":
        p.outro(color.green("Done!"));
        break;
      case "skipped":
        p.outro(color.yellow("PR creation skipped"));
        break;
      case "abort":
        p.cancel("Aborted");
        cleanup();
        process.exit(0);
    }
  } catch (error) {
    p.cancel(error instanceof Error ? error.message : String(error));
    cleanup();
    process.exit(1);
  }

  cleanup();
  process.exit(0);
}
