import { spawn as spawnChild, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { Readable, Writable } from "node:stream";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import type * as Scope from "effect/Scope";
import {
  ProcessHost,
  type OwnedProcessError,
  type ProcessExit,
  type OwnedProcess,
  type ProcessIdentity,
  type ProcessIdentityLiveness,
  type ProcessLiveness,
  type ProcessOperation,
  type ProcessHostShape,
  type ProcessTarget,
  type SpawnOwnedProcessInput,
} from "./service.js";

type MessageQueue = Queue.Queue<unknown, OwnedProcessError | Cause.Done>;

type OwnedChild = Readonly<{
  child: ChildProcess;
  target: ProcessTarget;
  closed: Deferred.Deferred<ProcessExit, OwnedProcessError>;
  messages: MessageQueue;
  removeListeners(): void;
}>;

export const NodeProcessHostLive = Layer.succeed(ProcessHost, makeNodeProcessHost());

export function makeNodeProcessHost(): ProcessHostShape {
  const service = ProcessHost.of({
    spawn: spawn,
    signal: signalTarget,
    liveness: target => Effect.sync(() => probeProcessTarget(target)),
    startToken: pid => Effect.sync(() => readProcessStartToken(pid)),
    identityLiveness: (pid, startToken) => Effect.sync(() => probeProcessIdentity({
      pid,
      ...(startToken === undefined ? {} : { startToken }),
    })),
  });
  return service;
}

function spawn(input: SpawnOwnedProcessInput): Effect.Effect<OwnedProcess, OwnedProcessError, Scope.Scope> {
  return Effect.gen(function*() {
    const messages = yield* Queue.unbounded<unknown, OwnedProcessError | Cause.Done>();
    const closed = Deferred.makeUnsafe<ProcessExit, OwnedProcessError>();
    const owned = yield* Effect.acquireRelease(
      acquireChild(input, messages, closed),
      releaseChild,
    );
    return makeHandle(owned);
  });
}

function acquireChild(
  input: SpawnOwnedProcessInput,
  messages: MessageQueue,
  closed: Deferred.Deferred<ProcessExit, OwnedProcessError>,
): Effect.Effect<OwnedChild, OwnedProcessError> {
  return Effect.callback((resume) => {
    let child: ChildProcess;
    try {
      child = spawnChild(input.command, [...(input.args ?? [])], {
        ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
        ...(input.env === undefined ? {} : { env: { ...input.env } }),
        ...(input.shell === undefined ? {} : { shell: input.shell }),
        ...(input.detached === undefined ? {} : { detached: input.detached }),
        ...(input.windowsHide === undefined ? {} : { windowsHide: input.windowsHide }),
        stdio: [
          input.stdin ?? "pipe",
          input.stdout ?? "pipe",
          input.stderr ?? "pipe",
          ...(input.ipc ? ["ipc" as const] : []),
        ],
      });
    } catch (cause) {
      resume(Effect.fail(processError("spawn", cause, `Could not spawn '${input.command}'.`)));
      return;
    }

    let spawned = false;
    let target: ProcessTarget | undefined;
    const onMessage = (message: unknown) => {
      Queue.offerUnsafe(messages, message);
    };
    const onDisconnect = () => {
      Queue.endUnsafe(messages);
    };
    const onError = (cause: Error) => {
      const failure = processError(spawned ? "lifecycle" : "spawn", cause, cause.message);
      if (!spawned) resume(Effect.fail(failure));
      Deferred.doneUnsafe(closed, Effect.fail(failure));
      Queue.failCauseUnsafe(messages, Cause.fail(failure));
    };
    const onClose = (exitCode: number | null, signal: NodeJS.Signals | null) => {
      Deferred.doneUnsafe(closed, Effect.succeed({ exitCode, signal }));
      Queue.endUnsafe(messages);
      removeListeners();
    };
    const onSpawn = () => {
      if (child.pid === undefined) {
        const failure = processError("spawn", undefined, `Process '${input.command}' did not provide a pid.`);
        resume(Effect.fail(failure));
        return;
      }
      spawned = true;
      target = {
        pid: child.pid,
        ...(input.detached && globalThis.process.platform !== "win32"
          ? { processGroupId: child.pid }
          : {}),
      };
      resume(Effect.succeed({ child, target, closed, messages, removeListeners }));
    };
    const removeListeners = () => {
      child.off("spawn", onSpawn);
      child.off("message", onMessage);
      child.off("disconnect", onDisconnect);
      child.off("error", onError);
      child.off("close", onClose);
    };

    child.once("spawn", onSpawn);
    child.on("message", onMessage);
    child.once("disconnect", onDisconnect);
    child.on("error", onError);
    child.once("close", onClose);

    return Effect.sync(() => {
      if (spawned && target !== undefined) forceSignal(target);
      else if (child.pid !== undefined) forceSignal({ pid: child.pid });
      child.stdin?.destroy();
      removeListeners();
      Queue.endUnsafe(messages);
    });
  });
}

function releaseChild(owned: OwnedChild): Effect.Effect<void> {
  return Deferred.isDone(owned.closed).pipe(
    Effect.flatMap(done => done
      ? Effect.void
      : signalTarget(owned.target, "SIGKILL").pipe(Effect.ignore)),
    Effect.ensuring(Effect.sync(() => {
      owned.child.stdin?.destroy();
      owned.removeListeners();
      const failure = processError("lifecycle", undefined, `Process '${owned.target.pid}' Scope closed before process exit.`);
      Deferred.doneUnsafe(owned.closed, Effect.fail(failure));
      Queue.endUnsafe(owned.messages);
    })),
  );
}

function makeHandle(owned: OwnedChild): OwnedProcess {
  const stdin = owned.child.stdin === null
    ? undefined
    : Writable.toWeb(owned.child.stdin) as WritableStream<Uint8Array>;
  return {
    pid: owned.target.pid,
    target: owned.target,
    ...(stdin === undefined ? {} : { stdin }),
    stdout: readable(owned.child.stdout, "stdout"),
    stderr: readable(owned.child.stderr, "stderr"),
    messages: Stream.fromQueue(owned.messages),
    closed: Deferred.await(owned.closed),
    send: message => send(owned.child, message),
    signal: signal => signalTarget(owned.target, signal),
  };
}

function readable(stream: Readable | null, name: "stdout" | "stderr"): Stream.Stream<Uint8Array, OwnedProcessError> {
  if (stream === null) return Stream.empty;
  const web = Readable.toWeb(stream) as ReadableStream<Uint8Array>;
  return Stream.fromReadableStream({
    evaluate: () => web,
    onError: cause => processError("stream", cause, `Process ${name} failed.`),
  });
}

function send(child: ChildProcess, message: unknown): Effect.Effect<void, OwnedProcessError> {
  return Effect.callback(resume => {
    if (!child.connected) {
      resume(Effect.fail(processError("ipc", undefined, "Process IPC is closed.")));
      return;
    }
    try {
      child.send(message as Parameters<ChildProcess["send"]>[0], cause => {
        resume(cause === null
          ? Effect.void
          : Effect.fail(processError("ipc", cause, "Process IPC send failed.")));
      });
    } catch (cause) {
      resume(Effect.fail(processError("ipc", cause, "Process IPC send failed.")));
    }
  });
}

function signalTarget(target: ProcessTarget, signal: NodeJS.Signals): Effect.Effect<void, OwnedProcessError> {
  return Effect.gen(function*() {
    if (probeProcessTarget(target) === "dead") return;
    if (globalThis.process.platform === "win32") {
      yield* taskkill(target.pid, signal === "SIGKILL");
      return;
    }
    yield* Effect.try({
      try: () => globalThis.process.kill(target.processGroupId === undefined ? target.pid : -target.processGroupId, signal),
      catch: cause => processError("signal", cause, `Could not signal process target '${target.pid}'.`),
    }).pipe(Effect.catch(error => error.code === "ESRCH" ? Effect.void : Effect.fail(error)));
  });
}

function taskkill(pid: number, force: boolean): Effect.Effect<void, OwnedProcessError> {
  return Effect.callback(resume => {
    let child: ChildProcess;
    try {
      child = spawnChild("taskkill", ["/pid", String(pid), "/T", ...(force ? ["/F"] : [])], {
        stdio: "ignore",
        windowsHide: true,
      });
    } catch (cause) {
      resume(Effect.fail(processError("signal", cause, `Could not start taskkill for '${pid}'.`)));
      return;
    }
    child.once("error", cause => resume(Effect.fail(processError("signal", cause, `taskkill failed for '${pid}'.`))));
    child.once("close", code => {
      if (code === 0 || probeProcessTarget({ pid }) === "dead") resume(Effect.void);
      else resume(Effect.fail(processError("signal", undefined, `taskkill exited with code '${code ?? "null"}' for '${pid}'.`)));
    });
    return Effect.sync(() => child.kill("SIGKILL"));
  });
}

export function probeProcessTarget(target: ProcessTarget): ProcessLiveness {
  const pid = globalThis.process.platform === "win32" || target.processGroupId === undefined
    ? target.pid
    : -target.processGroupId;
  try {
    globalThis.process.kill(pid, 0);
    return "live";
  } catch (cause) {
    const code = errorCode(cause);
    return code === "EPERM" ? "live" : code === "ESRCH" ? "dead" : "unverified";
  }
}

export function captureProcessIdentity(pid: number = globalThis.process.pid): ProcessIdentity {
  const startToken = readProcessStartToken(pid);
  return {
    pid,
    ...(startToken === undefined ? {} : { startToken }),
  };
}

export function readProcessStartToken(pid: number): string | undefined {
  if (globalThis.process.platform !== "linux") return undefined;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = stat.lastIndexOf(")");
    const startTime = stat.slice(close + 2).trim().split(/\s+/u)[19];
    return startTime === undefined ? undefined : `linux:${startTime}`;
  } catch {
    return undefined;
  }
}

export function probeProcessIdentity(identity: ProcessIdentity): ProcessIdentityLiveness {
  const liveness = probeProcessTarget({ pid: identity.pid });
  if (liveness === "dead") return "absent";
  if (liveness === "unverified" || identity.startToken === undefined) return "unverified";
  const actual = readProcessStartToken(identity.pid);
  return actual === undefined ? "unverified" : actual === identity.startToken ? "match" : "mismatch";
}

function forceSignal(target: ProcessTarget): void {
  if (globalThis.process.platform === "win32") {
    try {
      spawnChild("taskkill", ["/pid", String(target.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).unref();
    } catch {}
    return;
  }
  try {
    globalThis.process.kill(target.processGroupId === undefined ? target.pid : -target.processGroupId, "SIGKILL");
  } catch {}
}

function processError(operation: ProcessOperation, cause: unknown, message: string): OwnedProcessError {
  const code = errorCode(cause);
  return {
    type: "process",
    operation,
    message,
    ...(code === undefined ? {} : { code }),
    cause,
  };
}

function errorCode(cause: unknown): string | undefined {
  return typeof cause === "object" && cause !== null && "code" in cause && typeof cause.code === "string"
    ? cause.code
    : undefined;
}
