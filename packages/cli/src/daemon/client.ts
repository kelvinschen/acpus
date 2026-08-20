import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  awaitRuntimeStoreOffline,
  getRun,
  inspectRuntimeStore,
  probeDaemonEndpoint,
  repairRuntimeStore,
  requestDaemonControl,
  requestDaemonStatusProbe,
  requestDaemonSubmitAndObserve,
  requestPredecessorDaemonShutdown,
  tryLoadRuntimeConfiguration,
  type AgentInjectionMap,
  type DaemonClientFailure,
  type DaemonControlIntent,
  type DaemonControlResult,
  type DaemonErrorCode,
  type DaemonRunObservationUntil,
  type DaemonRunStreamClientFailure,
  type DaemonRunStreamFrame,
  type PreparedRunWorkflow,
  type RunDetails,
  type RuntimeAuthorityIdentity,
} from "@acpus/runtime";
import type { JsonValue } from "@acpus/expression/ir";
import { err, ok, ResultAsync, type Result } from "neverthrow";

export type RuntimeAuthorityMode = "admission" | "control";

export type CliDaemonFailure =
  | { type: "runtime-configuration-invalid"; message: string }
  | { type: "runtime-store-repair-required"; message: string }
  | { type: "runtime-store-unsupported"; message: string }
  | { type: "runtime-store-unreadable"; message: string }
  | { type: "runtime-store-repair-failed"; message: string }
  | { type: "runtime-update-blocked"; message: string }
  | { type: "runtime-authority-lost"; runId: string; message: string }
  | { type: "authority-wait-aborted"; message: string }
  | {
    type: "daemon-stream-protocol-failed";
    failure: Extract<DaemonRunStreamClientFailure, { type: "protocol" }>;
    message: string;
  }
  | { type: "daemon-status-failed"; failure: DaemonClientFailure; message: string }
  | { type: "daemon-spawn-failed"; errno?: string; message: string }
  | { type: "daemon-exited-before-ready"; exitCode: number | null; signal: NodeJS.Signals | null; message: string }
  | { type: "daemon-start-timeout"; message: string }
  | {
    type: "request-failed";
    method: "submitAndObserve";
    code: DaemonErrorCode;
    runId?: string;
    message: string;
  };

export type DaemonControlFailure = {
  type: "control-failed";
  code: DaemonErrorCode
    | "RUNTIME_STORE_REPAIR_REQUIRED"
    | "RUNTIME_STORE_UNSUPPORTED"
    | "RUNTIME_STORE_UNREADABLE"
    | "RUNTIME_STORE_REPAIR_FAILED"
    | "RUNTIME_UPDATE_BLOCKED";
  controlType: DaemonControlIntent["type"];
  runId: string;
  run: RunDetails | undefined;
  cause: CliDaemonFailure | DaemonClientFailure;
  message: string;
};

export type DaemonSubmitInput = {
  requestId: string;
  prepared: PreparedRunWorkflow;
  input: JsonValue;
  agentInjections?: AgentInjectionMap;
  until: DaemonRunObservationUntil;
};

type SpawnState = {
  error?: unknown;
  exit?: { code: number | null; signal: NodeJS.Signals | null; observedAt: number };
};

const competingDaemonGraceMs = 5_000;
const authorityStartTimeoutMs = 30_000;

export function ensureRuntimeAuthority(
  cwd: string,
  mode: RuntimeAuthorityMode,
  options: { signal?: AbortSignal } = {},
): ResultAsync<RuntimeAuthorityIdentity, CliDaemonFailure> {
  return new ResultAsync(ensureRuntimeAuthorityResult(cwd, mode, options.signal));
}

async function ensureRuntimeAuthorityResult(
  cwd: string,
  mode: RuntimeAuthorityMode,
  signal?: AbortSignal,
): Promise<Result<RuntimeAuthorityIdentity, CliDaemonFailure>> {
  const deadline = Date.now() + authorityStartTimeoutMs;
  let child: ChildProcess | undefined;
  let childState: SpawnState | undefined;
  let storePrepared = false;
  let predecessorShutdownAccepted = false;
  let predecessorOffline = false;

  while (Date.now() <= deadline && !signal?.aborted) {
    const status = await requestDaemonStatusProbe(cwd);
    if (status.isOk()) {
      if (status.value.kind === "current") return ok(status.value.status.authority);
      if (status.value.kind === "unknown") return err(runtimeUpdateBlocked(
        status.value.protocolVersion === undefined
          ? "The workspace daemon uses an unknown Runtime protocol. Use a matching or newer Acpus version."
          : `The workspace daemon uses unsupported protocol v${status.value.protocolVersion}. Use a matching or newer Acpus version.`,
      ));
      if (!predecessorShutdownAccepted) {
        const retired = await requestPredecessorDaemonShutdown(cwd);
        if (retired.isErr()) {
          return err(runtimeUpdateBlocked(
            retired.error.type === "rejected" && retired.error.code === "CONTROL_CONFLICT"
              ? "The previous Acpus daemon still has active work. Wait for it to finish, then retry."
              : `The previous Acpus daemon could not be retired safely: ${retired.error.message}`,
          ));
        }
        predecessorShutdownAccepted = true;
      }
      await delay(100, signal);
      continue;
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
    if (isInitializingFailure(status.error)) {
      await delay(100, signal);
      continue;
    }
    if (!isStartupConnectionFailure(status.error)) {
      if (await probeDaemonEndpoint(cwd)) {
        return err(runtimeUpdateBlocked(
          `The workspace daemon could not be identified safely: ${status.error.message}`,
        ));
      }
      return err({ type: "daemon-status-failed", failure: status.error, message: status.error.message });
    }

    if (predecessorShutdownAccepted && await probeDaemonEndpoint(cwd)) {
      await delay(100, signal);
      continue;
    }
    if (predecessorShutdownAccepted && !predecessorOffline) {
      const offline = await awaitRuntimeStoreOffline(cwd);
      if (offline.isErr()) return err(runtimeUpdateBlocked(
        `The previous Runtime authority has not released the store safely: ${offline.error.message}`,
      ));
      predecessorOffline = true;
    }
    if (!storePrepared) {
      const prepared = await prepareRuntimeStore(cwd, mode);
      if (prepared.isErr()) return err(prepared.error);
      storePrepared = true;
    }
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
    await delay(100, signal);
  }
  if (signal?.aborted) return err({ type: "authority-wait-aborted", message: "Runtime authority wait was interrupted." });
  if (predecessorShutdownAccepted) {
    return err(runtimeUpdateBlocked(
      "The previous Acpus daemon did not release its endpoint and Runtime store before the update deadline. Wait for existing work to finish, then retry.",
    ));
  }
  return err({ type: "daemon-start-timeout", message: "Runtime authority did not become ready within 30 seconds." });
}

export function sendDaemonControl(
  cwd: string,
  intent: DaemonControlIntent,
): ResultAsync<DaemonControlResult, DaemonControlFailure> {
  return new ResultAsync(sendDaemonControlResult(cwd, intent));
}

async function sendDaemonControlResult(
  cwd: string,
  intent: DaemonControlIntent,
): Promise<Result<DaemonControlResult, DaemonControlFailure>> {
  const ready = await ensureRuntimeAuthority(cwd, "control");
  if (ready.isErr()) {
    return err(await controlFailure(cwd, intent, publicFailureCode(ready.error), ready.error));
  }
  const controlled = await requestDaemonControl(cwd, intent);
  if (controlled.isOk()) return ok(controlled.value);
  const code = controlled.error.type === "rejected" ? controlled.error.code : "EXECUTION_UNAVAILABLE";
  return err(await controlFailure(cwd, intent, code, controlled.error));
}

export async function* sendDaemonSubmitAndObserve(
  cwd: string,
  input: DaemonSubmitInput,
  options: { signal?: AbortSignal } = {},
): AsyncIterable<Result<DaemonRunStreamFrame, CliDaemonFailure>> {
  while (!options.signal?.aborted) {
    const authority = await ensureRuntimeAuthority(cwd, "admission", options);
    if (options.signal?.aborted) return;
    if (authority.isErr()) {
      yield err(authority.error);
      return;
    }
    let admittedRunId: string | undefined;
    let retry = false;
    let terminal = false;
    let frameFailure: Extract<CliDaemonFailure, { type: "request-failed" }> | undefined;
    const stream = requestDaemonSubmitAndObserve(cwd, {
      expectedAuthority: authority.value,
      requestId: input.requestId,
      prepared: input.prepared,
      input: input.input,
      ...(input.agentInjections === undefined ? {} : { agentInjections: input.agentInjections }),
      until: input.until,
    }, options);
    for await (const result of stream) {
      if (result.isErr()) {
        if (result.error.type === "transport") {
          if (admittedRunId === undefined) {
            retry = true;
            break;
          }
          yield err(runtimeAuthorityLost(admittedRunId));
          return;
        }
        if (result.error.reason === "truncated" && admittedRunId !== undefined) {
          yield err(runtimeAuthorityLost(admittedRunId));
          return;
        }
        yield err({
          type: "daemon-stream-protocol-failed",
          failure: result.error,
          message: result.error.message,
        });
        return;
      }
      const frame = result.value;
      if (frame.kind === "admitted") {
        admittedRunId = frame.run.id;
        terminal = input.until === "admitted";
        yield ok(frame);
        continue;
      }
      if (frame.kind === "observation") {
        terminal = frame.observation.kind === "closed";
        yield ok(frame);
        continue;
      }
      terminal = true;
      if (frame.phase === "authority"
        && frame.outcome === "not-admitted"
        && frame.error.code === "AUTHORITY_MISMATCH") {
        retry = true;
        continue;
      }
      if (frame.outcome === "unknown") {
        retry = true;
        continue;
      }
      const runId = frame.runId ?? admittedRunId;
      frameFailure = {
        type: "request-failed",
        method: "submitAndObserve",
        code: frame.error.code,
        ...(runId === undefined ? {} : { runId }),
        message: frame.error.message,
      };
    }
    if (options.signal?.aborted) return;
    if (frameFailure !== undefined) {
      yield err(frameFailure);
      return;
    }
    if (retry) {
      await delay(100, options.signal);
      continue;
    }
    if (terminal) return;
    if (admittedRunId !== undefined) {
      yield err(runtimeAuthorityLost(admittedRunId));
      return;
    }
  }
}

async function prepareRuntimeStore(
  cwd: string,
  mode: RuntimeAuthorityMode,
): Promise<Result<void, CliDaemonFailure>> {
  const inspected = await inspectRuntimeStore(cwd);
  if (inspected.isErr()) {
    return err(inspected.error.type === "busy"
      ? runtimeUpdateBlocked("The Runtime store is currently in use. Wait for existing work to finish, then retry.")
      : {
          type: "runtime-store-unreadable",
          message: "The Runtime store could not be read. Run 'acpus doctor'.",
        });
  }
  if (inspected.value.state === "unsupported") {
    return err({
      type: "runtime-store-unsupported",
      message: `${inspected.value.message} Run 'acpus doctor'.`,
    });
  }
  if (inspected.value.state !== "repairable") return ok(undefined);
  if (mode === "control") {
    return err({
      type: "runtime-store-repair-required",
      message: `${inspected.value.message} Run 'acpus doctor --fix'.`,
    });
  }
  const repaired = await repairRuntimeStore(cwd);
  if (repaired.isOk()) return ok(undefined);
  if (repaired.error.type === "unsupported") {
    return err({
      type: "runtime-store-unsupported",
      message: `${repaired.error.message} Run 'acpus doctor'.`,
    });
  }
  if (repaired.error.type === "busy") {
    return err(runtimeUpdateBlocked("The Runtime store still has active users. Wait for existing work to finish, then retry."));
  }
  if (repaired.error.type === "unreadable") {
    return err({
      type: "runtime-store-unreadable",
      message: `${repaired.error.message} Run 'acpus doctor'.`,
    });
  }
  return err({
    type: "runtime-store-repair-failed",
    message: "The Runtime store update did not complete. Its transition intent and original data were preserved. Run 'acpus doctor --fix'.",
  });
}

export function daemonControlRequestId(): string {
  return `cli:${randomUUID()}`;
}

export function daemonAdmissionRequestId(): string {
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

function runtimeUpdateBlocked(message: string): Extract<CliDaemonFailure, { type: "runtime-update-blocked" }> {
  return { type: "runtime-update-blocked", message };
}

function runtimeAuthorityLost(runId: string): Extract<CliDaemonFailure, { type: "runtime-authority-lost" }> {
  return {
    type: "runtime-authority-lost",
    runId,
    message: `Runtime authority was lost after run '${runId}' was admitted. The run remains durable. Run 'acpus runs inspect ${runId} --follow'.`,
  };
}

function publicFailureCode(failure: CliDaemonFailure): DaemonControlFailure["code"] {
  if (failure.type === "runtime-store-repair-required") return "RUNTIME_STORE_REPAIR_REQUIRED";
  if (failure.type === "runtime-store-unsupported") return "RUNTIME_STORE_UNSUPPORTED";
  if (failure.type === "runtime-store-unreadable") return "RUNTIME_STORE_UNREADABLE";
  if (failure.type === "runtime-store-repair-failed") return "RUNTIME_STORE_REPAIR_FAILED";
  if (failure.type === "runtime-update-blocked") return "RUNTIME_UPDATE_BLOCKED";
  return "EXECUTION_UNAVAILABLE";
}

async function controlFailure(
  cwd: string,
  intent: DaemonControlIntent,
  code: DaemonControlFailure["code"],
  cause: CliDaemonFailure | DaemonClientFailure,
): Promise<DaemonControlFailure> {
  let run: RunDetails | undefined;
  try {
    const read = await getRun(cwd, intent.runId);
    run = read.isOk() ? read.value : undefined;
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

function controlFailureMessage(
  code: DaemonControlFailure["code"],
  controlType: string,
  runId: string,
  run: RunDetails | undefined,
  cause: CliDaemonFailure | DaemonClientFailure,
): string {
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

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise(resolve => {
    const timeout = setTimeout(finish, ms);
    const onAbort = (): void => finish();
    function finish(): void {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
