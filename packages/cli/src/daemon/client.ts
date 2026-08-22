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
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";

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

type SubmitAttemptFailure =
  | { type: "stream"; failure: DaemonRunStreamClientFailure }
  | { type: "retry" }
  | { type: "retry-now" }
  | { type: "failure"; failure: CliDaemonFailure };

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
): Effect.Effect<RuntimeAuthorityIdentity, CliDaemonFailure> {
  const authority = ensureRuntimeAuthorityEffect(cwd, mode);
  return options.signal === undefined
    ? authority
    : Effect.raceFirst(authority, abortFailure(options.signal));
}

function ensureRuntimeAuthorityEffect(
  cwd: string,
  mode: RuntimeAuthorityMode,
): Effect.Effect<RuntimeAuthorityIdentity, CliDaemonFailure> {
  return Effect.gen(function* () {
    const clock = yield* Clock.Clock;
    const deadline = clock.currentTimeMillisUnsafe() + authorityStartTimeoutMs;
    let child: ChildProcess | undefined;
    let childState: SpawnState | undefined;
    let storePrepared = false;
    let predecessorShutdownAccepted = false;
    let predecessorOffline = false;

    while (clock.currentTimeMillisUnsafe() < deadline) {
      const status = yield* Effect.result(requestDaemonStatusProbe(cwd));
      if (Result.isSuccess(status)) {
        if (status.success.kind === "current") return status.success.status.authority;
        if (status.success.kind === "unknown") return yield* Effect.fail(runtimeUpdateBlocked(
          status.success.protocolVersion === undefined
            ? "The workspace daemon uses an unknown Runtime protocol. Use a matching or newer Acpus version."
            : `The workspace daemon uses unsupported protocol v${status.success.protocolVersion}. Use a matching or newer Acpus version.`,
        ));
        if (!predecessorShutdownAccepted) {
          const retired = yield* Effect.result(requestPredecessorDaemonShutdown(cwd));
          if (Result.isFailure(retired)) {
            return yield* Effect.fail(runtimeUpdateBlocked(
              retired.failure.type === "rejected" && retired.failure.code === "CONTROL_CONFLICT"
                ? "The previous Acpus daemon still has active work. Wait for it to finish, then retry."
                : `The previous Acpus daemon could not be retired safely: ${retired.failure.message}`,
            ));
          }
          predecessorShutdownAccepted = true;
        }
        yield* Effect.sleep(100);
        continue;
      }

      if (childState?.error !== undefined) {
        return yield* Effect.fail({
          type: "daemon-spawn-failed" as const,
          ...errnoField(childState.error),
          message: errorMessage(childState.error, "Daemon process could not be spawned."),
        });
      }
      if (childState?.exit !== undefined
        && clock.currentTimeMillisUnsafe() - childState.exit.observedAt >= competingDaemonGraceMs) {
        return yield* Effect.fail({
          type: "daemon-exited-before-ready" as const,
          exitCode: childState.exit.code,
          signal: childState.exit.signal,
          message: `Daemon exited before becoming ready${childState.exit.code === null ? "" : ` with code ${childState.exit.code}`}${childState.exit.signal === null ? "" : ` after ${childState.exit.signal}`}.`,
        });
      }
      if (isInitializingFailure(status.failure)) {
        yield* Effect.sleep(100);
        continue;
      }
      if (!isStartupConnectionFailure(status.failure)) {
        if (yield* probeDaemonEndpoint(cwd)) {
          return yield* Effect.fail(runtimeUpdateBlocked(
            `The workspace daemon could not be identified safely: ${status.failure.message}`,
          ));
        }
        return yield* Effect.fail({
          type: "daemon-status-failed" as const,
          failure: status.failure,
          message: status.failure.message,
        });
      }

      if (predecessorShutdownAccepted && (yield* probeDaemonEndpoint(cwd))) {
        yield* Effect.sleep(100);
        continue;
      }
      if (predecessorShutdownAccepted && !predecessorOffline) {
        const offline = yield* Effect.result(awaitRuntimeStoreOffline(cwd));
        if (Result.isFailure(offline)) return yield* Effect.fail(runtimeUpdateBlocked(
          `The previous Runtime authority has not released the store safely: ${offline.failure.message}`,
        ));
        predecessorOffline = true;
      }
      if (!storePrepared) {
        yield* prepareRuntimeStore(cwd, mode);
        storePrepared = true;
      }
      if (child === undefined) {
        const runtimeConfiguration = tryLoadRuntimeConfiguration(process.env);
        if (Result.isFailure(runtimeConfiguration)) {
          return yield* Effect.fail({
            type: "runtime-configuration-invalid" as const,
            message: runtimeConfiguration.failure.message,
          });
        }
        childState = {};
        child = yield* Effect.try({
          try: () => spawn(process.execPath, daemonEntryArgs(cwd), { cwd, detached: true, stdio: "ignore" }),
          catch: cause => ({
            type: "daemon-spawn-failed" as const,
            ...errnoField(cause),
            message: errorMessage(cause, "Daemon process could not be spawned."),
          }),
        });
        child.once("error", cause => { childState!.error = cause; });
        child.once("exit", (code, signal) => {
          childState!.exit = { code, signal, observedAt: clock.currentTimeMillisUnsafe() };
        });
        child.unref();
      }
      yield* Effect.sleep(100);
    }
    if (predecessorShutdownAccepted) {
      return yield* Effect.fail(runtimeUpdateBlocked(
        "The previous Acpus daemon did not release its endpoint and Runtime store before the update deadline. Wait for existing work to finish, then retry.",
      ));
    }
    return yield* Effect.fail({
      type: "daemon-start-timeout" as const,
      message: "Runtime authority did not become ready within 30 seconds.",
    });
  });
}

export function sendDaemonControl(
  cwd: string,
  intent: DaemonControlIntent,
): Effect.Effect<DaemonControlResult, DaemonControlFailure> {
  return Effect.gen(function* () {
    const ready = yield* Effect.result(ensureRuntimeAuthority(cwd, "control"));
    if (Result.isFailure(ready)) {
      return yield* Effect.fail(yield* controlFailure(
        cwd,
        intent,
        publicFailureCode(ready.failure),
        ready.failure,
      ));
    }
    const controlled = yield* Effect.result(requestDaemonControl(cwd, intent));
    if (Result.isSuccess(controlled)) return controlled.success;
    const code = controlled.failure.type === "rejected" ? controlled.failure.code : "EXECUTION_UNAVAILABLE";
    return yield* Effect.fail(yield* controlFailure(cwd, intent, code, controlled.failure));
  });
}

export function sendDaemonSubmitAndObserve(
  cwd: string,
  input: DaemonSubmitInput,
  options: { signal?: AbortSignal } = {},
): AsyncIterable<Result.Result<DaemonRunStreamFrame, CliDaemonFailure>> {
  const stream = options.signal === undefined
    ? submitAndObserveStream(cwd, input)
    : submitAndObserveStream(cwd, input).pipe(Stream.interruptWhen(awaitAbort(options.signal)));
  return Stream.toAsyncIterable(Stream.result(stream));
}

function submitAndObserveStream(
  cwd: string,
  input: DaemonSubmitInput,
): Stream.Stream<DaemonRunStreamFrame, CliDaemonFailure> {
  return Stream.unwrap(Effect.gen(function* () {
    const authority = yield* ensureRuntimeAuthority(cwd, "admission");
    let admittedRunId: string | undefined;
    let terminal = false;
    const stream: Stream.Stream<DaemonRunStreamFrame, SubmitAttemptFailure> = requestDaemonSubmitAndObserve(cwd, {
      expectedAuthority: authority,
      requestId: input.requestId,
      prepared: input.prepared,
      input: input.input,
      ...(input.agentInjections === undefined ? {} : { agentInjections: input.agentInjections }),
      until: input.until,
    }).pipe(
      Stream.mapError(failure => ({ type: "stream" as const, failure })),
      Stream.mapEffect((frame): Effect.Effect<DaemonRunStreamFrame, SubmitAttemptFailure> => {
        if (frame.kind === "admitted") {
          admittedRunId = frame.run.id;
          terminal = input.until === "admitted";
          return Effect.succeed(frame);
        }
        if (frame.kind === "observation") {
          terminal = frame.observation.kind === "closed";
          return Effect.succeed(frame);
        }
        terminal = true;
        if (frame.phase === "authority"
          && frame.outcome === "not-admitted"
          && frame.error.code === "AUTHORITY_MISMATCH") {
          return Effect.fail({ type: "retry" as const });
        }
        if (frame.outcome === "unknown") {
          return Effect.fail({ type: "retry" as const });
        }
        const runId = frame.runId ?? admittedRunId;
        return Effect.fail({
          type: "failure" as const,
          failure: {
            type: "request-failed" as const,
            method: "submitAndObserve" as const,
            code: frame.error.code,
            ...(runId === undefined ? {} : { runId }),
            message: frame.error.message,
          },
        });
      }),
    );
    return stream.pipe(
      Stream.concat(Stream.unwrap(Effect.sync((): Stream.Stream<never, SubmitAttemptFailure> => {
        if (terminal) return Stream.empty;
        if (admittedRunId !== undefined) {
          return Stream.fail({
            type: "failure" as const,
            failure: runtimeAuthorityLost(admittedRunId),
          });
        }
        return Stream.fail({ type: "retry-now" as const });
      }))),
      Stream.catch(reason => {
        if (reason.type === "retry") return retrySubmitAndObserve(cwd, input);
        if (reason.type === "retry-now") return retrySubmitAndObserve(cwd, input, false);
        if (reason.type === "failure") return Stream.fail(reason.failure);
        const failure = reason.failure;
        if (failure.type === "transport") {
          return admittedRunId === undefined
            ? retrySubmitAndObserve(cwd, input)
            : Stream.fail(runtimeAuthorityLost(admittedRunId));
        }
        if (failure.reason === "truncated" && admittedRunId !== undefined) {
          return Stream.fail(runtimeAuthorityLost(admittedRunId));
        }
        return Stream.fail({
          type: "daemon-stream-protocol-failed" as const,
          failure,
          message: failure.message,
        });
      }),
    );
  }));
}

function retrySubmitAndObserve(
  cwd: string,
  input: DaemonSubmitInput,
  delay = true,
): Stream.Stream<DaemonRunStreamFrame, CliDaemonFailure> {
  return delay
    ? Stream.unwrap(Effect.sleep(100).pipe(Effect.as(submitAndObserveStream(cwd, input))))
    : submitAndObserveStream(cwd, input);
}

function prepareRuntimeStore(
  cwd: string,
  mode: RuntimeAuthorityMode,
): Effect.Effect<void, CliDaemonFailure> {
  return Effect.gen(function* () {
    const inspected = yield* Effect.result(inspectRuntimeStore(cwd));
    if (Result.isFailure(inspected)) {
      return yield* Effect.fail(inspected.failure.type === "busy"
        ? runtimeUpdateBlocked("The Runtime store is currently in use. Wait for existing work to finish, then retry.")
        : {
            type: "runtime-store-unreadable" as const,
            message: "The Runtime store could not be read. Run 'acpus doctor'.",
          });
    }
    if (inspected.success.state === "unsupported") {
      return yield* Effect.fail({
        type: "runtime-store-unsupported" as const,
        message: `${inspected.success.message} Run 'acpus doctor'.`,
      });
    }
    if (inspected.success.state !== "repairable") return;
    if (mode === "control") {
      return yield* Effect.fail({
        type: "runtime-store-repair-required" as const,
        message: `${inspected.success.message} Run 'acpus doctor --fix'.`,
      });
    }
    const repaired = yield* Effect.result(repairRuntimeStore(cwd));
    if (Result.isSuccess(repaired)) return;
    if (repaired.failure.type === "unsupported") {
      return yield* Effect.fail({
        type: "runtime-store-unsupported" as const,
        message: `${repaired.failure.message} Run 'acpus doctor'.`,
      });
    }
    if (repaired.failure.type === "busy") {
      return yield* Effect.fail(runtimeUpdateBlocked(
        "The Runtime store still has active users. Wait for existing work to finish, then retry.",
      ));
    }
    if (repaired.failure.type === "unreadable") {
      return yield* Effect.fail({
        type: "runtime-store-unreadable" as const,
        message: `${repaired.failure.message} Run 'acpus doctor'.`,
      });
    }
    return yield* Effect.fail({
      type: "runtime-store-repair-failed" as const,
      message: "The Runtime store update did not complete. Its transition intent and original data were preserved. Run 'acpus doctor --fix'.",
    });
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

function controlFailure(
  cwd: string,
  intent: DaemonControlIntent,
  code: DaemonControlFailure["code"],
  cause: CliDaemonFailure | DaemonClientFailure,
): Effect.Effect<DaemonControlFailure> {
  return getRun(cwd, intent.runId).pipe(
    Effect.catchCause(() => Effect.succeed(undefined)),
    Effect.map(run => ({
      type: "control-failed" as const,
      code,
      controlType: intent.type,
      runId: intent.runId,
      run,
      cause,
      message: controlFailureMessage(code, intent.type, intent.runId, run, cause),
    })),
  );
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

function abortFailure(signal: AbortSignal): Effect.Effect<never, CliDaemonFailure> {
  return Effect.callback(resolve => {
    const onAbort = (): void => resolve(Effect.fail({
      type: "authority-wait-aborted",
      message: "Runtime authority wait was interrupted.",
    }));
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    return Effect.sync(() => signal.removeEventListener("abort", onAbort));
  });
}

function awaitAbort(signal: AbortSignal): Effect.Effect<void> {
  return Effect.callback(resolve => {
    const onAbort = (): void => resolve(Effect.void);
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    return Effect.sync(() => signal.removeEventListener("abort", onAbort));
  });
}
