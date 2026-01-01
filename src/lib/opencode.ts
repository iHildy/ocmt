import { exec } from "node:child_process";
import { promisify } from "node:util";
import * as p from "@clack/prompts";
import {
	createOpencode,
	createOpencodeClient,
	type AssistantMessage,
	type OpencodeClient,
	type Part,
	type TextPart,
} from "@opencode-ai/sdk";
import color from "picocolors";
import {
	getBranchConfig,
	getChangelogConfig,
	getCommitConfig,
	getConfig,
	getPRConfig,
} from "./config";

const execAsync = promisify(exec);

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

// Server state
let clientInstance: OpencodeClient | null = null;
let serverInstance: { close: () => void } | null = null;
const DEFAULT_OPENCODE_URL = "http://localhost:4096";

export interface CommitGenerationOptions {
	diff: string;
	context?: string;
	modelOverride?: string;
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
	modelOverride?: string;
}

export interface PRGenerationOptions {
	diff: string;
	commits: Array<{ hash: string; message: string }>;
	targetBranch: string;
	sourceBranch: string;
	context?: string;
}

export interface PRContent {
	title: string;
	body: string;
}

export interface UpdateChangelogOptions {
	newChangelog: string;
	existingChangelog: string;
}

async function isOpencodeInstalled(): Promise<boolean> {
	try {
		await execAsync("which opencode");
		return true;
	} catch {
		return false;
	}
}

async function checkAuth(client: OpencodeClient): Promise<boolean> {
	try {
		const config = await client.config.get();
		return !!config;
	} catch {
		return false;
	}
}

async function getClient(): Promise<OpencodeClient> {
	if (clientInstance) {
		return clientInstance;
	}

	const envBaseUrl =
		process.env.OPENCODE_SERVER_URL || process.env.OPENCODE_URL;
	if (envBaseUrl?.trim()) {
		try {
			const client = createOpencodeClient({
				baseUrl: envBaseUrl.trim(),
			});
			await client.config.get();
			clientInstance = client;
			return client;
		} catch {
			p.log.warn(
				`Failed to connect to OpenCode server at ${envBaseUrl}. Falling back to local server.`,
			);
		}
	}

	// Try connecting to existing server first
	try {
		const client = createOpencodeClient({
			baseUrl: DEFAULT_OPENCODE_URL,
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
			`Install it with: ${color.cyan("npm install -g opencode")} or ${color.cyan("brew install sst/tap/opencode")}`,
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
	} catch (error) {
		p.log.error(
			`Failed to start OpenCode server: ${error instanceof Error ? error.message : String(error)}`,
		);
		p.log.info(`Make sure OpenCode is installed and configured correctly`);
		process.exit(1);
	}
}

function extractTextFromParts(parts: Part[]): string {
	const textParts = parts
		.filter((part): part is TextPart => part.type === "text")
		.map((part) => part.text)
		.join("");

	return textParts.trim();
}

function isAssistantMessageComplete(message: AssistantMessage): boolean {
	return message.time.completed !== undefined;
}

async function waitForAssistantMessage(
	client: OpencodeClient,
	sessionID: string,
): Promise<{ assistantMessage: AssistantMessage; parts: Part[] }> {
	for (;;) {
		const messages = await client.session.messages({ path: { id: sessionID } });
		const lastMessage = messages.data?.[messages.data.length - 1];
		if (lastMessage?.info.role === "assistant") {
			const assistantMessage = lastMessage.info as AssistantMessage;
			if (isAssistantMessageComplete(assistantMessage)) {
				return {
					assistantMessage,
					parts: lastMessage.parts ?? [],
				};
			}
		}
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
}

interface OpencodePromptOptions {
	title: string;
	prompt: string;
	model: ModelConfig;
	agent?: string;
	tools?: Record<string, boolean>;
	directory?: string;
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
	const { title, prompt, model, agent, tools, directory } = options;
	const client = await getClient();
	const modelID = formatModelID(model);

	const session = await client.session.create({
		body: { title },
	});

	if (!session.data) {
		throw new Error("Failed to create session");
	}

	const sessionID = session.data.id;

	let closed = false;
	const close = async (): Promise<void> => {
		if (closed) {
			return;
		}
		closed = true;
		try {
			await client.session.delete({ path: { id: sessionID } });
		} catch {
			// Ignore cleanup errors
		}
	};

	try {
		await client.session.promptAsync({
			path: { id: sessionID },
			...(directory ? { query: { directory } } : {}),
			body: {
				model,
				parts: [{ type: "text", text: prompt }],
				...(agent ? { agent } : {}),
				...(tools ? { tools } : {}),
			},
		});

		const result = await waitForAssistantMessage(client, sessionID);

		const message = extractTextFromParts(result.parts);

		if (!message) {
			await close();
			throw new Error(
				`No response generated by ${modelID}. Response: ${JSON.stringify(result.assistantMessage)}`,
			);
		}

		return {
			message,
			sessionID,
			messageID: result.assistantMessage.id,
			close,
		};
	} catch (err) {
		await close();
		throw new Error(
			`Model request failed (${modelID}): ${err instanceof Error ? err.message : String(err)}`,
		);
	}
}

async function runCommitPrompt(
	title: string,
	prompt: string,
	modelOverride?: ModelConfig,
): Promise<string> {
	const commitModel = modelOverride ?? (await getCommitModel());
	const { message, close } = await runOpencodePrompt({
		title,
		prompt,
		model: commitModel,
	});

	await close();
	return message
		.replace(/^```[\s\S]*?\n/, "")
		.replace(/\n```$/, "")
		.trim();
}

export async function generateCommitMessage(
	options: CommitGenerationOptions,
): Promise<string> {
	const { diff, context, modelOverride } = options;

	const systemPrompt = await getCommitConfig();

	// Build the prompt
	let prompt = `${systemPrompt}\n\n---\n\nGenerate a commit message for the following diff:\n\n\`\`\`diff\n${diff}\n\`\`\``;

	if (context) {
		prompt += `\n\nAdditional context: ${context}`;
	}

	// Use model override if provided
	const model = modelOverride ? parseModelString(modelOverride) : undefined;
	return runCommitPrompt("oc-commit", prompt, model);
}

export async function generateBranchName(
	options: BranchGenerationOptions,
): Promise<string> {
	const { diff, context } = options;

	const systemPrompt = await getBranchConfig();

	let prompt = `${systemPrompt}\n\n---\n\nGenerate a branch name for the following diff.\n\nDiff:\n\`\`\`diff\n${diff}\n\`\`\``;

	if (context) {
		prompt += `\n\nAdditional context: ${context}`;
	}

	const branchModel = await getBranchModel();
	return runCommitPrompt("oc-branch", prompt, branchModel);
}

function parsePRContent(response: string): PRContent {
	const titleMatch = response.match(/TITLE:\s*(.+?)(?:\n|$)/i);
	const bodyMatch = response.match(/BODY:\s*([\s\S]+)$/i);

	const title = titleMatch?.[1]?.trim() || "Update";
	let body = bodyMatch?.[1]?.trim() || response.trim();

	// Clean up markdown code blocks if present
	body = body
		.replace(/^```markdown\n?/i, "")
		.replace(/^```\n?/, "")
		.replace(/\n?```$/, "")
		.trim();

	return { title, body };
}

export async function generatePRContent(
	options: PRGenerationOptions,
): Promise<PRContent> {
	const { diff, commits, targetBranch, sourceBranch, context } = options;

	const systemPrompt = await getPRConfig();
	const prModel = await getPRModel();

	// Build commits list
	const commitsList = commits
		.map((c) => `- ${c.hash}: ${c.message}`)
		.join("\n");

	// Build the prompt
	let prompt = `${systemPrompt}\n\n---\n\nGenerate a pull request title and description for merging "${sourceBranch}" into "${targetBranch}".\n\n`;

	if (commits.length > 0) {
		prompt += `## Commits\n\n${commitsList}\n\n`;
	}

	prompt += `## Diff\n\n\`\`\`diff\n${diff}\n\`\`\``;

	if (context) {
		prompt += `\n\nAdditional context:\n${context}`;
	}

	const { message, close } = await runOpencodePrompt({
		title: "oc-pr",
		prompt,
		model: prModel,
	});
	await close();

	return parsePRContent(message);
}

export async function generateChangelog(
	options: ChangelogGenerationOptions,
): Promise<string> {
	const { commits, fromRef, toRef, version, modelOverride } = options;
	const systemPrompt = await getChangelogConfig();
	const changelogModel = modelOverride
		? parseModelString(modelOverride)
		: await getChangelogModel();

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
	const { newChangelog, existingChangelog } = options;
	const changelogModel = await getChangelogModel();

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

	const { message, close } = await runOpencodePrompt({
		title: "oc-changelog-update",
		prompt,
		model: changelogModel,
	});
	await close();

	let updatedChangelog = message;

	// Clean up markdown code blocks if present
	updatedChangelog = updatedChangelog
		.replace(/^```markdown\n?/i, "")
		.replace(/^```\n?/, "")
		.replace(/\n?```$/, "")
		.trim();

	return updatedChangelog;
}

export function cleanup(): void {
	serverInstance?.close();
	serverInstance = null;
	clientInstance = null;
}
