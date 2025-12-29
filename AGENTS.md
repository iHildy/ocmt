# AGENTS.md - Instructions for AI Coding Agents

Guidelines for AI coding agents working in the ocmt codebase.

## Project Overview

ocmt (OpenCommit) is an AI-powered git commit message, changelog, and PR generator using [opencode.ai](https://opencode.ai). TypeScript CLI built with Bun.

## Build & Development Commands

**IMPORTANT: Always use `bun`, not `npm` or `yarn`. This project requires Bun.**

```bash
bun install          # Install dependencies
bun run dev          # Development mode (watch)
bun run typecheck    # Type checking
bun run build        # Build for production
```

### After Making Changes

**CRITICAL: After modifying any code related to core project functionality, always run and fix any warnings or errors in a feedback loop following best practices:**

```bash
bun run typecheck && bun run build
```

There are no automated tests. The typecheck catches most issues.

### Testing CLI Commands (Non-Interactive Mode)

**IMPORTANT: Always perform integration testing for CLI commands inside the `test-repo/` directory. This is a private, git-ignored sandbox repository specifically for this purpose.**

If you need to add "slop" to the test repo to a command like this: `cd test-repo && opencode run "create a new pointless typescript file with Extra defensive checks or try/catch blocks that are abnormal for that area of the codebase (especially if called by trusted / validated codepaths" --model opencode/grok-code` and then run CLI non-interactive commands (after running `bun run build`) inside the test-repo like `bun run start --deslop yes`

Use these flags to test CLI functionality without interactive prompts:

```bash
# Commit with all defaults (stages all, skips prompts, silent)
bun run dev -- -ay --deslop no --skip-branch --silent

# Generate changelog non-interactively and silently
bun run dev -- changelog --from v1.0.0 --save -y -s

# Create PR non-interactively
bun run dev -- pr -y --title "Test PR" --body "Description" -b main --silent
```

## Project Structure

```
src/
  cli.ts              # Main CLI entry (Commander setup)
  index.ts            # Public exports
  commands/           # CLI command implementations
  lib/                # Core business logic
  utils/git.ts        # Git command wrappers
```

## Code Style Guidelines

### TypeScript Configuration

- Target: ES2022 with ESNext modules, strict mode enabled
- Uses Bun types (`bun-types`)
- `verbatimModuleSyntax: true` - use `import type` for type-only imports

### Import Style

```typescript
// External packages first
import * as p from "@clack/prompts";
import color from "picocolors";

// Internal imports
import { isGitRepo, type GitStatus } from "../utils/git";
import { generateCommitMessage, cleanup } from "../lib/opencode";
import { createSpinner } from "../utils/ui";
```

### Naming Conventions

- **Functions/variables**: camelCase (`getConfig`, `commitMessage`)
- **Interfaces/Types**: PascalCase (`CommitOptions`, `GitStatus`)
- **Constants**: SCREAMING_SNAKE_CASE (`DEFAULT_COMMIT_MODEL`)
- **Files**: kebab-case (`git.ts`, `opencode.ts`)

### Function Signatures

Use `async function` for top-level async. Explicit return types for exports:

```typescript
export async function commitCommand(options: CommitOptions): Promise<void> {
  // ...
}
```

### Error Handling

```typescript
// Error message extraction
error instanceof Error ? error.message : String(error)

// User-facing errors in CLI
p.cancel(error instanceof Error ? error.message : String(error));
cleanup();
process.exit(1);

// Programmatic errors
throw new Error(`Git command failed: ${error instanceof Error ? error.message : String(error)}`);
```

### Async Operations with Spinners

```typescript
import { createSpinner } from "../utils/ui";

const s = createSpinner();
s.start("Generating commit message");
try {
  const result = await generateCommitMessage({ diff });
  s.stop("Commit message generated");
} catch (error) {
  s.stop("Failed to generate commit message");
  p.cancel(error instanceof Error ? error.message : String(error));
  cleanup();
  process.exit(1);
}
```

### Terminal Colors

```typescript
import color from "picocolors";

color.green("+")     // Success
color.yellow("...")  // Warnings
color.dim("...")     // Secondary info
color.cyan("...")    // Commands/links
color.bgCyan(color.black(" text "))  // Headers
```

### Git Operations

All git operations go through `src/utils/git.ts`:

```typescript
import { git, getStatus, getStagedDiff } from "../utils/git";

const output = await git("status --porcelain");
const status = await getStatus();
```

### Empty Catch Blocks

When intentionally ignoring errors, use empty catch with no variable:

```typescript
try {
  await someOperation();
} catch {
  // Intentionally ignored
}
```

### Cleanup Pattern

Always call `cleanup()` before exiting:

```typescript
cleanup();
process.exit(0);
```

### Type Guards

```typescript
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
```

## Dependencies

- `@clack/prompts` - Interactive CLI prompts
- `commander` - CLI argument parsing
- `picocolors` - Terminal colors
- `@opencode-ai/sdk` - OpenCode API client
- `critique` - Deslop review tool (Bun-only)

## Configuration

Layered config: `~/.oc/` (global) and `<repo>/.oc/` (project).

- `config.json` - Settings (models, behavior)
- `config.md` - Commit message rules
- `changelog.md` - Changelog format rules
- `pr.md` - PR generation rules
