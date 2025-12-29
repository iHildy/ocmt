/**
 * Changelog history management
 *
 * Tracks when changelogs were generated to allow "generate since last changelog" functionality
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { git } from "../utils/git";

const CONFIG_DIR = ".oc";
const HISTORY_FILE = "changelog.history.json";

export interface ChangelogHistoryEntry {
	timestamp: string;
	fromRef: string;
	toRef: string;
	toCommitHash: string;
	commitsIncluded: number;
}

export interface ChangelogHistory {
	entries: ChangelogHistoryEntry[];
}

/**
 * Get the git repository root directory
 */
async function getRepoRoot(): Promise<string> {
	return git("rev-parse --show-toplevel");
}

/**
 * Get the path to the history file
 */
async function getHistoryPath(): Promise<string> {
	const repoRoot = await getRepoRoot();
	return join(repoRoot, CONFIG_DIR, HISTORY_FILE);
}

/**
 * Ensure the .oc config directory exists
 */
async function ensureConfigDir(): Promise<string> {
	const repoRoot = await getRepoRoot();
	const configDir = join(repoRoot, CONFIG_DIR);

	if (!existsSync(configDir)) {
		mkdirSync(configDir, { recursive: true });
	}

	return configDir;
}

/**
 * Get the commit hash for a ref
 */
async function getCommitHash(ref: string): Promise<string> {
	return git(`rev-parse ${ref}`);
}

/**
 * Load changelog history from file
 */
export async function loadHistory(): Promise<ChangelogHistory> {
	const historyPath = await getHistoryPath();

	if (!existsSync(historyPath)) {
		return { entries: [] };
	}

	try {
		const content = readFileSync(historyPath, "utf-8");
		return JSON.parse(content) as ChangelogHistory;
	} catch {
		return { entries: [] };
	}
}

/**
 * Save changelog history to file
 */
export async function saveHistory(history: ChangelogHistory): Promise<void> {
	await ensureConfigDir();
	const historyPath = await getHistoryPath();
	writeFileSync(historyPath, JSON.stringify(history, null, 2), "utf-8");
}

/**
 * Add a new entry to the changelog history
 */
export async function addHistoryEntry(
	fromRef: string,
	toRef: string,
	commitsIncluded: number,
): Promise<void> {
	const history = await loadHistory();
	const toCommitHash = await getCommitHash(toRef);

	const entry: ChangelogHistoryEntry = {
		timestamp: new Date().toISOString(),
		fromRef,
		toRef,
		toCommitHash,
		commitsIncluded,
	};

	// Add to beginning of array (most recent first)
	history.entries.unshift(entry);

	// Keep only last 50 entries
	if (history.entries.length > 50) {
		history.entries = history.entries.slice(0, 50);
	}

	await saveHistory(history);
}

/**
 * Get the last changelog entry (most recent)
 */
export async function getLastEntry(): Promise<ChangelogHistoryEntry | null> {
	const history = await loadHistory();
	return history.entries[0] || null;
}

/**
 * Check if there are commits since the last changelog
 */
export async function hasCommitsSinceLastChangelog(): Promise<{
	hasCommits: boolean;
	lastEntry: ChangelogHistoryEntry | null;
	commitCount: number;
}> {
	const lastEntry = await getLastEntry();

	if (!lastEntry) {
		return { hasCommits: false, lastEntry: null, commitCount: 0 };
	}

	try {
		// Check if the commit still exists
		await git(`rev-parse ${lastEntry.toCommitHash}`);

		// Count commits since last changelog
		const output = await git(
			`rev-list --count ${lastEntry.toCommitHash}..HEAD`,
		);
		const commitCount = parseInt(output, 10);

		return {
			hasCommits: commitCount > 0,
			lastEntry,
			commitCount,
		};
	} catch {
		// Commit no longer exists or other error
		return { hasCommits: false, lastEntry: null, commitCount: 0 };
	}
}

/**
 * Format a history entry for display
 */
export function formatHistoryEntry(entry: ChangelogHistoryEntry): string {
	const date = new Date(entry.timestamp);
	const formattedDate = date.toLocaleDateString("en-US", {
		month: "short",
		day: "numeric",
		year: "numeric",
	});
	const formattedTime = date.toLocaleTimeString("en-US", {
		hour: "2-digit",
		minute: "2-digit",
	});

	return `${formattedDate} ${formattedTime} (${entry.commitsIncluded} commits, ${entry.fromRef}..${entry.toRef})`;
}
