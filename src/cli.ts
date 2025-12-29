#!/usr/bin/env node

import { Command } from "commander";
import { commitCommand } from "./commands/commit";
import { changelogCommand } from "./commands/changelog";
import { releaseCommand } from "./commands/release";
import { prCommand } from "./commands/pr";

const program = new Command();

program
  .name("oc")
  .description("AI-powered git commit message generator using opencode.ai")
  .version("1.0.0");

program
  .argument("[message]", "Optional commit message to use directly")
  .option("-a, --all", "Stage all changes before committing")
  .option("-y, --yes", "Skip confirmation prompts")
  .action(async (message, options) => {
    await commitCommand({ message, ...options });
  });

program
  .command("changelog")
  .alias("cl")
  .description("Generate changelog from commits")
  .option("-f, --from <ref>", "Starting commit/tag reference")
  .option("-t, --to <ref>", "Ending commit/tag reference", "HEAD")
  .action(async (options) => {
    await changelogCommand(options);
  });

program
  .command("release")
  .alias("rel")
  .description("Generate changelog, commit, and optionally tag")
  .option("-f, --from <ref>", "Starting commit/tag reference")
  .option("-v, --version <version>", "Version for the release")
  .option("-t, --tag", "Create a git tag for the release")
  .option("-p, --push", "Push to remote after tagging")
  .option("-y, --yes", "Skip confirmation prompts")
  .action(async (options) => {
    await releaseCommand(options);
  });

program
  .command("pr")
  .description("Create a pull request for the current branch")
  .option("-y, --yes", "Skip confirmation prompts")
  .action(async (options) => {
    await prCommand(options);
  });

// Also support --changelog / -cl as flags on the main command
program
  .option("--changelog", "Generate changelog (alias for changelog command)")
  .option("-cl", "Generate changelog (shorthand)")
  .hook("preAction", async (thisCommand) => {
    const opts = thisCommand.opts();
    if (opts.changelog || opts.cl) {
      await changelogCommand({});
      process.exit(0);
    }
  });

program.parse();
