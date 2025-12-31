import * as p from "@clack/prompts";

export const INTENT_TYPES = [
	{ value: "feat", label: "feat", hint: "A new feature" },
	{ value: "fix", label: "fix", hint: "A bug fix" },
	{ value: "docs", label: "docs", hint: "Documentation only" },
	{ value: "style", label: "style", hint: "Code style (no logic change)" },
	{ value: "refactor", label: "refactor", hint: "Code restructuring" },
	{ value: "perf", label: "perf", hint: "Performance improvement" },
	{ value: "test", label: "test", hint: "Adding/fixing tests" },
	{ value: "chore", label: "chore", hint: "Build/tooling changes" },
	{ value: "feat!", label: "feat!", hint: "Breaking feature" },
	{ value: "fix!", label: "fix!", hint: "Breaking fix" },
] as const;

export type IntentType = (typeof INTENT_TYPES)[number]["value"];

const COMMIT_INTENT_REGEX = /^(\w+!?)(?:\([^)]*\))?:\s*/;
const BRANCH_INTENT_REGEX = /^(\w+!?)\//;

/**
 * Extract intent from a commit message or PR title.
 * @example detectCommitIntent("feat: add login") // "feat"
 * @example detectCommitIntent("fix(auth): bug") // "fix"
 * @example detectCommitIntent("feat!: breaking") // "feat!"
 * @example detectCommitIntent("random message") // null
 */
export function detectCommitIntent(message: string): string | null {
	const match = message.match(COMMIT_INTENT_REGEX);
	return match ? match[1] : null;
}

/**
 * Replace or prepend intent in a commit message or PR title.
 * Preserves scope if present.
 * @example replaceCommitIntent("feat: add login", "fix") // "fix: add login"
 * @example replaceCommitIntent("feat(auth): login", "fix") // "fix(auth): login"
 * @example replaceCommitIntent("random message", "feat") // "feat: random message"
 */
export function replaceCommitIntent(
	message: string,
	newIntent: string,
): string {
	const match = message.match(/^(\w+!?)(\([^)]*\))?:\s*/);

	if (match) {
		const scope = match[2] || "";
		const rest = message.slice(match[0].length);
		return `${newIntent}${scope}: ${rest}`;
	}

	return `${newIntent}: ${message}`;
}

/**
 * Extract intent from a branch name.
 * @example detectBranchIntent("feat/add-login") // "feat"
 * @example detectBranchIntent("my-branch") // null
 */
export function detectBranchIntent(branchName: string): string | null {
	const match = branchName.match(BRANCH_INTENT_REGEX);
	return match ? match[1] : null;
}

/**
 * Replace or prepend intent in a branch name.
 * @example replaceBranchIntent("feat/add-login", "fix") // "fix/add-login"
 * @example replaceBranchIntent("my-branch", "feat") // "feat/my-branch"
 */
export function replaceBranchIntent(
	branchName: string,
	newIntent: string,
): string {
	const match = branchName.match(BRANCH_INTENT_REGEX);

	if (match) {
		// Has existing intent - replace it
		const rest = branchName.slice(match[0].length);
		return `${newIntent}/${rest}`;
	}

	// No intent - prepend
	return `${newIntent}/${branchName}`;
}

export async function promptForIntent(
	currentIntent?: string | null,
): Promise<string | symbol> {
	const validIntents = INTENT_TYPES.map((t) => t.value);
	const initialValue =
		currentIntent && validIntents.includes(currentIntent as IntentType)
			? currentIntent
			: "feat";

	const selected = await p.select({
		message: "Select intent:",
		initialValue,
		options: INTENT_TYPES.map((t) => ({
			value: t.value,
			label: t.label,
			hint: t.hint,
		})),
	});

	return selected;
}
