import { exec } from "node:child_process";
import { promisify } from "node:util";
import * as p from "@clack/prompts";
import {
	createOpencode,
	createOpencodeClient,
	type AssistantMessage,
	type Event,
	type OpencodeClient,
	type Part,
	type Permission,
	type TextPart,
} from "@opencode-ai/sdk";
import color from "picocolors";
import {
	getChangelogConfig,
	getCommitConfig,
	getConfig,
	getPRConfig,
} from "./config";

const execAsync = promisify(exec);

// Default models (used as fallback)
const DEFAULT_COMMIT_MODEL = "opencode/gpt-5-nano";
const DEFAULT_CHANGELOG_MODEL = "opencode/claude-sonnet-4-5";

// Timeout constants
const PERMISSION_PROMPT_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes for user to respond to permission
const OPERATION_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes for overall operation

type PermissionResponse = "once" | "always" | "reject";

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

export interface DeslopGenerationOptions {
	stagedDiff: string;
	baseDiff?: string;
	baseRef?: string;
	extraPrompt?: string;
	stagedFiles?: string[];
	notStagedFiles?: string[];
	spinner?: ReturnType<typeof p.spinner> | null;
	spinnerMessage?: string;
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
	modelOverride?: string;
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

function extractDeslopSummary(text: string): string | null {
	const summaryMatch = text.match(/SUMMARY:\s*([\s\S]*)$/i);
	return summaryMatch ? summaryMatch[1].trim() : null;
}

function formatPermissionDescription(permission: Permission): string {
	const { type, title, pattern, metadata } = permission;

	let description = title || `Permission requested: ${type}`;

	if (type === "bash" || type === "shell") {
		const command =
			pattern ||
			(metadata?.command as string) ||
			(metadata?.cmd as string) ||
			null;
		if (command) {
			const commandStr = Array.isArray(command) ? command.join(" ") : command;
			description = `Run bash command:\n${color.cyan(commandStr)}`;
		}
	} else if (type === "edit" || type === "file") {
		const filePath =
			pattern || (metadata?.path as string) || (metadata?.file as string);
		if (filePath) {
			const pathStr = Array.isArray(filePath) ? filePath.join(", ") : filePath;
			description = `Edit file:\n${color.cyan(pathStr)}`;
		}
	} else if (type === "webfetch") {
		const url = pattern || (metadata?.url as string);
		if (url) {
			const urlStr = Array.isArray(url) ? url.join(", ") : url;
			description = `Fetch URL:\n${color.cyan(urlStr)}`;
		}
	} else if (type === "doom_loop") {
		description = `Doom loop detected (same tool called 3+ times with identical arguments).\nAllow continuation?`;
	} else if (type === "external_directory") {
		const path = pattern || (metadata?.path as string);
		if (path) {
			const pathStr = Array.isArray(path) ? path.join(", ") : path;
			description = `Access file outside working directory:\n${color.cyan(pathStr)}`;
		}
	}

	return description;
}

async function promptUserForPermission(
	permission: Permission,
): Promise<PermissionResponse> {
	const description = formatPermissionDescription(permission);

	const result = await p.select({
		message: description,
		options: [
			{ value: "once", label: "Allow once" },
			{ value: "always", label: "Always allow (this session)" },
			{ value: "reject", label: "Reject" },
		],
	});

	if (p.isCancel(result)) {
		return "reject";
	}

	return result as PermissionResponse;
}

function isEventForSession(event: Event, sessionID: string): boolean {
	if (!("properties" in event)) {
		return false;
	}

	const props = event.properties as Record<string, unknown>;

	if ("sessionID" in props && props.sessionID === sessionID) {
		return true;
	}

	if (
		"info" in props &&
		typeof props.info === "object" &&
		props.info !== null
	) {
		const info = props.info as Record<string, unknown>;
		if ("sessionID" in info && info.sessionID === sessionID) {
			return true;
		}
	}

	if (
		"part" in props &&
		typeof props.part === "object" &&
		props.part !== null
	) {
		const part = props.part as Record<string, unknown>;
		if ("sessionID" in part && part.sessionID === sessionID) {
			return true;
		}
	}

	return false;
}

function isAssistantMessageComplete(message: AssistantMessage): boolean {
	return message.time.completed !== undefined;
}

interface EventStreamResult {
	assistantMessage: AssistantMessage | null;
	parts: Part[];
	error: Error | null;
}

async function processEventStream(
	client: OpencodeClient,
	sessionID: string,
	spinner: ReturnType<typeof p.spinner> | null,
	spinnerMessage: string,
): Promise<EventStreamResult> {
	const collectedParts = new Map<string, Part>();
	let assistantMessage: AssistantMessage | null = null;
	let sessionError: Error | null = null;
	let eventStream: AsyncIterable<Event> | null = null;
	let reconnectAttempted = false;

	const startTime = Date.now();

	const connectToEventStream = async (): Promise<AsyncIterable<Event>> => {
		const response = await client.event.subscribe();
		if (!response.stream) {
			throw new Error("Failed to subscribe to event stream");
		}
		return response.stream;
	};

	try {
		eventStream = await connectToEventStream();
	} catch (err) {
		throw new Error(
			`Failed to connect to event stream: ${err instanceof Error ? err.message : String(err)}`,
		);
	}

	try {
		for await (const event of eventStream) {
			if (Date.now() - startTime > OPERATION_TIMEOUT_MS) {
				sessionError = new Error("Operation timed out");
				break;
			}

			if (!isEventForSession(event, sessionID)) {
				continue;
			}

			switch (event.type) {
				case "permission.updated": {
					const permission = event.properties as Permission;

					if (spinner) {
						spinner.stop("Permission required");
					}

					let response: PermissionResponse;
					try {
						const timeoutPromise = new Promise<PermissionResponse>(
							(resolve) => {
								setTimeout(
									() => resolve("reject"),
									PERMISSION_PROMPT_TIMEOUT_MS,
								);
							},
						);

						response = await Promise.race([
							promptUserForPermission(permission),
							timeoutPromise,
						]);
					} catch {
						response = "reject";
					}

					try {
						await client.postSessionIdPermissionsPermissionId({
							path: { id: sessionID, permissionID: permission.id },
							body: { response },
						});
					} catch (err) {
						p.log.warn(
							`Failed to send permission response: ${err instanceof Error ? err.message : String(err)}`,
						);
					}

					if (spinner && spinnerMessage) {
						spinner.start(spinnerMessage);
					}
					break;
				}

				case "message.updated": {
					const info = event.properties.info;
					if (info.role === "assistant") {
						assistantMessage = info as AssistantMessage;
						if (isAssistantMessageComplete(assistantMessage)) {
							return {
								assistantMessage,
								parts: Array.from(collectedParts.values()),
								error: null,
							};
						}
					}
					break;
				}

				case "message.part.updated": {
					const part = event.properties.part;
					collectedParts.set(part.id, part);
					break;
				}

				case "session.error": {
					const errorProps = event.properties;
					const errorData = errorProps.error;
					if (errorData) {
						const errorMessage =
							"data" in errorData && errorData.data
								? (errorData.data as { message?: string }).message ||
									errorData.name
								: errorData.name;
						sessionError = new Error(errorMessage || "Session error occurred");
					} else {
						sessionError = new Error("Unknown session error");
					}
					return {
						assistantMessage,
						parts: Array.from(collectedParts.values()),
						error: sessionError,
					};
				}

				case "session.idle": {
					if (
						assistantMessage &&
						isAssistantMessageComplete(assistantMessage)
					) {
						return {
							assistantMessage,
							parts: Array.from(collectedParts.values()),
							error: null,
						};
					}
					break;
				}
			}
		}
	} catch {
		if (!reconnectAttempted) {
			reconnectAttempted = true;
			try {
				eventStream = await connectToEventStream();

				const sessionStatus = await client.session.get({
					path: { id: sessionID },
				});

				if (sessionStatus.data) {
					const messages = await client.session.messages({
						path: { id: sessionID },
					});

					if (messages.data && messages.data.length > 0) {
						const lastMessage = messages.data[messages.data.length - 1];
						if (lastMessage.info.role === "assistant") {
							const assistantInfo = lastMessage.info as AssistantMessage;
							if (isAssistantMessageComplete(assistantInfo)) {
								return {
									assistantMessage: assistantInfo,
									parts: lastMessage.parts,
									error: null,
								};
							}
						}
					}
				}
			} catch (reconnectError) {
				try {
					await client.session.abort({ path: { id: sessionID } });
				} catch {
					// Ignore abort errors
				}
				throw new Error(
					`Event stream disconnected and reconnect failed: ${reconnectError instanceof Error ? reconnectError.message : String(reconnectError)}`,
				);
			}
		}
	}

	if (sessionError) {
		return {
			assistantMessage,
			parts: Array.from(collectedParts.values()),
			error: sessionError,
		};
	}

	if (assistantMessage) {
		return {
			assistantMessage,
			parts: Array.from(collectedParts.values()),
			error: null,
		};
	}

	return {
		assistantMessage: null,
		parts: [],
		error: new Error("Event stream ended without completing"),
	};
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
	spinner?: ReturnType<typeof p.spinner> | null,
	spinnerMessage?: string,
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

		const result = await processEventStream(
			client,
			sessionID,
			spinner ?? null,
			spinnerMessage ?? "",
		);

		if (result.error) {
			await close();
			throw result.error;
		}

		if (!result.assistantMessage) {
			await close();
			throw new Error(`Failed to get AI response from ${modelID}`);
		}

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

function buildDeslopPrompt(options: DeslopGenerationOptions): string {
	const {
		stagedDiff,
		baseDiff,
		baseRef = "main",
		extraPrompt,
		stagedFiles,
		notStagedFiles,
	} = options;
	const filesList =
		stagedFiles && stagedFiles.length > 0
			? stagedFiles.map((file) => `- ${file}`).join("\n")
			: "";
	const notStagedList =
		notStagedFiles && notStagedFiles.length > 0
			? notStagedFiles.map((file) => `- ${file}`).join("\n")
			: "";

	let prompt = `# Remove AI code slop

Edit files directly using the available tools.

Rules:
- Only edit files listed under "Staged files" (if provided, including new files)
- Do not edit files listed under "Not staged files" (if provided)
- Do not edit any file that is not staged
- Do not create new files
- Keep changes minimal and consistent with the codebase
- Thoroughly examine the full content of ALL staged files (not just the diff summary) and identify/remove AI slop from each one individually, including new files. Use file reading tools to inspect complete file contents before making edits.

Instructions:
Check the uncommited changes, and remove all AI generated slop introduced in this branch.
This includes:
- Extra comments that a human wouldn't add or is inconsistent with the rest of the file
- Remove all verbose JSDoc comments that explain obvious function purposes.
- Extra defensive checks or try/catch blocks that are abnormal for that area of the codebase (especially if called by trusted / validated codepaths)
- Casts to any to get around type issues
- Any other style that is inconsistent with the file

Respond with:
SUMMARY: <1-3 sentences>

If no changes are needed, do not edit any files and respond with:
SUMMARY: No changes required.
`;

	if (filesList) {
		prompt += `\nStaged files:\n${filesList}\n`;
	}
	if (notStagedList) {
		prompt += `\nNot staged files:\n${notStagedList}\n`;
	}

	prompt += `\nDiff against ${baseRef}:\n\`\`\`diff\n${baseDiff || ""}\n\`\`\`\n\nStaged diff to clean up:\n\`\`\`diff\n${stagedDiff}\n\`\`\``;

	if (extraPrompt?.trim()) {
		prompt += `\n\nAdditional constraints from the user:\n${extraPrompt.trim()}\n`;
	}

	return prompt;
}

export async function runDeslopEdits(
	options: DeslopGenerationOptions,
): Promise<DeslopEditResult> {
	const deslopModel = await getDeslopModel();
	const prompt = buildDeslopPrompt(options);

	const { message, sessionID, messageID, close } = await runOpencodePrompt(
		{
			title: "oc-deslop",
			prompt,
			model: deslopModel,
			directory: process.cwd(),
		},
		options.spinner,
		options.spinnerMessage,
	);
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

	const systemPrompt = await getCommitConfig();

	let prompt = `${systemPrompt}\n\n---\n\nGenerate a concise git branch name for the following diff.\n\nRules:\n- Use lowercase letters\n- Use hyphens to separate words\n- Optional prefix like "feat/" or "fix/"\n- No spaces, quotes, or markdown\n- Keep it under 50 characters\n\nDiff:\n\`\`\`diff\n${diff}\n\`\`\``;

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
	const { diff, commits, targetBranch, sourceBranch } = options;

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
