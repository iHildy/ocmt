import * as p from "@clack/prompts";
import color from "picocolors";
import {
	getAndValidateStagedDiff,
	maybeDeslopStagedChanges,
} from "../lib/deslop";
import { cleanup } from "../lib/opencode";
import { isGitRepo } from "../utils/git";

export interface DeslopOptions {
	yes?: boolean;
	instruction?: string;
}

export async function deslopCommand(options: DeslopOptions): Promise<void> {
	p.intro(color.bgCyan(color.black(" oc deslop ")));

	if (!(await isGitRepo())) {
		p.cancel("Not a git repository");
		cleanup();
		process.exit(1);
	}

	const stagedDiff = await getAndValidateStagedDiff(
		"No staged changes to deslop",
	);
	if (!stagedDiff) {
		cleanup();
		process.exit(0);
	}

	try {
		const result = await maybeDeslopStagedChanges({
			stagedDiff,
			yes: options.yes,
			extraPrompt: options.instruction,
			deslopOverride: "yes", // Force deslop since this is a dedicated command
		});

		switch (result) {
			case "updated":
				p.outro(color.green("Changes deslopped successfully!"));
				break;
			case "continue":
				p.outro(color.dim("No changes needed"));
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
