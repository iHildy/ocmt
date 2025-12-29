import * as p from "@clack/prompts";
import color from "picocolors";
import { cleanup } from "../lib/opencode";
import { runPRFlow } from "../lib/pr";
import { isGitRepo } from "../utils/git";

export interface PROptions {
	yes?: boolean;
	targetBranch?: string;
	title?: string;
	body?: string;
	browser?: boolean;
	open?: boolean;
}

export async function prCommand(options: PROptions): Promise<void> {
	p.intro(color.bgCyan(color.black(" oc pr ")));

	if (!(await isGitRepo())) {
		p.cancel("Not a git repository");
		cleanup();
		process.exit(1);
	}

	try {
		const result = await runPRFlow(options);

		switch (result) {
			case "created":
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
