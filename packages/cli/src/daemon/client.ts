import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  DAEMON_PROTOCOL_VERSION,
  getRun,
  inspectRuntimeStore,
  repairRuntimeStore,
  requestDaemonAdmitRun,
  requestDaemonControl,
  requestDaemonStatus,
  tryLoadRuntimeConfiguration,
  type AgentOverrideMap,
  type DaemonClientFailure,
  type DaemonControlIntent,
  type DaemonControlResult,
  type DaemonErrorCode,
  type PreparedRunWorkflow,
  type RunDetails,
} from "@acpus/runtime";
import type { JsonValue } from "@acpus/expression/ir";
import { err, ok, ResultAsync, type Result } from "neverthrow";

export type CliDaemonFailure =
  | { type: "runtime-configuration-invalid"; message: string }
  | { type: "runtime-preparation-failed"; message: string }
  | { type: "runtime-store-repair-required"; message: string }
  | { type: "runtime-store-unsupported"; message: string }
  | { type: "daemon-protocol-mismatch"; expectedProtocolVersion: number; actualProtocolVersion: number; message: string }
  | { type: "daemon-status-failed"; failure: DaemonClientFailure; message: string }
  | { type: "daemon-spawn-failed"; errno?: string; message: string }
  | { type: "daemon-exited-before-ready"; exitCode: number | null; signal: NodeJS.Signals | null; message: string }
  | { type: "daemon-start-timeout"; message: string }
  | { type: "request-failed"; method: "admitRun"; failure: DaemonClientFailure; message: string };

export type DaemonControlFailure = {
  type: "control-failed";
  code: DaemonErrorCode | "RUNTIME_STORE_REPAIR_REQUIRED" | "RUNTIME_STORE_UNSUPPORTED";
  controlType: DaemonControlIntent["type"];
  runId: string;
  run: RunDetails | undefined;
  cause: CliDaemonFailure | DaemonClientFailure;
  message: string;
};

type SpawnState = {
  error?: unknown;
  exit?: { code: number | null; signal: NodeJS.Signals | null; observedAt: number };
};

const competingDaemonGraceMs = 5_000;

export function ensureDaemonRunning(cwd: string): ResultAsync<void, CliDaemonFailure> {
  return new ResultAsync(ensureDaemonRunningResult(cwd));
}

async function ensureDaemonRunningResult(cwd: string): Promise<Result<void, CliDaemonFailure>> {
  const deadline = Date.now() + 30_000;
  let child: ChildProcess | undefined;
  let childState: SpawnState | undefined;

  while (Date.now() <= deadline) {
    const status = await requestDaemonStatus(cwd);
    if (status.isOk()) {
      return daemonProtocolResult(status.value.protocolVersion);
    }
    if (childState?.error !== undefined) {
      return err({
        type: "daemon-spawn-failed",
        ...errnoField(childState.error),
        message: errorMessage(childState.error, "Daemon process could not be spawned."),
      });
    }
    if (childState?.exit !== undefined && Date.now() - childState.exit.observedAt >= competingDaemonGraceMs) {
      return err({
        type: "daemon-exited-before-ready",
        exitCode: childState.exit.code,
        signal: childState.exit.signal,
        message: `Daemon exited before becoming ready${childState.exit.code === null ? "" : ` with code ${childState.exit.code}`}${childState.exit.signal === null ? "" : ` after ${childState.exit.signal}`}.`,
      });
    }
    if (isStartupConnectionFailure(status.error)) {
      if (child === undefined) {
        const runtimeConfiguration = tryLoadRuntimeConfiguration(process.env);
        if (runtimeConfiguration.isErr()) {
          return err({ type: "runtime-configuration-invalid", message: runtimeConfiguration.error.message });
        }
        childState = {};
        try {
          child = spawn(process.execPath, daemonEntryArgs(cwd), { cwd, detached: true, stdio: "ignore" });
        } catch (cause) {
          return err({
            type: "daemon-spawn-failed",
            ...errnoField(cause),
            message: errorMessage(cause, "Daemon process could not be spawned."),
          });
        }
        child.once("error", cause => { childState!.error = cause; });
        child.once("exit", (code, signal) => { childState!.exit = { code, signal, observedAt: Date.now() }; });
        child.unref();
      }
    } else if (!isInitializingFailure(status.error)) {
      return err({ type: "daemon-status-failed", failure: status.error, message: status.error.message });
    }
    await delay(100);
  }
  return err({ type: "daemon-start-timeout", message: "Daemon did not become ready within 30 seconds." });
}

export function sendDaemonControl(cwd: string, intent: DaemonControlIntent): ResultAsync<DaemonControlResult, DaemonControlFailure> {
  return new ResultAsync(sendDaemonControlResult(cwd, intent));
}

async function sendDaemonControlResult(cwd: string, intent: DaemonControlIntent): Promise<Result<DaemonControlResult, DaemonControlFailure>> {
  const assessment = await inspectRuntimeStore(cwd);
  if (assessment.isErr()) {
    return err(await controlFailure(cwd, intent, "EXECUTION_UNAVAILABLE", {
      type: "runtime-preparation-failed",
      message: assessment.error.message,
    }));
  }
  if (assessment.value.state === "unsupported") {
    return err(await controlFailure(cwd, intent, "RUNTIME_STORE_UNSUPPORTED", {
      type: "runtime-store-unsupported",
      message: `${assessment.value.message} Run 'acpus doctor'.`,
    }));
  }
  if (assessment.value.state === "repairable") {
    return err(await controlFailure(cwd, intent, "RUNTIME_STORE_REPAIR_REQUIRED", {
      type: "runtime-store-repair-required",
      message: `${assessment.value.message} Run 'acpus doctor --fix'.`,
    }));
  }
  const ready = await ensureDaemonRunning(cwd);
  if (ready.isErr()) return err(await controlFailure(cwd, intent, "EXECUTION_UNAVAILABLE", ready.error));
  const controlled = await requestDaemonControl(cwd, intent);
  if (controlled.isOk()) return ok(controlled.value);
  const code = controlled.error.type === "rejected" ? controlled.error.code : "EXECUTION_UNAVAILABLE";
  return err(await controlFailure(cwd, intent, code, controlled.error));
}

export function sendDaemonAdmitRun(
  cwd: string,
  input: { prepared: PreparedRunWorkflow; input: JsonValue; agentOverrides?: AgentOverrideMap },
): ResultAsync<RunDetails, CliDaemonFailure> {
  return new ResultAsync((async () => {
    const status = await requestDaemonStatus(cwd);
    let ready: Result<void, CliDaemonFailure>;
    if (status.isOk()) {
      ready = daemonProtocolResult(status.value.protocolVersion);
    } else if (isStartupConnectionFailure(status.error)) {
      const prepared = await prepareRuntimeStore(cwd);
      if (prepared.isErr()) return err(prepared.error);
      ready = await ensureDaemonRunning(cwd);
    } else if (isInitializingFailure(status.error)) {
      ready = await ensureDaemonRunning(cwd);
    } else {
      ready = err({ type: "daemon-status-failed", failure: status.error, message: status.error.message });
    }
    if (ready.isErr()) return err(ready.error);
    return requestDaemonAdmitRun(cwd, input).mapErr(failure => ({
      type: "request-failed" as const,
      method: "admitRun" as const,
      failure,
      message: failure.message,
    }));
  })());
}

async function prepareRuntimeStore(cwd: string): Promise<Result<void, CliDaemonFailure>> {
  const inspected = await inspectRuntimeStore(cwd);
  if (inspected.isErr()) {
    return err({ type: "runtime-preparation-failed", message: inspected.error.message });
  }
  if (inspected.value.state === "unsupported") {
    return err({
      type: "runtime-store-unsupported",
      message: `${inspected.value.message} Run 'acpus doctor'.`,
    });
  }
  if (inspected.value.state === "repairable") {
    const repaired = await repairRuntimeStore(cwd);
    if (repaired.isErr()) {
      if (repaired.error.type === "unsupported") {
        return err({
          type: "runtime-store-unsupported",
          message: `${repaired.error.message} Run 'acpus doctor'.`,
        });
      }
      return err({ type: "runtime-preparation-failed", message: repaired.error.message });
    }
  }
  return ok(undefined);
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

function isStartupConnectionFailure(failure: DaemonClientFailure): boolean {
  return failure.type === "transport" && (failure.reason === "not-found" || failure.reason === "refused");
}

function isInitializingFailure(failure: DaemonClientFailure): boolean {
  return failure.type === "rejected" && failure.code === "EXECUTION_UNAVAILABLE";
}

function daemonProtocolResult(actualProtocolVersion: number): Result<void, CliDaemonFailure> {
  return actualProtocolVersion === DAEMON_PROTOCOL_VERSION
    ? ok(undefined)
    : err({
        type: "daemon-protocol-mismatch",
        expectedProtocolVersion: DAEMON_PROTOCOL_VERSION,
        actualProtocolVersion,
        message: `Workspace daemon protocol version ${actualProtocolVersion} does not match this CLI's version ${DAEMON_PROTOCOL_VERSION}. Wait for the existing daemon to exit or restart it with the current Acpus version, then retry.`,
      });
}

async function controlFailure(
  cwd: string,
  intent: DaemonControlIntent,
  code: DaemonControlFailure["code"],
  cause: CliDaemonFailure | DaemonClientFailure,
): Promise<DaemonControlFailure> {
  let run: RunDetails | undefined;
  try {
    run = await getRun(cwd, intent.runId);
  } catch {
    run = undefined;
  }
  return {
    type: "control-failed",
    code,
    controlType: intent.type,
    runId: intent.runId,
    run,
    cause,
    message: controlFailureMessage(code, intent.type, intent.runId, run, cause),
  };
}

function controlFailureMessage(code: DaemonControlFailure["code"], controlType: string, runId: string, run: RunDetails | undefined, cause: CliDaemonFailure | DaemonClientFailure): string {
  const current = run ? ` Current run: ${run.id} ${run.name} ${run.status} updated ${run.updatedAt}.` : " Current run: unavailable.";
  return `Control '${controlType}' for run '${runId}' failed with ${code}: ${cause.message}.${current}`;
}

function errnoField(error: unknown): { errno?: string } {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? { errno: error.code }
    : {};
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.length > 0 ? error.message : fallback;
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
