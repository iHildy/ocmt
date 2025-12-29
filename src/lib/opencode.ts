import {
  runOpencodeCliPrompt,
  type CliAttachment,
  cleanup as cleanupCli,
} from "./opencode-cli";
import {
  getCommitConfig,
  getChangelogConfig,
  getPRConfig,
  getConfig,
  getDeslopConfig,
} from "./config";

// Default models (used as fallback)
const DEFAULT_COMMIT_MODEL = "opencode/gpt-5-nano";
const DEFAULT_CHANGELOG_MODEL = "opencode/claude-sonnet-4-5";

interface ModelConfig {
  providerID: string;
  modelID: string;
}

function parseModelString(modelStr: string): ModelConfig {
  const trimmedInput = modelStr.trim();
  if (!trimmedInput) {
    throw new Error(
      "Invalid model string: expected 'provider/model' with non-empty parts",
    );
  }

  const slashIndex = trimmedInput.indexOf("/");
  if (slashIndex !== -1) {
    const providerID = trimmedInput.substring(0, slashIndex).trim();
    const modelID = trimmedInput.substring(slashIndex + 1).trim();

    if (!providerID || !modelID) {
      throw new Error(
        "Invalid model string: expected 'provider/model' with non-empty parts",
      );
    }

    return { providerID, modelID };
  }

  return { providerID: "opencode", modelID: trimmedInput };
}

function formatModelID(model: ModelConfig): string {
  return `${model.providerID}/${model.modelID}`;
}

async function getCommitModel(): Promise<ModelConfig> {
  const config = await getConfig();
  const modelStr = config.commit?.model || DEFAULT_COMMIT_MODEL;
  return parseModelString(modelStr);
}

async function getBranchModel(): Promise<ModelConfig> {
  const config = await getConfig();
  const modelStr =
    config.commit?.branchModel || config.commit?.model || DEFAULT_COMMIT_MODEL;
  return parseModelString(modelStr);
}

async function getDeslopModel(): Promise<ModelConfig> {
  const config = await getConfig();
  const modelStr =
    config.commit?.deslopModel || config.commit?.model || DEFAULT_COMMIT_MODEL;
  return parseModelString(modelStr);
}

async function getChangelogModel(): Promise<ModelConfig> {
  const config = await getConfig();
  const modelStr = config.changelog?.model || DEFAULT_CHANGELOG_MODEL;
  return parseModelString(modelStr);
}

async function getPRModel(): Promise<ModelConfig> {
  const config = await getConfig();
  const modelStr =
    config.pr?.model || config.commit?.model || DEFAULT_COMMIT_MODEL;
  return parseModelString(modelStr);
}


export interface CommitGenerationOptions {
  diff: string;
  context?: string;
}

export interface BranchGenerationOptions {
  diff: string;
  context?: string;
}

export interface DeslopGenerationOptions {
  stagedDiff: string;
  baseDiff?: string;
  baseRef?: string;
  extraPrompt?: string;
  stagedFiles?: string[];
  notStagedFiles?: string[];
}

export interface DeslopEditResult {
  summary: string | null;
  sessionID: string;
  messageID: string;
  close: () => Promise<void>;
}

export interface ChangelogGenerationOptions {
  commits: Array<{ hash: string; message: string }>;
  diff?: string;
  fromRef: string;
  toRef: string;
  version?: string | null;
}

export interface PRGenerationOptions {
  diff: string;
  commits: Array<{ hash: string; message: string }>;
  targetBranch: string;
  sourceBranch: string;
}

export interface PRContent {
  title: string;
  body: string;
}

export interface UpdateChangelogOptions {
  newChangelog: string;
  existingChangelog: string;
  changelogPath: string;
}

function extractDeslopSummary(text: string): string | null {
  const summaryMatch = text.match(/SUMMARY:\s*([\s\S]*)$/i);
  return summaryMatch ? summaryMatch[1].trim() : null;
}

function stripMarkdown(text: string): string {
  return text
    .replace(/^```(markdown)?\n?/i, "")
    .replace(/\n?```$/, "")
    .trim();
}

function mergePermissions(
  existing: string | undefined,
  required: string[],
): string {
  const seen = new Set<string>();
  const result: string[] = [];
  const add = (value: string): void => {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) {
      return;
    }
    seen.add(trimmed);
    result.push(trimmed);
  };

  for (const value of (existing ?? "").split(/[,\s]+/)) {
    add(value);
  }
  for (const value of required) {
    add(value);
  }

  return result.join(",");
}

interface OpencodePromptOptions {
  title: string;
  prompt: string;
  model: ModelConfig;
  agent?: string;
  directory?: string;
  files?: CliAttachment[];
  env?: NodeJS.ProcessEnv;
}

interface OpencodePromptResult {
  message: string;
  sessionID: string;
  messageID: string;
  close: () => Promise<void>;
}

async function runOpencodePrompt(
  options: OpencodePromptOptions,
): Promise<OpencodePromptResult> {
  const { title, prompt, model, agent, directory, files, env } = options;
  const modelID = formatModelID(model);
  let result;
  try {
    result = await runOpencodeCliPrompt({
      title,
      prompt,
      model: modelID,
      agent,
      directory: directory ?? process.cwd(),
      files,
      env,
    });
  } catch (err) {
    throw new Error(
      `Model request failed (${modelID}): ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const message = result.message.trim();
  if (!message) {
    throw new Error(`Failed to get AI response from ${modelID}`);
  }

  return {
    message,
    sessionID: result.sessionID ?? "unknown",
    messageID: result.messageID ?? "unknown",
    close: async () => {},
  };
}

function buildDeslopPrompt(
  basePrompt: string,
  options: DeslopGenerationOptions,
  files: { baseDiffFile: string; stagedDiffFile: string },
): string {
  const { baseRef = "main", extraPrompt, stagedFiles, notStagedFiles } =
    options;
  const { baseDiffFile, stagedDiffFile } = files;
  const filesList =
    stagedFiles && stagedFiles.length > 0
      ? stagedFiles.map((file) => `- ${file}`).join("\n")
      : "";
  const notStagedList =
    notStagedFiles && notStagedFiles.length > 0
      ? notStagedFiles.map((file) => `- ${file}`).join("\n")
      : "";

  const sections: string[] = [];
  if (filesList) {
    sections.push(`Staged files:\n${filesList}`);
  }
  if (notStagedList) {
    sections.push(`Not staged files:\n${notStagedList}`);
  }

  sections.push(
    `Diff against ${baseRef} is attached (${baseDiffFile}).\n\nStaged diff to clean up is attached (${stagedDiffFile}).`,
  );

  if (extraPrompt?.trim()) {
    sections.push(
      `Additional constraints from the user:\n${extraPrompt.trim()}`,
    );
  }

  return [basePrompt.trim(), ...sections]
    .filter((section) => section.length > 0)
    .join("\n\n");
}

export async function runDeslopEdits(
  options: DeslopGenerationOptions,
): Promise<DeslopEditResult> {
  const deslopModel = await getDeslopModel();
  const deslopPrompt = await getDeslopConfig();
  const files: CliAttachment[] = [
    { filename: "base.diff", content: options.baseDiff ?? "" },
    { filename: "staged.diff", content: options.stagedDiff },
  ];
  const prompt = buildDeslopPrompt(deslopPrompt, options, {
    baseDiffFile: "base.diff",
    stagedDiffFile: "staged.diff",
  });
  const permission = mergePermissions(
    process.env.OPENCODE_PERMISSION,
    ["edit", "bash"],
  );

  const { message, sessionID, messageID, close } = await runOpencodePrompt({
    title: "oc-deslop",
    prompt,
    model: deslopModel,
    directory: process.cwd(),
    files,
    env: { ...process.env, OPENCODE_PERMISSION: permission },
  });
  const summary = extractDeslopSummary(message);

  return {
    summary,
    sessionID,
    messageID,
    close,
  };
}

async function runCommitPrompt(
  title: string,
  prompt: string,
  modelOverride?: ModelConfig,
  files?: CliAttachment[],
): Promise<string> {
  const commitModel = modelOverride ?? (await getCommitModel());
  const { message, close } = await runOpencodePrompt({
    title,
    prompt,
    model: commitModel,
    files,
  });

  await close();
  return stripMarkdown(message);
}

export async function generateCommitMessage(
  options: CommitGenerationOptions,
): Promise<string> {
  const { diff, context } = options;

  const systemPrompt = await getCommitConfig();
  const diffFile: CliAttachment = { filename: "commit.diff", content: diff };

  // Build the prompt
  let prompt = `${systemPrompt}\n\n---\n\nGenerate a commit message for the diff in the attached file "commit.diff".`;

  if (context) {
    prompt += `\n\nAdditional context: ${context}`;
  }

  return runCommitPrompt("oc-commit", prompt, undefined, [diffFile]);
}

export async function generateBranchName(
  options: BranchGenerationOptions,
): Promise<string> {
  const { diff, context } = options;

  const systemPrompt = await getCommitConfig();
  const diffFile: CliAttachment = { filename: "branch.diff", content: diff };

  let prompt = `${systemPrompt}\n\n---\n\nGenerate a concise git branch name for the diff in the attached file "branch.diff".\n\nRules:\n- Use lowercase letters\n- Use hyphens to separate words\n- Optional prefix like "feat/" or "fix/"\n- No spaces, quotes, or markdown\n- Keep it under 50 characters`;

  if (context) {
    prompt += `\n\nAdditional context: ${context}`;
  }

  const branchModel = await getBranchModel();
  return runCommitPrompt("oc-branch", prompt, branchModel, [diffFile]);
}

function parsePRContent(response: string): PRContent {
  const titleMatch = response.match(/TITLE:\s*(.+?)(?:\n|$)/i);
  const bodyMatch = response.match(/BODY:\s*([\s\S]+)$/i);

  const title = titleMatch?.[1]?.trim() || "Update";
  const body = stripMarkdown(bodyMatch?.[1] || response);

  return { title, body };
}

export async function generatePRContent(
  options: PRGenerationOptions,
): Promise<PRContent> {
  const { diff, commits, targetBranch, sourceBranch } = options;

  const systemPrompt = await getPRConfig();
  const prModel = await getPRModel();
  const diffFile: CliAttachment = { filename: "pr.diff", content: diff };

  // Build commits list
  const commitsList = commits
    .map((c) => `- ${c.hash}: ${c.message}`)
    .join("\n");

  // Build the prompt
  let prompt = `${systemPrompt}\n\n---\n\nGenerate a pull request title and description for merging "${sourceBranch}" into "${targetBranch}".\n\n`;

  if (commits.length > 0) {
    prompt += `## Commits\n\n${commitsList}\n\n`;
  }

  prompt += `## Diff\n\nSee attached file: pr.diff`;

  const { message, close } = await runOpencodePrompt({
    title: "oc-pr",
    prompt,
    model: prModel,
    files: [diffFile],
  });
  await close();

  return parsePRContent(message);
}

export async function generateChangelog(
  options: ChangelogGenerationOptions,
): Promise<string> {
  const { commits, fromRef, toRef, version } = options;
  const systemPrompt = await getChangelogConfig();
  const changelogModel = await getChangelogModel();

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

  const { message, close } = await runOpencodePrompt({
    title: "oc-changelog",
    prompt,
    model: changelogModel,
  });
  await close();

  return message.trim();
}

export async function updateChangelogFile(
  options: UpdateChangelogOptions,
): Promise<string> {
  const { newChangelog, existingChangelog, changelogPath } = options;
  const changelogModel = await getChangelogModel();
  const files: CliAttachment[] = [
    { filename: "existing-changelog.md", content: existingChangelog },
    { filename: "new-changelog.md", content: newChangelog },
  ];

  const prompt = `You are updating a CHANGELOG.md file (${changelogPath}). Your task is to intelligently merge new changelog entries into the existing file.

## Rules:
1. Preserve the existing file structure and header
2. Add the new changelog entry in the correct position (newest entries at the top, after the header)
3. Do not duplicate entries - if similar entries exist, keep the most detailed version
4. Maintain consistent formatting with the existing file
5. Keep the "Keep a Changelog" format if that's what the file uses
6. If there's an existing [Unreleased] section, merge into it or replace it with the new content
7. Return ONLY the complete updated file content, no explanations

## Existing CHANGELOG.md is attached as "existing-changelog.md".

## New changelog entry to add is attached as "new-changelog.md".

Return the complete updated CHANGELOG.md content:`;

  const { message, close } = await runOpencodePrompt({
    title: "oc-changelog-update",
    prompt,
    model: changelogModel,
    files,
  });
  await close();

  return stripMarkdown(message);
}

export function cleanup(): void {
  cleanupCli();
}
