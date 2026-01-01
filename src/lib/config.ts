import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExecutionMode } from "../types/mode";
import { git } from "../utils/git";

const CONFIG_DIR = ".oc";
const COMMIT_CONFIG_FILE = "config.md";
const CHANGELOG_CONFIG_FILE = "changelog.md";
const PR_CONFIG_FILE = "pr.md";
const BRANCH_CONFIG_FILE = "branch.md";
const JSON_CONFIG_FILE = "config.json";

// Global config directory in user's home
const GLOBAL_CONFIG_DIR = join(homedir(), ".oc");

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mergeConfigs(base: OcConfig, override: Partial<OcConfig>): OcConfig {
	const result = { ...base };

	for (const key of Object.keys(override) as (keyof OcConfig)[]) {
		const baseValue = result[key];
		const overrideValue = override[key];

		if (overrideValue !== undefined) {
			if (isObject(baseValue) && isObject(overrideValue)) {
				// Shallow merge nested objects (one level)
				result[key] = { ...baseValue, ...overrideValue } as typeof baseValue;
			} else {
				result[key] = overrideValue as typeof baseValue;
			}
		}
	}

	return result;
}

function ensureGlobalConfigDir(): string {
	if (!existsSync(GLOBAL_CONFIG_DIR)) {
		mkdirSync(GLOBAL_CONFIG_DIR, { recursive: true });
	}
	return GLOBAL_CONFIG_DIR;
}

export interface OcConfig {
	commit?: {
		autoAccept?: boolean;
		autoStageAll?: boolean;
		autoCreateBranchOnDefault?: boolean;
		autoCreateBranchOnNonDefault?: boolean;
		forceNewBranchOnDefault?: boolean;
		autoPush?: boolean;
		branchModel?: string; // format: "provider/model"
		model?: string; // format: "provider/model"
	};
	changelog?: {
		autoSave?: boolean;
		outputFile?: string;
		model?: string; // format: "provider/model"
	};
	release?: {
		autoTag?: boolean;
		autoPush?: boolean;
		tagPrefix?: string;
	};
	pr?: {
		autoCreate?: boolean;
		autoOpenInBrowser?: boolean;
		model?: string; // format: "provider/model"
	};
	general?: {
		confirmPrompts?: boolean;
		verbose?: boolean;
		silent?: boolean;
	};
	defaults?: {
		/** Persisted execution mode - set when user chooses "Always use..." */
		executionMode?: ExecutionMode;
		/** If true, skip the startup mode prompt and use executionMode */
		skipModePrompt?: boolean;
	};
}

const DEFAULT_JSON_CONFIG: OcConfig = {
	commit: {
		autoAccept: false,
		autoStageAll: false,
		autoCreateBranchOnDefault: true,
		autoCreateBranchOnNonDefault: false,
		forceNewBranchOnDefault: false,
		autoPush: false,
		branchModel: "opencode/gpt-5-nano",
		model: "opencode/gpt-5-nano",
	},
	changelog: {
		autoSave: false,
		outputFile: "CHANGELOG.md",
		model: "opencode/claude-sonnet-4-5",
	},
	release: {
		autoTag: false,
		autoPush: false,
		tagPrefix: "v",
	},
	pr: {
		autoCreate: false,
		autoOpenInBrowser: false,
		model: "opencode/gpt-5-nano",
	},
	general: {
		confirmPrompts: true,
		verbose: false,
		silent: false,
	},
	defaults: {
		executionMode: undefined,
		skipModePrompt: false,
	},
};

const DEFAULT_COMMIT_CONFIG = `# Commit Message Guidelines

Generate commit messages following the Conventional Commits specification.

## Format

\`\`\`
<type>: <description>

[optional body]
\`\`\`

## Types

- \`feat\`: A new feature
- \`fix\`: A bug fix
- \`docs\`: Documentation only changes
- \`style\`: Changes that do not affect the meaning of the code
- \`refactor\`: A code change that neither fixes a bug nor adds a feature
- \`perf\`: A code change that improves performance
- \`test\`: Adding missing tests or correcting existing tests
- \`chore\`: Changes to the build process or auxiliary tools

## Rules

1. Use lowercase for the type
2. No scope (e.g., use \`feat:\` not \`feat(api):\`)
3. Use imperative mood in description ("add" not "added")
4. Keep the first line under 72 characters
5. Do not end the description with a period
6. Only return the commit message, no explanations or markdown formatting
`;

const DEFAULT_CHANGELOG_CONFIG = `# Changelog Generation Guidelines

Generate a changelog from the provided commits.

## Format

Use the "Keep a Changelog" format (https://keepachangelog.com/).

## Structure

\`\`\`markdown
## [Version] - YYYY-MM-DD

### Added
- New features

### Changed
- Changes in existing functionality

### Deprecated
- Soon-to-be removed features

### Removed
- Removed features

### Fixed
- Bug fixes

### Security
- Vulnerability fixes
\`\`\`

## Rules

1. Group commits by type (feat -> Added, fix -> Fixed, etc.)
2. Write in past tense ("Added" not "Add")
3. Include the commit hash in parentheses at the end of each entry
4. Keep descriptions concise but informative
5. Omit the version number and date - just use "Unreleased" as the heading
6. Skip empty sections
7. Only return the changelog content, no explanations
`;

const DEFAULT_PR_CONFIG = `# Pull Request Generation Guidelines

Generate a pull request title and description from the provided diff and commits.

## Format

Return the response in the following format:

TITLE: <concise PR title>

BODY:
<PR description in markdown>

## Title Rules

1. Use imperative mood ("Add feature" not "Added feature")
2. Keep under 72 characters
3. Be specific but concise
4. No period at the end

## Body Structure

\`\`\`markdown
## Summary

Brief description of what this PR does.

## Changes

- Bullet points of key changes

## Testing

How to test the changes (if applicable)
\`\`\`

## Body Rules

1. Start with a clear summary
2. List the main changes as bullet points
3. Be informative but concise
4. Use markdown formatting
5. Only return the title and body, no additional explanations
`;

const DEFAULT_BRANCH_CONFIG = `# Branch Name Generation Guidelines

Generate a concise git branch name for the provided diff.

## Rules

1. Use lowercase letters
2. Use hyphens to separate words
3. Use a prefix like "feat/", "fix/", "docs/", "refactor/", or "chore/"
4. No spaces, quotes, or markdown
5. Keep it under 40 characters
6. Be specific but very concise
7. Return ONLY the branch name, no explanations, no "Proposed branch name:", no markdown formatting
`;

async function getRepoRoot(): Promise<string> {
	const root = await git("rev-parse --show-toplevel");
	return root;
}

async function getLayeredTextConfig(
	fileName: string,
	defaultContent: string,
): Promise<string> {
	// Check project config first
	try {
		const repoRoot = await getRepoRoot();
		const projectPath = join(repoRoot, CONFIG_DIR, fileName);

		if (existsSync(projectPath)) {
			return readFileSync(projectPath, "utf-8");
		}
	} catch {
		// Not in a git repo, use global
	}

	// Fall back to global config (create if doesn't exist)
	const globalDir = ensureGlobalConfigDir();
	const globalPath = join(globalDir, fileName);

	if (!existsSync(globalPath)) {
		writeFileSync(globalPath, defaultContent, "utf-8");
	}

	return readFileSync(globalPath, "utf-8");
}

export async function getCommitConfig(): Promise<string> {
	return getLayeredTextConfig(COMMIT_CONFIG_FILE, DEFAULT_COMMIT_CONFIG);
}

export async function getChangelogConfig(): Promise<string> {
	return getLayeredTextConfig(CHANGELOG_CONFIG_FILE, DEFAULT_CHANGELOG_CONFIG);
}

export async function getPRConfig(): Promise<string> {
	return getLayeredTextConfig(PR_CONFIG_FILE, DEFAULT_PR_CONFIG);
}

export async function getBranchConfig(): Promise<string> {
	return getLayeredTextConfig(BRANCH_CONFIG_FILE, DEFAULT_BRANCH_CONFIG);
}

export async function configExists(): Promise<boolean> {
	try {
		const repoRoot = await getRepoRoot();
		const configDir = join(repoRoot, CONFIG_DIR);
		return existsSync(join(configDir, COMMIT_CONFIG_FILE));
	} catch {
		return false;
	}
}

export async function getConfig(): Promise<OcConfig> {
	// Start with defaults
	let config: OcConfig = { ...DEFAULT_JSON_CONFIG };

	// Load global config (create if doesn't exist)
	const globalDir = ensureGlobalConfigDir();
	const globalPath = join(globalDir, JSON_CONFIG_FILE);

	if (!existsSync(globalPath)) {
		writeFileSync(
			globalPath,
			JSON.stringify(DEFAULT_JSON_CONFIG, null, 2),
			"utf-8",
		);
	} else {
		try {
			const globalContent = readFileSync(globalPath, "utf-8");
			const globalConfig = JSON.parse(globalContent) as Partial<OcConfig>;
			config = mergeConfigs(config, globalConfig);
		} catch (error) {
			console.warn(
				`[oc] Warning: Could not parse global config at '${globalPath}'. Using defaults. Error: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	// Load project config (if exists, don't create)
	try {
		const repoRoot = await getRepoRoot();
		const projectPath = join(repoRoot, CONFIG_DIR, JSON_CONFIG_FILE);

		if (existsSync(projectPath)) {
			try {
				const projectContent = readFileSync(projectPath, "utf-8");
				const projectConfig = JSON.parse(projectContent) as Partial<OcConfig>;
				config = mergeConfigs(config, projectConfig);
			} catch (error) {
				console.warn(
					`[oc] Warning: Could not parse project config at '${projectPath}'. Using global config. Error: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}
	} catch {
		// Not in a git repo, use global only
	}

	return config;
}

export async function updateGlobalConfig(
	updates: Partial<OcConfig>,
): Promise<void> {
	const globalDir = ensureGlobalConfigDir();
	const globalPath = join(globalDir, JSON_CONFIG_FILE);

	let existing: OcConfig = {};
	if (existsSync(globalPath)) {
		try {
			const content = readFileSync(globalPath, "utf-8");
			existing = JSON.parse(content) as OcConfig;
		} catch {
			// Use empty if parse fails
		}
	}

	const merged = mergeConfigs(existing, updates);
	writeFileSync(globalPath, JSON.stringify(merged, null, 2), "utf-8");
}
