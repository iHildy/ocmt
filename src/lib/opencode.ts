/**
 * OpenCode AI client for generating commit messages and changelogs
 *
 * Integrates with opencode.ai SDK for AI inference
 */

import * as p from "@clack/prompts";
import color from "picocolors";
import {
  createOpencode,
  createOpencodeClient,
  type OpencodeClient,
} from "@opencode-ai/sdk";
import { exec } from "child_process";
import { promisify } from "util";
import { getCommitConfig, getChangelogConfig, getConfig } from "./config";

const execAsync = promisify(exec);

// Default models (used as fallback)
const DEFAULT_COMMIT_MODEL = "opencode/gpt-5-nano";
const DEFAULT_CHANGELOG_MODEL = "opencode/claude-sonnet-4-5";

interface ModelConfig {
  providerID: string;
  modelID: string;
}

/**
 * Parse a model string in "provider/model" format
 * Falls back to "opencode" provider if no slash is present
 */
function parseModelString(modelStr: string): ModelConfig {
  // Validate input is not empty
  const trimmedInput = modelStr.trim();
  if (!trimmedInput) {
    throw new Error(
      "Invalid model string: expected 'provider/model' with non-empty parts"
    );
  }

  const slashIndex = trimmedInput.indexOf("/");
  if (slashIndex !== -1) {
    const providerID = trimmedInput.substring(0, slashIndex).trim();
    const modelID = trimmedInput.substring(slashIndex + 1).trim();

    // Validate both parts are non-empty
    if (!providerID || !modelID) {
      throw new Error(
        "Invalid model string: expected 'provider/model' with non-empty parts"
      );
    }

    return { providerID, modelID };
  }

  // Default to "opencode" provider if no slash
  return { providerID: "opencode", modelID: trimmedInput };
}

/**
 * Get the model config for commit generation from user config
 */
async function getCommitModel(): Promise<ModelConfig> {
  const config = await getConfig();
  const modelStr = config.commit?.model || DEFAULT_COMMIT_MODEL;
  return parseModelString(modelStr);
}

/**
 * Get the model config for changelog generation from user config
 */
async function getChangelogModel(): Promise<ModelConfig> {
  const config = await getConfig();
  const modelStr = config.changelog?.model || DEFAULT_CHANGELOG_MODEL;
  return parseModelString(modelStr);
}

// Server state
let clientInstance: OpencodeClient | null = null;
let serverInstance: { close: () => void } | null = null;

export interface CommitGenerationOptions {
  diff: string;
  context?: string;
}

export interface BranchGenerationOptions {
  diff: string;
  context?: string;
}

export interface ChangelogGenerationOptions {
  commits: Array<{ hash: string; message: string }>;
  diff?: string;
  fromRef: string;
  toRef: string;
  version?: string | null;
}

export interface UpdateChangelogOptions {
  newChangelog: string;
  existingChangelog: string;
  changelogPath: string;
}

/**
 * Check if opencode CLI is installed
 */
async function isOpencodeInstalled(): Promise<boolean> {
  try {
    await execAsync("which opencode");
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if user is authenticated with opencode
 */
async function checkAuth(client: OpencodeClient): Promise<boolean> {
  try {
    const config = await client.config.get();
    return !!config;
  } catch {
    return false;
  }
}

/**
 * Get or create the OpenCode client
 * Tries to connect to existing server first, spawns new one if needed
 */
async function getClient(): Promise<OpencodeClient> {
  if (clientInstance) {
    return clientInstance;
  }

  // Try connecting to existing server first
  try {
    const client = createOpencodeClient({
      baseUrl: "http://localhost:4096",
    });
    // Test connection
    await client.config.get();
    clientInstance = client;
    return client;
  } catch {
    // No existing server, need to spawn one
  }

  // Check if opencode is installed
  if (!(await isOpencodeInstalled())) {
    p.log.error("OpenCode CLI is not installed");
    p.log.info(
      `Install it with: ${color.cyan("npm install -g opencode")} or ${color.cyan("brew install sst/tap/opencode")}`
    );
    process.exit(1);
  }

  // Spawn new server
  try {
    const opencode = await createOpencode({
      timeout: 10000,
    });

    clientInstance = opencode.client;
    serverInstance = opencode.server;

    // Check authentication
    if (!(await checkAuth(opencode.client))) {
      p.log.warn("Not authenticated with OpenCode");
      p.log.info(`Run ${color.cyan("opencode auth")} to authenticate`);
      process.exit(1);
    }

    // Clean up server on process exit
    process.on("exit", () => {
      serverInstance?.close();
    });
    process.on("SIGINT", () => {
      serverInstance?.close();
      process.exit(0);
    });
    process.on("SIGTERM", () => {
      serverInstance?.close();
      process.exit(0);
    });

    return opencode.client;
  } catch (error: any) {
    p.log.error(`Failed to start OpenCode server: ${error.message}`);
    p.log.info(`Make sure OpenCode is installed and configured correctly`);
    process.exit(1);
  }
}

/**
 * Extract text content from AI response parts
 */
function extractTextFromParts(parts: any[]): string {
  const textParts = parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("");

  return textParts.trim();
}

/**
 * Run a prompt using the commit model
 */
async function runCommitPrompt(title: string, prompt: string): Promise<string> {
  const client = await getClient();
  const commitModel = await getCommitModel();

  const session = await client.session.create({
    body: { title },
  });

  if (!session.data) {
    throw new Error("Failed to create session");
  }

  let result;
  try {
    result = await client.session.prompt({
      path: { id: session.data.id },
      body: {
        model: commitModel,
        parts: [{ type: "text", text: prompt }],
      },
    });
  } catch (err: any) {
    await client.session.delete({ path: { id: session.data.id } });
    throw new Error(
      `Model request failed (${commitModel.providerID}/${commitModel.modelID}): ${err.message}`
    );
  }

  if (!result.data) {
    await client.session.delete({ path: { id: session.data.id } });
    throw new Error(
      `Failed to get AI response from ${commitModel.providerID}/${commitModel.modelID}`
    );
  }

  const message = extractTextFromParts(result.data.parts || []);

  await client.session.delete({ path: { id: session.data.id } });

  if (!message) {
    throw new Error(
      `No response generated by ${commitModel.providerID}/${commitModel.modelID}. Response: ${JSON.stringify(result.data)}`
    );
  }

  return message
    .replace(/^```[\s\S]*?\n/, "")
    .replace(/\n```$/, "")
    .trim();
}

/**
 * Generate a commit message from a git diff using OpenCode AI
 */
export async function generateCommitMessage(
  options: CommitGenerationOptions
): Promise<string> {
  const { diff, context } = options;

  const systemPrompt = await getCommitConfig();

  // Build the prompt
  let prompt = `${systemPrompt}\n\n---\n\nGenerate a commit message for the following diff:\n\n\`\`\`diff\n${diff}\n\`\`\``;

  if (context) {
    prompt += `\n\nAdditional context: ${context}`;
  }

  return runCommitPrompt("oc-commit", prompt);
}

/**
 * Generate a branch name from a git diff using OpenCode AI
 */
export async function generateBranchName(
  options: BranchGenerationOptions
): Promise<string> {
  const { diff, context } = options;

  const systemPrompt = await getCommitConfig();

  let prompt = `${systemPrompt}\n\n---\n\nGenerate a concise git branch name for the following diff.\n\nRules:\n- Use lowercase letters\n- Use hyphens to separate words\n- Optional prefix like "feat/" or "fix/"\n- No spaces, quotes, or markdown\n- Keep it under 50 characters\n\nDiff:\n\`\`\`diff\n${diff}\n\`\`\``;

  if (context) {
    prompt += `\n\nAdditional context: ${context}`;
  }

  return runCommitPrompt("oc-branch", prompt);
}

/**
 * Generate a changelog from commits using OpenCode AI
 */
export async function generateChangelog(
  options: ChangelogGenerationOptions
): Promise<string> {
  const { commits, fromRef, toRef, version } = options;

  const client = await getClient();
  const systemPrompt = await getChangelogConfig();
  const changelogModel = await getChangelogModel();

  // Create a session for this changelog
  const session = await client.session.create({
    body: { title: "oc-changelog" },
  });

  if (!session.data) {
    throw new Error("Failed to create session");
  }

  // Build the commits list
  const commitsList = commits
    .map((c) => `- ${c.hash}: ${c.message}`)
    .join("\n");

  // Build version instruction
  let versionInstruction = "";
  if (version) {
    versionInstruction = `\n\nIMPORTANT: A version bump to ${version} was detected. Use "[${version}]" as the version header with today's date (format: YYYY-MM-DD), NOT "[Unreleased]".`;
  } else {
    versionInstruction = `\n\nUse "[Unreleased]" as the version header since no version bump was detected.`;
  }

  // Build the prompt
  const prompt = `${systemPrompt}\n\n---\n\nGenerate a changelog for the following commits (from ${fromRef} to ${toRef}):${versionInstruction}\n\n${commitsList}`;

  // Send the prompt
  const result = await client.session.prompt({
    path: { id: session.data.id },
    body: {
      model: changelogModel,
      parts: [{ type: "text", text: prompt }],
    },
  });

  if (!result.data) {
    throw new Error("Failed to get AI response");
  }

  // Extract the changelog from the response
  const changelog = extractTextFromParts(result.data.parts || []);

  // Clean up session
  await client.session.delete({ path: { id: session.data.id } });

  if (!changelog) {
    throw new Error("No changelog generated");
  }

  return changelog.trim();
}

/**
 * Update an existing CHANGELOG.md file intelligently using AI
 * The AI will merge the new changelog content with existing content properly
 */
export async function updateChangelogFile(
  options: UpdateChangelogOptions
): Promise<string> {
  const { newChangelog, existingChangelog, changelogPath } = options;

  const client = await getClient();
  const changelogModel = await getChangelogModel();

  // Create a session for this update
  const session = await client.session.create({
    body: { title: "oc-changelog-update" },
  });

  if (!session.data) {
    throw new Error("Failed to create session");
  }

  const prompt = `You are updating a CHANGELOG.md file. Your task is to intelligently merge new changelog entries into the existing file.

## Rules:
1. Preserve the existing file structure and header
2. Add the new changelog entry in the correct position (newest entries at the top, after the header)
3. Do not duplicate entries - if similar entries exist, keep the most detailed version
4. Maintain consistent formatting with the existing file
5. Keep the "Keep a Changelog" format if that's what the file uses
6. If there's an existing [Unreleased] section, merge into it or replace it with the new content
7. Return ONLY the complete updated file content, no explanations

## Existing CHANGELOG.md:
\`\`\`markdown
${existingChangelog}
\`\`\`

## New changelog entry to add:
\`\`\`markdown
${newChangelog}
\`\`\`

Return the complete updated CHANGELOG.md content:`;

  // Send the prompt
  const result = await client.session.prompt({
    path: { id: session.data.id },
    body: {
      model: changelogModel,
      parts: [{ type: "text", text: prompt }],
    },
  });

  if (!result.data) {
    throw new Error("Failed to get AI response");
  }

  // Extract the updated changelog
  let updatedChangelog = extractTextFromParts(result.data.parts || []);

  // Clean up session
  await client.session.delete({ path: { id: session.data.id } });

  if (!updatedChangelog) {
    throw new Error("No updated changelog generated");
  }

  // Clean up markdown code blocks if present
  updatedChangelog = updatedChangelog
    .replace(/^```markdown\n?/i, "")
    .replace(/^```\n?/, "")
    .replace(/\n?```$/, "")
    .trim();

  return updatedChangelog;
}

/**
 * Cleanup function to close the server if we spawned one
 */
export function cleanup(): void {
  serverInstance?.close();
  serverInstance = null;
  clientInstance = null;
}
