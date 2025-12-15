/**
 * Configuration file management for oc
 *
 * Manages .oc/config.md and .oc/changelog.md in the repo root
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { git } from "../utils/git";

const CONFIG_DIR = ".oc";
const COMMIT_CONFIG_FILE = "config.md";
const CHANGELOG_CONFIG_FILE = "changelog.md";

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

/**
 * Get the git repository root directory
 */
async function getRepoRoot(): Promise<string> {
  const root = await git("rev-parse --show-toplevel");
  return root;
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
 * Get the commit config (creates default if doesn't exist)
 */
export async function getCommitConfig(): Promise<string> {
  const configDir = await ensureConfigDir();
  const configPath = join(configDir, COMMIT_CONFIG_FILE);

  if (!existsSync(configPath)) {
    writeFileSync(configPath, DEFAULT_COMMIT_CONFIG, "utf-8");
  }

  return readFileSync(configPath, "utf-8");
}

/**
 * Get the changelog config (creates default if doesn't exist)
 */
export async function getChangelogConfig(): Promise<string> {
  const configDir = await ensureConfigDir();
  const configPath = join(configDir, CHANGELOG_CONFIG_FILE);

  if (!existsSync(configPath)) {
    writeFileSync(configPath, DEFAULT_CHANGELOG_CONFIG, "utf-8");
  }

  return readFileSync(configPath, "utf-8");
}

/**
 * Check if config files exist
 */
export async function configExists(): Promise<boolean> {
  try {
    const repoRoot = await getRepoRoot();
    const configDir = join(repoRoot, CONFIG_DIR);
    return existsSync(join(configDir, COMMIT_CONFIG_FILE));
  } catch {
    return false;
  }
}
