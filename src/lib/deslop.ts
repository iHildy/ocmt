import * as p from "@clack/prompts";
import color from "picocolors";
import { spawn } from "child_process";
import { getConfig } from "./config";
import { runDeslopEdits } from "./opencode";
import {
  getDiffBetween,
  getStagedDiff,
  getStatus,
  git,
  stageFiles,
} from "../utils/git";

export type DeslopFlowResult = "continue" | "abort" | "updated";

export interface DeslopFlowOptions {
  stagedDiff?: string;
  yes?: boolean;
  extraPrompt?: string;
}

async function getBaseDiff(): Promise<{ baseRef: string; diff: string }> {
  try {
    const diff = await getDiffBetween("main", "HEAD");
    return { baseRef: "main", diff };
  } catch {
    try {
      const diff = await getDiffBetween("master", "HEAD");
      return { baseRef: "master", diff };
    } catch {
      return { baseRef: "main", diff: "" };
    }
  }
}

async function createGitSnapshotRef(): Promise<string> {
  const snapshotRef = await git("stash create");
  if (!snapshotRef) {
    throw new Error("Failed to create git snapshot");
  }
  return snapshotRef;
}

async function runGitDifftool(snapshotRef: string): Promise<"ok" | "failed"> {
  return new Promise((resolve) => {
    const child = spawn("git", ["difftool", snapshotRef], {
      stdio: "inherit",
    });

    child.on("error", () => {
      resolve("failed");
    });

    child.on("exit", (code) => {
      resolve(code === 0 ? "ok" : "failed");
    });
  });
}

async function restoreGitSnapshot(snapshotRef: string): Promise<void> {
  await git(`restore --source ${snapshotRef} --worktree -- .`);
  try {
    await git(`restore --source ${snapshotRef}^2 --staged -- .`);
  } catch {
    await git(`restore --source ${snapshotRef} --staged -- .`);
  }
}

export async function maybeDeslopStagedChanges(
  options: DeslopFlowOptions
): Promise<DeslopFlowResult> {
  const config = await getConfig();
  const autoDeslop = !!config.commit?.autoDeslop;

  let shouldDeslop = false;

  if (options.yes) {
    shouldDeslop = autoDeslop;
  } else {
    const confirm = await p.confirm({
      message: "Deslop staged changes?",
      initialValue: autoDeslop,
    });

    if (p.isCancel(confirm)) {
      p.cancel("Aborted");
      return "abort";
    }

    shouldDeslop = !!confirm;
  }

  if (!shouldDeslop) {
    return "continue";
  }

  const stagedDiff = options.stagedDiff ?? (await getStagedDiff());
  if (!stagedDiff) {
    p.log.info(color.dim("No staged diff to deslop"));
    return "continue";
  }

  const { baseRef, diff: baseDiff } = await getBaseDiff();

  let extraPrompt = options.extraPrompt?.trim();

  if (!options.yes && !extraPrompt) {
    const extra = await p.text({
      message: "Add any deslop exclusions or extra instructions? (optional)",
      placeholder: "e.g. Keep existing comments in src/api.ts",
      initialValue: "",
    });

    if (p.isCancel(extra)) {
      p.cancel("Aborted");
      return "abort";
    }

    extraPrompt =
      typeof extra === "string" ? extra.trim() || undefined : undefined;
  }

  const statusBefore = await getStatus();
  const stagedFiles = statusBefore.staged;
  const notStagedFiles = Array.from(
    new Set([
      ...statusBefore.unstaged.filter((file) => !stagedFiles.includes(file)),
      ...statusBefore.untracked,
    ])
  );

  const s = p.spinner();
  s.start("Deslopping staged changes");

  let deslopSession: Awaited<ReturnType<typeof runDeslopEdits>> | null = null;
  let snapshotRef: string | null = null;

  try {
    snapshotRef = await createGitSnapshotRef();

    deslopSession = await runDeslopEdits({
      stagedDiff,
      baseDiff,
      baseRef,
      extraPrompt,
      stagedFiles,
      notStagedFiles,
    });

    const summary = deslopSession.summary?.trim();
    const fallbackSummary = "Deslop completed with minor cleanup adjustments.";
    deslopSession.close();
    deslopSession = null;

    await stageFiles(stagedFiles);

    const updatedDiff = await getStagedDiff();
    const didChange = updatedDiff !== stagedDiff;

    if (!didChange) {
      s.stop("No deslop changes needed");
      p.log.step(summary || "No deslop changes were required.");
      deslopSession.close();
      return "continue";
    }

    s.stop("Deslop applied (review pending)");

    if (options.yes) {
      p.log.step(summary || fallbackSummary);
      deslopSession.close();
      return "updated";
    }

    const diffResult = snapshotRef
      ? await runGitDifftool(snapshotRef)
      : "failed";
    if (diffResult === "failed") {
      p.log.warn("git difftool failed. Review manually if needed.");
    }

    const action = await p.select({
      message: "Keep deslop changes?",
      options: [
        { value: "accept", label: "Accept and keep changes" },
        { value: "reject", label: "Reject and revert deslop changes" },
      ],
    });

    if (p.isCancel(action)) {
      if (snapshotRef) {
        await restoreGitSnapshot(snapshotRef);
      }
      p.cancel("Aborted");
      return "abort";
    }

    if (action === "reject") {
      if (snapshotRef) {
        await restoreGitSnapshot(snapshotRef);
      }
      p.log.info(color.dim("Deslop changes reverted"));
      return "continue";
    }

    p.log.step(summary || fallbackSummary);
    return "updated";
  } catch (error: any) {
    s.stop("Deslop failed");
    if (snapshotRef) {
      try {
        await restoreGitSnapshot(snapshotRef);
      } catch {
        // Ignore cleanup errors
      }
    }
    deslopSession?.close();
    p.cancel(error.message);
    return "abort";
  }
}
