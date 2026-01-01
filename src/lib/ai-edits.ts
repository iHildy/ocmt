import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { git } from "../utils/git";

const CONFIG_DIR = ".oc";
const HISTORY_FILE = "ai.edits.json";
const MAX_ENTRIES = 50;
const MAX_SESSION_ENTRIES = 25;

const sessionEntries: AiEditedOutputEntry[] = [];

export type AiEditedOutputKind =
	| "branch-name"
	| "commit-message"
	| "pr-title"
	| "pr-body";

export interface AiEditedOutputEntry {
	timestamp: string;
	kind: AiEditedOutputKind;
	generated: string;
	edited: string;
}

interface AiEditedOutputHistory {
	entries: AiEditedOutputEntry[];
}

async function getRepoRoot(): Promise<string> {
	return git("rev-parse --show-toplevel");
}

async function ensureConfigDir(): Promise<string> {
	const repoRoot = await getRepoRoot();
	const configDir = join(repoRoot, CONFIG_DIR);

	if (!existsSync(configDir)) {
		mkdirSync(configDir, { recursive: true });
	}

	return configDir;
}

async function getHistoryPath(): Promise<string> {
	const repoRoot = await getRepoRoot();
	return join(repoRoot, CONFIG_DIR, HISTORY_FILE);
}

async function loadHistory(): Promise<AiEditedOutputHistory> {
	try {
		const historyPath = await getHistoryPath();
		if (!existsSync(historyPath)) {
			return { entries: [] };
		}

		const content = readFileSync(historyPath, "utf-8");
		const parsed = JSON.parse(content) as AiEditedOutputHistory;
		if (!parsed?.entries || !Array.isArray(parsed.entries)) {
			return { entries: [] };
		}
		return parsed;
	} catch {
		return { entries: [] };
	}
}

async function saveHistory(history: AiEditedOutputHistory): Promise<void> {
	await ensureConfigDir();
	const historyPath = await getHistoryPath();
	writeFileSync(historyPath, JSON.stringify(history, null, 2), "utf-8");
}

export interface RecordAiEditedOutputOptions {
	kind: AiEditedOutputKind;
	generated: string;
	edited: string;
}

export function recordAiEditedOutputSession(
	options: RecordAiEditedOutputOptions,
): void {
	const generated = options.generated.trim();
	const edited = options.edited.trim();
	if (!generated || !edited || generated === edited) {
		return;
	}

	const last = sessionEntries[0];
	if (
		last &&
		last.kind === options.kind &&
		last.generated === generated &&
		last.edited === edited
	) {
		return;
	}

	sessionEntries.unshift({
		timestamp: new Date().toISOString(),
		kind: options.kind,
		generated,
		edited,
	});

	if (sessionEntries.length > MAX_SESSION_ENTRIES) {
		sessionEntries.splice(MAX_SESSION_ENTRIES);
	}
}

export async function recordAiEditedOutput(
	options: RecordAiEditedOutputOptions,
): Promise<void> {
	try {
		recordAiEditedOutputSession(options);

		const generated = options.generated.trim();
		const edited = options.edited.trim();
		if (!generated || !edited || generated === edited) {
			return;
		}

		const history = await loadHistory();

		// De-dupe: if the most recent entry is identical, skip.
		const last = history.entries[0];
		if (
			last &&
			last.kind === options.kind &&
			last.generated === generated &&
			last.edited === edited
		) {
			return;
		}

		history.entries.unshift({
			timestamp: new Date().toISOString(),
			kind: options.kind,
			generated,
			edited,
		});

		if (history.entries.length > MAX_ENTRIES) {
			history.entries = history.entries.slice(0, MAX_ENTRIES);
		}

		await saveHistory(history);
	} catch {
		// Never block the core flow on history persistence.
	}
}

function clipForPrompt(value: string, maxChars: number): string {
	const trimmed = value.trim();
	if (trimmed.length <= maxChars) {
		return trimmed;
	}
	return `${trimmed.slice(0, maxChars)}\n… (truncated)`;
}

function formatEntryForPrompt(entry: AiEditedOutputEntry): string {
	const maxChars = entry.kind === "pr-body" ? 800 : 180;
	const generated = clipForPrompt(entry.generated, maxChars);
	const edited = clipForPrompt(entry.edited, maxChars);
	return `- ${entry.kind}: user edited an AI output\n  - AI: ${JSON.stringify(generated)}\n  - User: ${JSON.stringify(edited)}`;
}

export type AiEditsContextPurpose = "branch" | "commit" | "pr";

function kindsForPurpose(purpose: AiEditsContextPurpose): AiEditedOutputKind[] {
	switch (purpose) {
		case "branch":
			return ["branch-name"];
		case "commit":
			return ["branch-name", "commit-message"];
		case "pr":
			return ["commit-message", "pr-title", "pr-body"];
	}
}

export async function getAiEditedOutputsContext(
	purpose: AiEditsContextPurpose,
): Promise<string | undefined> {
	try {
		const kinds = new Set(kindsForPurpose(purpose));
		const history = await loadHistory();

		const combined = [...sessionEntries, ...history.entries];
		const seen = new Set<string>();
		const relevant: AiEditedOutputEntry[] = [];

		for (const entry of combined) {
			if (!kinds.has(entry.kind)) {
				continue;
			}
			const key = `${entry.kind}\n${entry.generated}\n${entry.edited}`;
			if (seen.has(key)) {
				continue;
			}
			seen.add(key);
			relevant.push(entry);
		}

		if (relevant.length === 0) {
			return undefined;
		}

		const maxEntries = purpose === "pr" ? 3 : 5;
		const lines = relevant.slice(0, maxEntries).map(formatEntryForPrompt);

		return [
			"User edit history (use this to match the user's preferences):",
			...lines,
		].join("\n");
	} catch {
		return undefined;
	}
}
