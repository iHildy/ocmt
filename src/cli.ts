#!/usr/bin/env node

import { Command } from "commander";
import { changelogCommand } from "./commands/changelog";
import { commitCommand } from "./commands/commit";
import { prCommand } from "./commands/pr";
import { releaseCommand } from "./commands/release";
import { setSilentMode } from "./utils/ui";

const program = new Command();

program
	.name("oc")
	.description("AI-powered git commit message generator using opencode.ai")
	.version("1.0.0")
	.option("-s, --silent", "Suppress all CLI updates and animations")
	.hook("preAction", async (thisCommand) => {
		const opts = thisCommand.opts();
		if (opts.silent) {
			setSilentMode(true);
		}
		// Also support --changelog / -cl as flags on the main command
		if (opts.changelog || opts.cl) {
			await changelogCommand({});
			process.exit(0);
		}
	});

program
	.argument("[message]", "Optional commit message to use directly")
	.option("-a, --all", "Stage all changes before committing")
	.option("-y, --yes", "Skip confirmation prompts")
	.option("--model <model>", "Override AI model (format: provider/model)")
	.option("--accept", "Auto-accept generated message without confirmation")
	.option("--branch <name>", "Use specified branch name instead of generating")
	.option("--skip-branch", "Skip branch creation entirely")
	.action(async (message, options) => {
		await commitCommand({ message, ...options });
	});

program
	.command("changelog")
	.alias("cl")
	.description("Generate changelog from commits")
	.option("-f, --from <ref>", "Starting commit/tag reference")
	.option("-t, --to <ref>", "Ending commit/tag reference", "HEAD")
	.option("-o, --output <path>", "Output file path (default: CHANGELOG.md)")
	.option("--save", "Auto-save to file without prompting")
	.option("--copy", "Copy changelog to clipboard")
	.option("--model <model>", "Override AI model (format: provider/model)")
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
	.option("--skip-changelog", "Skip changelog generation")
	.option(
		"--commit-message <msg>",
		"Custom commit message for changelog commit",
	)
	.action(async (options) => {
		await releaseCommand(options);
	});

program
	.command("pr")
	.description("Create a pull request for the current branch")
	.option("-y, --yes", "Skip confirmation prompts")
	.option("-b, --target-branch <branch>", "Target branch for the PR")
	.option("--title <text>", "PR title (skips AI generation for title)")
	.option("--body <text>", "PR body/description (skips AI generation for body)")
	.option("--browser", "Open in browser for PR creation")
	.option("--open", "Auto-open PR in browser after creation")
	.action(async (options) => {
		await prCommand(options);
	});

program
	.option("--changelog", "Generate changelog (alias for changelog command)")
	.option("-cl", "Generate changelog (shorthand)");

program.parse();
