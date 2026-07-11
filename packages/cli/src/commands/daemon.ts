import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { DaemonRequestError, getRun, requestDaemonAdmitRun, requestDaemonControl, requestDaemonStatus, type AgentOverrideMap, type DaemonControlIntent, type DaemonControlResult, type DaemonErrorCode, type PreparedRunWorkflow, type RunDetails } from "@acpus/runtime";
import type { JsonValue } from "@acpus/expression/ir";

export class DaemonControlFailure extends Error {
  constructor(
    readonly code: DaemonErrorCode,
    readonly controlType: DaemonControlIntent["type"],
    readonly runId: string,
    readonly run: RunDetails | undefined,
    cause: unknown,
  ) {
    super(controlFailureMessage(code, controlType, runId, run, cause));
  }
}

export async function ensureDaemonRunning(cwd: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  let lastError: unknown;
  let spawned = false;
  while (Date.now() <= deadline) {
    try {
      await requestDaemonStatus(cwd);
      return;
    } catch (error) {
      if (isDaemonStartupConnectionError(error)) {
        if (!spawned) {
          const child = spawn(process.execPath, daemonEntryArgs(cwd), { cwd, detached: true, stdio: "ignore" });
          child.unref();
          spawned = true;
        }
      } else if (!(error instanceof DaemonRequestError && error.code === "EXECUTION_UNAVAILABLE")) throw error;
      lastError = error;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw lastError instanceof Error ? lastError : new Error("Daemon did not become ready.");
}

export async function sendDaemonControl(cwd: string, intent: DaemonControlIntent): Promise<DaemonControlResult> {
  try {
    await ensureDaemonRunning(cwd);
    return await requestDaemonControl(cwd, intent);
  } catch (error) {
    throw await daemonControlFailure(cwd, intent, error instanceof DaemonRequestError ? error.code : "EXECUTION_UNAVAILABLE", error);
  }
}

export async function sendDaemonAdmitRun(cwd: string, input: { prepared: PreparedRunWorkflow; input: JsonValue; agentOverrides?: AgentOverrideMap }): Promise<RunDetails> {
  await ensureDaemonRunning(cwd);
  return requestDaemonAdmitRun(cwd, input);
}

export function daemonControlRequestId(): string {
  return `cli:${randomUUID()}`;
}

function daemonEntryArgs(cwd: string): string[] {
  const isSourceMode = fileURLToPath(import.meta.url).endsWith(".ts");
  const entry = fileURLToPath(new URL(`../daemon-entry.${isSourceMode ? "ts" : "js"}`, import.meta.url));
  return isSourceMode
    ? ["--conditions=development", "--import", import.meta.resolve("tsx"), entry, cwd]
    : [entry, cwd];
}

function isDaemonStartupConnectionError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  return ["ENOENT", "ECONNREFUSED"].includes(String((error as { code?: unknown }).code));
}

async function daemonControlFailure(cwd: string, intent: DaemonControlIntent, code: DaemonErrorCode, cause: unknown): Promise<DaemonControlFailure> {
  let run: RunDetails | undefined;
  try {
    run = await getRun(cwd, intent.runId);
  } catch {
    run = undefined;
  }
  return new DaemonControlFailure(code, intent.type, intent.runId, run, cause);
}

function controlFailureMessage(code: DaemonErrorCode, controlType: string, runId: string, run: RunDetails | undefined, cause: unknown): string {
  const reason = cause instanceof Error ? cause.message : String(cause);
  const current = run ? ` Current run: ${run.id} ${run.name} ${run.status} updated ${run.updatedAt}.` : " Current run: unavailable.";
  return `Control '${controlType}' for run '${runId}' failed with ${code}: ${reason}.${current}`;
}
