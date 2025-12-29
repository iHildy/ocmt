import { spawn } from "child_process";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { basename, join } from "path";
import { exec } from "child_process";
import { promisify } from "util";
import * as p from "@clack/prompts";
import color from "picocolors";
import http from "http";
import https from "https";

const execAsync = promisify(exec);
const DEFAULT_OPENCODE_URL = "http://localhost:4096";
const DEFAULT_TIMEOUT_MS = 120_000;

export interface CliAttachment {
  filename: string;
  content: string;
}

export interface CliRunOptions {
  title: string;
  prompt: string;
  model: string;
  agent?: string;
  directory?: string;
  files?: CliAttachment[];
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

export interface CliRunResult {
  message: string;
  sessionID?: string;
  messageID?: string;
}

async function isOpencodeInstalled(): Promise<boolean> {
  try {
    await execAsync("which opencode");
    return true;
  } catch {
    return false;
  }
}

async function ensureOpencodeInstalled(): Promise<void> {
  if (await isOpencodeInstalled()) {
    return;
  }
  throw new Error(
    `OpenCode CLI is not installed. Install it with: ${color.cyan("npm install -g opencode")} or ${color.cyan("brew install sst/tap/opencode")}`,
  );
}

function sanitizeFilename(name: string, fallback: string): string {
  const base = basename(name).trim() || fallback;
  const sanitized = base.replace(/[^a-zA-Z0-9._-]/g, "-");
  return sanitized || fallback;
}

async function writeTempFiles(
  files: CliAttachment[] | undefined,
): Promise<{ paths: string[]; cleanup: () => Promise<void> }> {
  if (!files || files.length === 0) {
    return { paths: [], cleanup: async () => {} };
  }

  const tempDir = await mkdtemp(join(tmpdir(), "ocmt-opencode-"));
  const usedNames = new Set<string>();
  const paths: string[] = [];

  for (const [index, file] of files.entries()) {
    const fallback = `attachment-${index + 1}.txt`;
    let name = sanitizeFilename(file.filename, fallback);
    if (usedNames.has(name)) {
      name = `${name.replace(/\.[^.]+$/, "")}-${index + 1}${name.includes(".") ? name.slice(name.lastIndexOf(".")) : ""}`;
    }
    usedNames.add(name);

    const filePath = join(tempDir, name);
    await writeFile(filePath, file.content, "utf-8");
    paths.push(filePath);
  }

  const cleanup = async (): Promise<void> => {
    await rm(tempDir, { recursive: true, force: true });
  };

  return { paths, cleanup };
}

function extractTextFromParts(parts: any[]): string {
  return parts
    .filter((part) => part && part.type === "text")
    .map((part) => part.text)
    .join("")
    .trim();
}

function extractTextFromEvent(event: any): {
  fullText?: string;
  deltaText?: string;
  sessionID?: string;
  messageID?: string;
} {
  const data = event?.data ?? event;
  const message = data?.message ?? data;

  const sessionID =
    data?.session?.id ??
    message?.session?.id ??
    data?.sessionID ??
    data?.session_id ??
    message?.sessionID ??
    message?.session_id;

  const messageID =
    message?.info?.id ??
    message?.id ??
    data?.messageID ??
    data?.message_id ??
    data?.info?.id;

  const role = message?.role ?? data?.role;
  const isAssistant = !role || role === "assistant";

  let fullText: string | undefined;
  if (Array.isArray(message?.parts)) {
    fullText = extractTextFromParts(message.parts);
  } else if (Array.isArray(data?.parts)) {
    fullText = extractTextFromParts(data.parts);
  }

  const content = message?.content ?? data?.content;
  if (!fullText && typeof content === "string") {
    fullText = content;
  } else if (!fullText && Array.isArray(content)) {
    const contentText = content
      .map((item) =>
        typeof item === "string" ? item : item?.text ?? "",
      )
      .join("");
    if (contentText) {
      fullText = contentText;
    }
  }

  let deltaText: string | undefined;
  const delta =
    data?.delta?.text ??
    data?.delta ??
    event?.delta?.text ??
    event?.delta ??
    data?.text;
  if (typeof delta === "string") {
    deltaText = delta;
  }

  if (!fullText && typeof data?.text === "string") {
    fullText = data.text;
  }

  if (!isAssistant) {
    return { sessionID, messageID };
  }

  return { fullText, deltaText, sessionID, messageID };
}

function parseJsonOutput(
  output: string,
): { message: string; sessionID?: string; messageID?: string } | null {
  const lines = output.split(/\r?\n/).filter(Boolean);
  let sawJson = false;
  let fullMessage = "";
  const deltaChunks: string[] = [];
  let sessionID: string | undefined;
  let messageID: string | undefined;

  for (const line of lines) {
    let event: any;
    try {
      event = JSON.parse(line);
      sawJson = true;
    } catch {
      continue;
    }

    const { fullText, deltaText, sessionID: sid, messageID: mid } =
      extractTextFromEvent(event);

    if (sid) sessionID = sid;
    if (mid) messageID = mid;

    if (fullText) {
      fullMessage = fullText;
    } else if (deltaText) {
      deltaChunks.push(deltaText);
    }
  }

  if (!sawJson) {
    return null;
  }

  const message = (fullMessage || deltaChunks.join("")).trim();
  return { message, sessionID, messageID };
}

function requestHead(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      resolve(false);
      return;
    }

    const client = parsed.protocol === "https:" ? https : http;
    const rawPath = parsed.pathname ?? "";
    const basePath = rawPath === "/" ? "" : rawPath.replace(/\/$/, "");
    const requestPath = `${basePath}/config`;

    const req = client.request(
      {
        method: "GET",
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
        path: requestPath,
        timeout: 1500,
      },
      (res) => {
        res.resume();
        resolve((res.statusCode ?? 500) < 500);
      },
    );

    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}

async function resolveAttachUrl(): Promise<string | null> {
  const envUrl =
    process.env.OPENCODE_SERVER_URL || process.env.OPENCODE_URL;
  if (envUrl?.trim()) {
    const candidate = envUrl.trim();
    if (await requestHead(candidate)) {
      return candidate;
    }
    p.log.warn(
      `Failed to connect to OpenCode server at ${candidate}. Falling back to local CLI run.`,
    );
    return null;
  }

  if (await requestHead(DEFAULT_OPENCODE_URL)) {
    return DEFAULT_OPENCODE_URL;
  }

  return null;
}

async function runOpencodeOnce(
  options: CliRunOptions,
  format: "json" | "default",
): Promise<{
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
}> {
  const {
    title,
    prompt,
    model,
    agent,
    directory,
    files,
    env,
    timeoutMs,
  } = options;

  await ensureOpencodeInstalled();

  const attachUrl = await resolveAttachUrl();
  const { paths, cleanup } = await writeTempFiles(files);

  const args = [
    "run",
    "--format",
    format,
    "--model",
    model,
    "--title",
    title,
  ];

  if (attachUrl) {
    args.push("--attach", attachUrl);
  }

  if (agent) {
    args.push("--agent", agent);
  }

  for (const filePath of paths) {
    args.push("--file", filePath);
  }

  args.push(prompt);

  return new Promise((resolve, reject) => {
    const child = spawn("opencode", args, {
      cwd: directory || process.cwd(),
      env: env || process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5000);
    }, timeoutMs ?? DEFAULT_TIMEOUT_MS);

    child.stdout?.on("data", (data) => {
      stdout += data.toString();
    });
    child.stderr?.on("data", (data) => {
      stderr += data.toString();
    });

    child.on("error", async (error) => {
      clearTimeout(timeout);
      await cleanup();
      reject(error);
    });

    child.on("close", async (code, signal) => {
      clearTimeout(timeout);
      await cleanup();
      resolve({ stdout, stderr, exitCode: code, signal, timedOut });
    });
  });
}

function formatExitStatus(
  exitCode: number | null,
  signal: NodeJS.Signals | null,
): string {
  if (exitCode !== null) {
    return `exit code ${exitCode}`;
  }
  if (signal) {
    return `signal ${signal}`;
  }
  return "unknown exit status";
}

export async function runOpencodeCliPrompt(
  options: CliRunOptions,
): Promise<CliRunResult> {
  const jsonResult = await runOpencodeOnce(options, "json");

  if (jsonResult.timedOut) {
    throw new Error(
      `OpenCode CLI timed out after ${options.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`,
    );
  }

  if (jsonResult.exitCode !== 0) {
    const stderr = jsonResult.stderr.trim();
    throw new Error(
      `OpenCode CLI failed with ${formatExitStatus(jsonResult.exitCode, jsonResult.signal)}. ${stderr || "No stderr output."}`,
    );
  }

  if (!jsonResult.stdout.trim()) {
    throw new Error(
      `OpenCode CLI returned empty output. ${jsonResult.stderr.trim() || "No stderr output."}`,
    );
  }

  const parsed = parseJsonOutput(jsonResult.stdout);
  if (parsed && parsed.message) {
    return parsed;
  }

  const fallbackResult = await runOpencodeOnce(options, "default");

  if (fallbackResult.timedOut) {
    throw new Error(
      `OpenCode CLI timed out after ${options.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`,
    );
  }

  if (fallbackResult.exitCode !== 0) {
    const stderr = fallbackResult.stderr.trim();
    throw new Error(
      `OpenCode CLI failed with ${formatExitStatus(fallbackResult.exitCode, fallbackResult.signal)}. ${stderr || "No stderr output."}`,
    );
  }

  const output = fallbackResult.stdout.trim();
  if (!output) {
    throw new Error(
      `OpenCode CLI returned empty output. ${fallbackResult.stderr.trim() || "No stderr output."}`,
    );
  }

  return { message: output };
}

export function cleanup(): void {
  // No-op for CLI runner (per-run cleanup is handled internally).
}
