import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { OwnedProcessError, ProcessExit, OwnedProcess, ProcessHostShape } from "@acpus/owned-process";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import type * as Scope from "effect/Scope";
import type { JsonValue } from "@acpus/expression/ir";
import { removeRunFile, verifyRunFile } from "../store/run-file.js";
import { resolveArtifactRegistrationPath } from "../artifacts/registration-path.js";
import { verifyRunDirectoryToken } from "../store/path-fence.js";
import type { RuntimeStoreBusy, RuntimeStoreShape } from "../store/service.js";
import type { SchedulerStoreError } from "../scheduler/store-port.js";
import type { TaskArtifactRegistration, TaskProcessChildMessage, TaskProcessParentMessage, TaskProcessRequest } from "./task-process-protocol.js";

const COOPERATIVE_ABORT_GRACE_MS = 1_000;
const FORCE_KILL_GRACE_MS = 5_000;
const OUTPUT_TAIL_LIMIT = 8 * 1024;

export type TaskAttemptFailure = {
  type: "failed" | "cancelled" | "timed_out";
  message: string;
};

type RunTaskAttemptInput = {
  nodeId: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  request: TaskProcessRequest;
  timeoutMs?: number;
  processes: ProcessHostShape;
  store: Pick<RuntimeStoreShape, "registerArtifact">;
};

type TaskTerminal =
  | { type: "completed"; output?: JsonValue }
  | { type: "failed"; failure: TaskAttemptFailure };

type ProcessRace =
  | { type: "closed"; result: Result.Result<ProcessExit, OwnedProcessError> }
  | { type: "messages"; exit: Exit.Exit<void, OwnedProcessError> };

export function runTaskAttempt(input: RunTaskAttemptInput): Effect.Effect<Result.Result<JsonValue | undefined, TaskAttemptFailure>> {
  return Effect.scoped(runTaskProcess(input));
}

function runTaskProcess(input: RunTaskAttemptInput): Effect.Effect<Result.Result<JsonValue | undefined, TaskAttemptFailure>, never, Scope.Scope> {
  const timeoutFailure = (): TaskAttemptFailure => ({
    type: "timed_out",
    message: `Task node '${input.nodeId}' timed out after ${input.timeoutMs ?? 0}ms.`,
  });
  const timeout: Result.Result<JsonValue | undefined, TaskAttemptFailure> = Result.fail(timeoutFailure());
  return Effect.gen(function* () {
    const timeoutStartedAt = input.timeoutMs === undefined ? undefined : yield* Clock.monotonicTimeNanos;
    const timeoutExpired = remainingBudget(input.timeoutMs, timeoutStartedAt).pipe(
      Effect.map(remaining => remaining !== undefined && remaining <= 0),
    );
    const spawn = Effect.result(input.processes.spawn({
      command: process.execPath,
      args: taskProcessEntryArgs(),
      cwd: input.cwd,
      env: input.env,
      detached: process.platform !== "win32",
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      ipc: true,
    })).pipe(Effect.map(result => ({ type: "spawn" as const, result })));
    const initialRemaining = yield* remainingBudget(input.timeoutMs, timeoutStartedAt);
    const acquire = initialRemaining === undefined
      ? spawn
      : Effect.raceFirst(spawn, Effect.sleep(initialRemaining).pipe(Effect.as({ type: "timeout" as const })));
    const acquired = yield* acquire;
    if (acquired.type === "timeout") return timeout;
    if (Result.isFailure(acquired.result)) {
      return (yield* timeoutExpired) ? timeout : Result.fail(processFailure(input, acquired.result.failure));
    }
    const child = acquired.result.success;
    if (yield* timeoutExpired) {
      yield* terminateTaskProcess(child);
      return timeout;
    }

    const protocol = runTaskProtocol(input, child, timeoutExpired).pipe(
      Effect.catch(error => Effect.succeed(Result.fail(processFailure(input, error)))),
    );
    const remaining = yield* remainingBudget(input.timeoutMs, timeoutStartedAt);
    const use = remaining === undefined
      ? protocol
      : Effect.raceFirst(
          protocol,
          Effect.sleep(remaining).pipe(
            Effect.andThen(terminateTaskProcess(child)),
            Effect.as(timeout),
          ),
        );
    return yield* use.pipe(Effect.onInterrupt(() => terminateTaskProcess(child)));
  });
}

function runTaskProtocol(
  input: RunTaskAttemptInput,
  child: OwnedProcess,
  timeoutExpired: Effect.Effect<boolean>,
): Effect.Effect<Result.Result<JsonValue | undefined, TaskAttemptFailure>, OwnedProcessError> {
  return Effect.scoped(Effect.gen(function* () {
    let terminal: TaskTerminal | undefined;
    const stdout = yield* Effect.forkScoped(Stream.runFold(child.stdout, () => "", appendTail));
    const stderr = yield* Effect.forkScoped(Stream.runFold(child.stderr, () => "", appendTail));
    const messages = yield* Effect.forkScoped(Stream.runForEach(child.messages, raw => Effect.gen(function* () {
      if (!isChildMessage(raw)) {
        if (yield* timeoutExpired) return;
        terminal ??= { type: "failed", failure: { type: "failed", message: "Task process sent an invalid IPC message." } };
        yield* child.signal("SIGTERM").pipe(Effect.ignore);
        return;
      }
      if (raw.type === "artifact_register") {
        yield* handleArtifactRegistration(input, child, raw, terminal !== undefined || (yield* timeoutExpired));
        return;
      }
      if ((yield* timeoutExpired) || terminal !== undefined) return;
      if (raw.type === "completed") {
        terminal = raw.hasOutput ? { type: "completed", output: raw.output } : { type: "completed" };
      } else if (raw.type === "failed") {
        terminal = { type: "failed", failure: { type: "failed", message: raw.message } };
      } else {
        return yield* Effect.die(taskProcessSystemError(raw.error));
      }
    })));

    yield* send(child, { type: "start", request: input.request });
    const closed = yield* awaitProcessAndMessages(child, messages);
    const stdoutExit = yield* Fiber.await(stdout);
    const stderrExit = yield* Fiber.await(stderr);
    if (Exit.isFailure(stdoutExit)) return yield* Effect.failCause(stdoutExit.cause);
    if (Exit.isFailure(stderrExit)) return yield* Effect.failCause(stderrExit.cause);
    if (Result.isFailure(closed)) return Result.fail(processFailure(input, closed.failure));
    if (yield* timeoutExpired) return Result.fail({
      type: "timed_out",
      message: `Task node '${input.nodeId}' timed out after ${input.timeoutMs ?? 0}ms.`,
    });
    if (terminal?.type === "completed") return Result.succeed(terminal.output);
    if (terminal?.type === "failed") return Result.fail(terminal.failure);
    const detail = [stderrExit.value.trim(), stdoutExit.value.trim()].filter(Boolean).join("\n");
    const { exitCode, signal } = closed.success;
    return Result.fail({
      type: "failed",
      message: `Task process for node '${input.nodeId}' exited without a result${exitCode === null ? "" : ` (code ${exitCode})`}${signal ? ` (${signal})` : ""}.${detail ? ` ${detail}` : ""}`,
    });
  }));
}

function handleArtifactRegistration(
  input: RunTaskAttemptInput,
  child: OwnedProcess,
  message: Extract<TaskProcessChildMessage, { type: "artifact_register" }>,
  closed: boolean,
): Effect.Effect<void, OwnedProcessError> {
  return Effect.gen(function* () {
    let error: string | undefined;
    let identityAccepted = false;
    try {
      assertArtifactIdentity(input.request, message.artifact);
      identityAccepted = true;
      if (closed) throw new Error("Task attempt is no longer accepting artifacts.");
    } catch (cause) {
      error = causeMessage(cause);
    }
    if (error !== undefined) {
      if (identityAccepted) {
        const removed = yield* Effect.exit(removeRejectedArtifact(input.request, message.artifact));
        if (Exit.isFailure(removed)) {
          yield* child.signal("SIGTERM").pipe(Effect.ignore);
          return yield* Effect.die(new AggregateError([
            new Error(error),
            Cause.squash(removed.cause),
          ], "Artifact rejection and cleanup both failed."));
        }
      }
      yield* send(child, { type: "artifact_result", requestId: message.requestId, ok: false, error });
      return;
    }

    const registered = yield* Effect.exit(input.store.registerArtifact(message.artifact).pipe(
      Effect.mapError(storeFailureValue),
      Effect.orDie,
    ));
    if (Exit.isSuccess(registered)) {
      yield* send(child, { type: "artifact_result", requestId: message.requestId, ok: true });
      return;
    }
    const registrationFailure = Cause.squash(registered.cause);
    const removed = yield* Effect.exit(removeRejectedArtifact(input.request, message.artifact));
    const failure = Exit.isFailure(removed)
      ? new AggregateError([
          registrationFailure,
          Cause.squash(removed.cause),
        ], "Artifact registration failed and its unregistered file could not be removed.")
      : registrationFailure;
    yield* send(child, {
      type: "artifact_result",
      requestId: message.requestId,
      ok: false,
      error: causeMessage(registrationFailure),
    }).pipe(Effect.ignore);
    yield* child.signal("SIGTERM").pipe(Effect.ignore);
    return yield* Effect.die(failure);
  });
}

function awaitProcessAndMessages(
  child: OwnedProcess,
  messages: Fiber.Fiber<void, OwnedProcessError>,
): Effect.Effect<Result.Result<ProcessExit, OwnedProcessError>, OwnedProcessError> {
  const closed = Effect.result(child.closed).pipe(
    Effect.map(result => ({ type: "closed" as const, result } satisfies ProcessRace)),
  );
  const drained = Fiber.await(messages).pipe(
    Effect.map(exit => ({ type: "messages" as const, exit } satisfies ProcessRace)),
  );
  return Effect.gen(function* () {
    const first = yield* Effect.raceFirst(closed, drained);
    if (first.type === "messages") {
      if (Exit.isFailure(first.exit)) return yield* Effect.failCause(first.exit.cause);
      return yield* Effect.result(child.closed);
    }
    const messageExit = yield* Fiber.await(messages);
    if (Exit.isFailure(messageExit)) return yield* Effect.failCause(messageExit.cause);
    return first.result;
  });
}

function send(child: OwnedProcess, message: TaskProcessParentMessage): Effect.Effect<void, OwnedProcessError> {
  return child.send(message).pipe(
    Effect.catch(error => Effect.die(taskProcessSystemError({
      message: `Task process IPC failed: ${error.message}`,
      ...(error.code === undefined ? {} : { code: error.code }),
    }))),
  );
}

function terminateTaskProcess(child: OwnedProcess): Effect.Effect<void> {
  return Effect.gen(function* () {
    yield* child.send({ type: "abort" } satisfies TaskProcessParentMessage).pipe(Effect.ignore);
    if (yield* exitsWithin(child, COOPERATIVE_ABORT_GRACE_MS)) return;
    yield* child.signal("SIGTERM").pipe(Effect.ignore);
    if (yield* exitsWithin(child, FORCE_KILL_GRACE_MS)) return;
    yield* child.signal("SIGKILL").pipe(Effect.ignore);
    yield* exitsWithin(child, FORCE_KILL_GRACE_MS);
  });
}

function exitsWithin(child: OwnedProcess, milliseconds: number): Effect.Effect<boolean> {
  return Effect.raceFirst(
    child.closed.pipe(Effect.as(true), Effect.catch(() => Effect.succeed(true))),
    Effect.sleep(milliseconds).pipe(Effect.as(false)),
  );
}

function remainingBudget(timeoutMs: number | undefined, startedAt: bigint | undefined): Effect.Effect<number | undefined> {
  if (timeoutMs === undefined || startedAt === undefined) return Effect.succeed(undefined);
  return Clock.monotonicTimeNanos.pipe(Effect.map(now => {
    const elapsedMs = Number(now > startedAt ? now - startedAt : 0n) / 1_000_000;
    return Math.max(0, timeoutMs - elapsedMs);
  }));
}

function processFailure(input: RunTaskAttemptInput, error: OwnedProcessError): TaskAttemptFailure {
  const code = error.code && !error.message.includes(error.code) ? ` (${error.code})` : "";
  return {
    type: "failed",
    message: `Task process for node '${input.nodeId}' could not complete in '${input.cwd}': ${error.message}${code}`,
  };
}

function storeFailureValue(error: SchedulerStoreError | RuntimeStoreBusy): unknown {
  return error.type === "runtime-store-busy" ? error.cause : error;
}

function taskProcessEntryArgs(): string[] {
  const sourceMode = fileURLToPath(import.meta.url).endsWith(".ts");
  const entry = fileURLToPath(new URL(`./task-process-entry.${sourceMode ? "ts" : "js"}`, import.meta.url));
  return sourceMode
    ? ["--import", import.meta.resolve("tsx"), "--import", sourcePackageResolverImport(), entry]
    : [entry];
}

function sourcePackageResolverImport(): string {
  const entries = [
    ["@acpus/loader", new URL("../../../loader/src/index.ts", import.meta.url).href],
    ["@acpus/core", new URL("../../../core/src/index.ts", import.meta.url).href],
    ["@acpus/core/content-identity", new URL("../../../core/src/content-identity.ts", import.meta.url).href],
    ["@acpus/core/runtime", new URL("../../../core/src/runtime.ts", import.meta.url).href],
    ["@acpus/expression", new URL("../../../expression/src/index.ts", import.meta.url).href],
    ["@acpus/expression/evaluator", new URL("../../../expression/src/evaluator.ts", import.meta.url).href],
    ["@acpus/expression/ir", new URL("../../../expression/src/ir.ts", import.meta.url).href],
    ["@acpus/expression/validator", new URL("../../../expression/src/validator.ts", import.meta.url).href],
  ];
  const loader = `
const aliases = new Map(${JSON.stringify(entries)});
export function resolve(specifier, context, nextResolve) {
  const url = aliases.get(specifier);
  return url ? { url, shortCircuit: true } : nextResolve(specifier, context);
}
`;
  const bootstrap = `import { register } from "node:module"; register(${JSON.stringify(`data:text/javascript,${encodeURIComponent(loader)}`)}, import.meta.url);`;
  return `data:text/javascript,${encodeURIComponent(bootstrap)}`;
}

function assertArtifactIdentity(request: TaskProcessRequest, artifact: TaskArtifactRegistration): void {
  if (artifact.runId !== request.artifact.run.runId
    || artifact.nodeKey !== request.artifact.nodeKey
    || artifact.attemptId !== request.artifact.attemptId
    || artifact.attempt !== request.artifact.attempt
    || artifact.ownerEpoch !== request.artifact.ownerEpoch) {
    throw new Error("Task process artifact identity does not match its attempt.");
  }
  const runDir = verifyRunDirectoryToken(request.artifact.run);
  const path = resolveArtifactRegistrationPath({
    runDir,
    nodeKey: artifact.nodeKey,
    attempt: artifact.attempt,
    relativePath: artifact.relativePath,
  });
  if (!path
    || typeof artifact.id !== "string"
    || !basename(path).startsWith(`${artifact.id}-`)
    || !artifact.file
    || typeof artifact.file.path !== "string"
    || resolve(artifact.file.path) !== path) {
    throw new Error("Task process artifact path is outside its attempt artifact directory.");
  }
  verifyRunFile(request.artifact.run, artifact.file, `Task artifact '${artifact.id}'`);
}

function removeRejectedArtifact(request: TaskProcessRequest, artifact: TaskArtifactRegistration): Effect.Effect<void> {
  return Effect.suspend(() => {
    const runDir = verifyRunDirectoryToken(request.artifact.run);
    const path = resolveArtifactRegistrationPath({
      runDir,
      nodeKey: artifact.nodeKey,
      attempt: artifact.attempt,
      relativePath: artifact.relativePath,
    });
    return !path || resolve(artifact.file.path) !== path
      ? Effect.void
      : Effect.promise(() => removeRunFile(request.artifact.run, artifact.file, `Task artifact '${artifact.id}'`));
  });
}

function appendTail(previous: string, chunk: unknown): string {
  const next = previous + Buffer.from(chunk as Uint8Array).toString("utf8");
  return next.length <= OUTPUT_TAIL_LIMIT ? next : next.slice(next.length - OUTPUT_TAIL_LIMIT);
}

function isChildMessage(value: unknown): value is TaskProcessChildMessage {
  if (!value || typeof value !== "object" || !("type" in value)) return false;
  const message = value as Record<string, unknown>;
  if (message.type === "artifact_register") return typeof message.requestId === "string" && Boolean(message.artifact) && typeof message.artifact === "object";
  if (message.type === "completed") return typeof message.hasOutput === "boolean" && (!message.hasOutput || "output" in message);
  if (message.type === "failed") return typeof message.message === "string";
  if (message.type !== "system_rejected" || !message.error || typeof message.error !== "object") return false;
  const error = message.error as Record<string, unknown>;
  return typeof error.message === "string" && (error.code === undefined || typeof error.code === "string");
}

function taskProcessSystemError(input: { message: string; code?: string }): Error {
  const error = new Error(input.message);
  error.name = "TaskProcessSystemError";
  if (input.code !== undefined) Object.assign(error, { code: input.code });
  return error;
}

function causeMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
