import { NodeRuntime } from "@effect/platform-node";
import {
  openAcpSession,
  type AcpSession,
  type AcpSessionConfiguration,
} from "@acpus/acp";
import { AcpTransportNodeLive, type AcpTransport } from "@acpus/acp/transport";
import type { ProcessHost } from "@acpus/owned-process";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FiberSet from "effect/FiberSet";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Result from "effect/Result";
import type * as Scope from "effect/Scope";
import type { ProcessCapsuleError } from "./types.js";
import {
  ACP_WORKER_PROTOCOL_VERSION,
  isAcpWorkerParentMessage,
  type AcpWorkerChildMessage,
  type AcpWorkerParentMessage,
  type ProcessCapsuleTerminal,
} from "./worker-protocol.js";

const INHERIT_PROCESS_GROUP_ENV = "ACPUS_INTERNAL_ACP_INHERIT_PROCESS_GROUP";

type WorkerIdentity = { hostId: string; sessionLeaseId: string };

type InitializedWorker = WorkerIdentity & {
  configuration: Readonly<{ model?: string; options: Readonly<Record<string, string>> }>;
  session: AcpSession;
};

type ActiveTurn = {
  readonly turnId: string;
  readonly fiber: Fiber.Fiber<void>;
};

type WorkerState = {
  identity?: WorkerIdentity;
  initialized?: InitializedWorker;
  active?: ActiveTurn;
  closing: boolean;
};

type WorkerStop = {
  readonly exitCode: 0 | 1;
  readonly reason: string;
  readonly report?: ProcessCapsuleError;
};

type WorkerEvent =
  | Readonly<{ type: "parent"; message: AcpWorkerParentMessage }>
  | Readonly<{ type: "disconnect" }>
  | Readonly<{ type: "stop"; stop: WorkerStop }>;

const main = Effect.scoped(Effect.gen(function*() {
  const events = yield* Queue.unbounded<WorkerEvent>();
  const children = yield* FiberSet.make<void>();
  const state: WorkerState = { closing: false };
  yield* observeParent(events);

  const loop = yield* Effect.exit(workerLoop(state, events, children));
  const stop = Exit.isSuccess(loop)
    ? loop.value
    : stopFromCause(state, loop.cause);
  state.closing = true;
  if (stop.report !== undefined && state.identity !== undefined) {
    send({
      type: "failed",
      protocolVersion: ACP_WORKER_PROTOCOL_VERSION,
      ...state.identity,
      error: stop.report,
    });
  }
  yield* Effect.sync(() => {
    process.exitCode = stop.exitCode;
  });
  yield* closeWorker(state, children, stop.reason);
}).pipe(Effect.provide(AcpTransportNodeLive)));

NodeRuntime.runMain(main, { disableErrorReporting: true });

function observeParent(events: Queue.Queue<WorkerEvent>): Effect.Effect<void, never, Scope.Scope> {
  return Effect.acquireRelease(
    Effect.sync(() => {
      const onMessage = (raw: unknown): void => {
        if (isAcpWorkerParentMessage(raw)) {
          Queue.offerUnsafe(events, { type: "parent", message: raw });
        }
      };
      const onDisconnect = (): void => {
        Queue.offerUnsafe(events, { type: "disconnect" });
      };
      process.on("message", onMessage);
      process.once("disconnect", onDisconnect);
      return { onMessage, onDisconnect };
    }),
    handlers => Effect.sync(() => {
      process.off("message", handlers.onMessage);
      process.off("disconnect", handlers.onDisconnect);
    }),
  ).pipe(Effect.asVoid);
}

function workerLoop(
  state: WorkerState,
  events: Queue.Queue<WorkerEvent>,
  children: FiberSet.FiberSet<void>,
): Effect.Effect<
  WorkerStop,
  ProcessCapsuleError,
  AcpTransport | ProcessHost | Scope.Scope
> {
  return Effect.gen(function*() {
    while (true) {
      const event = yield* Queue.take(events);
      if (event.type === "disconnect") {
        return { exitCode: 0, reason: "parent disconnected" };
      }
      if (event.type === "stop") return event.stop;
      const message = event.message;
      if (message.type === "open") {
        if (state.identity !== undefined) {
          return yield* Effect.fail(capsuleFailure(
            state,
            "worker_exception",
            new Error("ACP worker received duplicate initialization."),
          ));
        }
        state.identity = identityOfMessage(message.input);
        yield* FiberSet.run(children, openWorker(state, events, message));
        continue;
      }
      if (message.type === "close") {
        return { exitCode: 0, reason: message.reason };
      }
      const initialized = requireInitialized(state, message);
      if (message.type === "run") {
        if (state.active !== undefined) {
          return yield* Effect.fail(capsuleFailure(
            state,
            "worker_exception",
            new Error("ACP worker received a second active Turn."),
          ));
        }
        const fiber = yield* FiberSet.run(
          children,
          runTurn(state, events, initialized, message.turnId, message.prompt),
        );
        state.active = { turnId: message.turnId, fiber };
        continue;
      }
      if (state.active?.turnId === message.turnId) {
        yield* Fiber.interrupt(state.active.fiber);
      }
    }
  });
}

function openWorker(
  state: WorkerState,
  events: Queue.Queue<WorkerEvent>,
  message: Extract<AcpWorkerParentMessage, { type: "open" }>,
): Effect.Effect<void, never, AcpTransport | ProcessHost | Scope.Scope> {
  const input = message.input;
  return Effect.gen(function*() {
    const opened = yield* Effect.result(openAcpSession({
      agentSessionId: input.agentSessionId,
      sessionOpenMode: input.sessionOpenMode,
      stateDirectory: input.sessionStateDirectory,
      launch: input.resolvedLaunch,
      cwd: input.cwd,
      env: {
        ...input.env,
        ...(process.env[INHERIT_PROCESS_GROUP_ENV] === undefined
          ? {}
          : { [INHERIT_PROCESS_GROUP_ENV]: process.env[INHERIT_PROCESS_GROUP_ENV] }),
      },
      permissionMode: input.permissionMode,
      configuration: {
        model: input.configuration.model ?? null,
        options: input.configuration.options,
      },
    }));
    if (Result.isFailure(opened)) {
      if (!state.closing) {
        send({
          type: "open_failed",
          protocolVersion: ACP_WORKER_PROTOCOL_VERSION,
          ...identityOfMessage(input),
          error: opened.failure,
        });
        Queue.offerUnsafe(events, {
          type: "stop",
          stop: { exitCode: 1, reason: "worker failure" },
        });
      }
      return;
    }
    state.initialized = {
      ...identityOfMessage(input),
      configuration: input.configuration,
      session: opened.success,
    };
    if (!state.closing) {
      send({
        type: "ready",
        protocolVersion: ACP_WORKER_PROTOCOL_VERSION,
        ...identityOfMessage(input),
        projectionRef: opened.success.projectionPath,
        ...(opened.success.reportedVersion === undefined
          ? {}
          : { reportedVersion: opened.success.reportedVersion }),
      });
    }
  }).pipe(Effect.catchCause(cause => childFailed(state, events, cause)));
}

function runTurn(
  state: WorkerState,
  events: Queue.Queue<WorkerEvent>,
  initialized: InitializedWorker,
  turnId: string,
  prompt: string,
): Effect.Effect<void> {
  return Effect.gen(function*() {
    const configuration = turnConfiguration(initialized);
    const result = yield* Effect.result(initialized.session.runTurn({
      prompt,
      ...(configuration === undefined ? {} : { configuration }),
      onEvent: event => send({
        type: "event",
        protocolVersion: ACP_WORKER_PROTOCOL_VERSION,
        ...identityOf(initialized),
        turnId,
        event,
      }),
    }));
    const terminal: ProcessCapsuleTerminal = Result.isSuccess(result)
      ? { type: "provider_result", result: result.success }
      : result.failure.providerEvidence === "terminal_response"
        ? { type: "provider_error_response", error: result.failure }
        : { type: "local_error", error: result.failure };
    send({
      type: "terminal",
      protocolVersion: ACP_WORKER_PROTOCOL_VERSION,
      ...identityOf(initialized),
      turnId,
      terminal,
    });
    if (state.active?.turnId === turnId) delete state.active;
  }).pipe(Effect.catchCause(cause => {
    if (state.active?.turnId === turnId) delete state.active;
    return childFailed(state, events, cause);
  }));
}

function childFailed(
  state: WorkerState,
  events: Queue.Queue<WorkerEvent>,
  cause: Cause.Cause<never>,
): Effect.Effect<void> {
  if (state.closing && Cause.hasInterruptsOnly(cause)) return Effect.void;
  return Effect.sync(() => {
    Queue.offerUnsafe(events, {
      type: "stop",
      stop: {
        exitCode: 1,
        reason: "worker failure",
        report: capsuleFailure(state, "worker_exception", Cause.squash(cause)),
      },
    });
  });
}

function closeWorker(
  state: WorkerState,
  children: FiberSet.FiberSet<void>,
  reason: string,
): Effect.Effect<void> {
  return Effect.uninterruptible(Effect.gen(function*() {
    yield* FiberSet.clear(children);
    yield* FiberSet.awaitEmpty(children);
    if (state.initialized !== undefined) {
      yield* Effect.result(state.initialized.session.close(reason));
    }
    if (state.identity !== undefined) {
      send({
        type: "closed",
        protocolVersion: ACP_WORKER_PROTOCOL_VERSION,
        ...state.identity,
      });
    }
    yield* Effect.sync(() => {
      process.disconnect?.();
    });
  }));
}

function stopFromCause(state: WorkerState, cause: Cause.Cause<ProcessCapsuleError>): WorkerStop {
  if (Cause.hasInterruptsOnly(cause)) {
    return { exitCode: 0, reason: "worker interrupted" };
  }
  const typed = Cause.findErrorOption(cause);
  return {
    exitCode: 1,
    reason: "worker failure",
    report: Option.isSome(typed)
      ? typed.value
      : capsuleFailure(state, "worker_exception", Cause.squash(cause)),
  };
}

function turnConfiguration(state: InitializedWorker): AcpSessionConfiguration | undefined {
  if (state.configuration.model === undefined
    && Object.keys(state.configuration.options).length === 0) return undefined;
  return {
    ...(state.configuration.model === undefined ? {} : { model: state.configuration.model }),
    ...(Object.keys(state.configuration.options).length === 0
      ? {}
      : { options: state.configuration.options }),
  };
}

function send(message: AcpWorkerChildMessage): void {
  if (process.connected) process.send?.(message);
}

function requireInitialized(
  state: WorkerState,
  message: Exclude<AcpWorkerParentMessage, { type: "open" | "close" }>,
): InitializedWorker {
  const initialized = state.initialized;
  if (initialized === undefined
    || initialized.hostId !== message.hostId
    || initialized.sessionLeaseId !== message.sessionLeaseId) {
    throw new Error("ACP worker received a message before initialization.");
  }
  return initialized;
}

function identityOf(state: InitializedWorker): WorkerIdentity {
  return { hostId: state.hostId, sessionLeaseId: state.sessionLeaseId };
}

function identityOfMessage(message: WorkerIdentity): WorkerIdentity {
  return { hostId: message.hostId, sessionLeaseId: message.sessionLeaseId };
}

function capsuleFailure(
  state: WorkerState,
  code: ProcessCapsuleError["code"],
  error: unknown,
): ProcessCapsuleError {
  return {
    type: "process_capsule",
    phase: state.initialized
      ? state.active
        ? "running"
        : "ready"
      : state.identity
        ? "opening"
        : "bootstrap",
    code,
    message: error instanceof Error ? error.message : String(error),
  };
}
