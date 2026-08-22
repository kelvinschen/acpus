import {
  PROTOCOL_VERSION,
  RequestError,
  client,
  methods,
  ndJsonStream,
  type CloseSessionResponse,
  type AnyMessage,
  type CreateTerminalRequest,
  type CreateTerminalResponse,
  type InitializeResponse,
  type KillTerminalRequest,
  type KillTerminalResponse,
  type LoadSessionResponse,
  type NewSessionResponse,
  type PromptResponse,
  type ReadTextFileRequest,
  type ReadTextFileResponse,
  type ReleaseTerminalRequest,
  type ReleaseTerminalResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type ResumeSessionResponse,
  type SessionUpdate,
  type SetSessionConfigOptionResponse,
  type TerminalOutputRequest,
  type TerminalOutputResponse,
  type WaitForTerminalExitRequest,
  type WaitForTerminalExitResponse,
  type WriteTextFileRequest,
  type WriteTextFileResponse,
  type Stream as SdkStream,
} from "@agentclientprotocol/sdk";
import {
  NodeProcessHostLive,
  ProcessHost,
  type OwnedProcessError,
  type ProcessExit,
} from "@acpus/owned-process";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import type * as Scope from "effect/Scope";
import { interruptOnAbort } from "./cancellation.js";
import { ClientOperationIssue } from "./reverse-rpc.js";
import type { AcpError, AcpLaunch, AcpOperation } from "./types.js";

const PROVIDER_EXIT_PRIORITY_MS = 100;
const INHERIT_PROCESS_GROUP_ENV = "ACPUS_INTERNAL_ACP_INHERIT_PROCESS_GROUP";

export type AcpTransportClientHandlers = Readonly<{
  requestPermission(params: RequestPermissionRequest): Effect.Effect<RequestPermissionResponse, ClientOperationIssue>;
  readTextFile(params: ReadTextFileRequest): Effect.Effect<ReadTextFileResponse, ClientOperationIssue>;
  writeTextFile(params: WriteTextFileRequest): Effect.Effect<WriteTextFileResponse, ClientOperationIssue>;
  createTerminal(params: CreateTerminalRequest): Effect.Effect<CreateTerminalResponse, ClientOperationIssue>;
  terminalOutput(params: TerminalOutputRequest): Effect.Effect<TerminalOutputResponse, ClientOperationIssue>;
  waitForTerminalExit(params: WaitForTerminalExitRequest): Effect.Effect<WaitForTerminalExitResponse, ClientOperationIssue>;
  killTerminal(params: KillTerminalRequest): Effect.Effect<KillTerminalResponse, ClientOperationIssue>;
  releaseTerminal(params: ReleaseTerminalRequest): Effect.Effect<ReleaseTerminalResponse, ClientOperationIssue>;
}>;

export type AcpTransportConnectInput = Readonly<{
  launch: AcpLaunch;
  cwd: string;
  env?: Readonly<NodeJS.ProcessEnv>;
  handlers: AcpTransportClientHandlers;
}>;

export type AcpTransportUpdate = Readonly<{
  update: SessionUpdate;
  promptEpoch?: number;
  promptSequence?: number;
}>;

export type AcpTransportPromptResult = Readonly<{
  response: PromptResponse;
  promptEpoch: number;
  updateFence: number;
}>;

export type AcpTransportConnection = Readonly<{
  updates: Stream.Stream<AcpTransportUpdate, AcpError>;
  closed: Effect.Effect<ProcessExit, AcpError>;
  initialize(): Effect.Effect<InitializeResponse, AcpError>;
  newSession(cwd: string): Effect.Effect<NewSessionResponse, AcpError>;
  resumeSession(sessionId: string, cwd: string): Effect.Effect<ResumeSessionResponse, AcpError>;
  loadSession(sessionId: string, cwd: string): Effect.Effect<LoadSessionResponse, AcpError>;
  setConfigOption(sessionId: string, configId: string, value: string): Effect.Effect<SetSessionConfigOptionResponse, AcpError>;
  prompt(sessionId: string, prompt: string): Effect.Effect<AcpTransportPromptResult, AcpError>;
  cancel(sessionId: string): Effect.Effect<void, AcpError>;
  closeSession(sessionId: string): Effect.Effect<CloseSessionResponse, AcpError>;
  signal(signal: NodeJS.Signals): Effect.Effect<void, AcpError>;
  liveness(): Effect.Effect<"live" | "dead" | "unverified">;
  close(reason?: unknown): Effect.Effect<void, AcpError>;
}>;

export type AcpTransportShape = Readonly<{
  connect(
    input: AcpTransportConnectInput,
  ): Effect.Effect<AcpTransportConnection, AcpError, ProcessHost | Scope.Scope>;
}>;

export class AcpTransport extends Context.Service<AcpTransport, AcpTransportShape>()(
  "acpus/acp/AcpTransport",
) {}

export const AcpTransportLive = Layer.succeed(AcpTransport, AcpTransport.of({
  connect: connectTransport,
}));

export const AcpTransportNodeLive = Layer.merge(AcpTransportLive, NodeProcessHostLive);

function connectTransport(
  input: AcpTransportConnectInput,
): Effect.Effect<AcpTransportConnection, AcpError, ProcessHost | Scope.Scope> {
  return Effect.gen(function*() {
    const processes = yield* ProcessHost;
    const inheritedGroup = globalThis.process.env[INHERIT_PROCESS_GROUP_ENV] !== undefined
      && input.env?.[INHERIT_PROCESS_GROUP_ENV] === globalThis.process.env[INHERIT_PROCESS_GROUP_ENV];
    const env = { ...globalThis.process.env, ...input.env };
    delete env[INHERIT_PROCESS_GROUP_ENV];
    const provider = yield* processes.spawn({
      command: input.launch.kind === "argv" ? input.launch.argv[0] : input.launch.command,
      ...(input.launch.kind === "argv" ? { args: input.launch.argv.slice(1) } : { shell: true }),
      cwd: input.cwd,
      env,
      detached: globalThis.process.platform !== "win32" && !inheritedGroup,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    }).pipe(Effect.mapError(spawnFailure));
    if (provider.stdin === undefined) {
      return yield* Effect.die(new Error("ACP provider process did not expose stdin."));
    }
    const providerStdin = provider.stdin;

    yield* Effect.forkScoped(Stream.runDrain(provider.stderr));
    const updates = yield* Queue.unbounded<AcpTransportUpdate, AcpError | Cause.Done>();
    const callbacks = yield* makeSdkCallbackDispatcher();
    const promptFence = makePromptFence(ndJsonStream(
      providerStdin,
      Stream.toReadableStream(provider.stdout),
    ));
    const application = client({ name: "acpus" })
      .onRequest(methods.client.session.requestPermission, handler => callbacks.run(
        interruptOnAbort(input.handlers.requestPermission(handler.params), handler.signal),
        () => Exit.succeed({ outcome: { outcome: "cancelled" } }),
      ))
      .onRequest(methods.client.fs.readTextFile, handler => callbacks.run(
        interruptOnAbort(input.handlers.readTextFile(handler.params), handler.signal),
        () => callbackCancellation("fs/read_text_file"),
      ))
      .onRequest(methods.client.fs.writeTextFile, handler => callbacks.run(
        interruptOnAbort(input.handlers.writeTextFile(handler.params), handler.signal),
        () => callbackCancellation("fs/write_text_file"),
      ))
      .onRequest(methods.client.terminal.create, handler => callbacks.run(
        interruptOnAbort(input.handlers.createTerminal(handler.params), handler.signal),
        () => callbackCancellation("terminal/create"),
      ))
      .onRequest(methods.client.terminal.output, handler => callbacks.run(
        interruptOnAbort(input.handlers.terminalOutput(handler.params), handler.signal),
        () => callbackCancellation("terminal/output"),
      ))
      .onRequest(methods.client.terminal.waitForExit, handler => callbacks.run(
        interruptOnAbort(input.handlers.waitForTerminalExit(handler.params), handler.signal),
        () => callbackCancellation("terminal/wait_for_exit"),
      ))
      .onRequest(methods.client.terminal.kill, handler => callbacks.run(
        interruptOnAbort(input.handlers.killTerminal(handler.params), handler.signal),
        () => callbackCancellation("terminal/kill"),
      ))
      .onRequest(methods.client.terminal.release, handler => callbacks.run(
        interruptOnAbort(input.handlers.releaseTerminal(handler.params), handler.signal),
        () => callbackCancellation("terminal/release"),
      ))
      .onNotification(methods.client.session.update, handler => {
        Queue.offerUnsafe(updates, {
          update: handler.params.update,
          ...promptFence.takeUpdate(),
        });
      });

    const connection = yield* Effect.acquireRelease(
      Effect.try({
        try: () => application.connect(promptFence.stream),
        catch: cause => transportFailure("open_session", cause),
      }),
      connection => Effect.sync(() => {
        connection.close();
        Queue.endUnsafe(updates);
      }),
    );
    const processClosed = provider.closed.pipe(Effect.mapError(processLifecycleFailure));
    yield* Effect.forkScoped(processClosed.pipe(
      Effect.matchEffect({
        onFailure: error => Effect.sync(() => {
          Queue.failCauseUnsafe(updates, Cause.fail(error));
          connection.close(error);
        }),
        onSuccess: () => Effect.sync(() => {
          Queue.endUnsafe(updates);
          connection.close();
        }),
      }),
    ));

    const request = <Success>(
      operation: AcpOperation,
      failureType: "initialize" | "protocol" | "session" | "configuration",
      send: (signal: AbortSignal) => Promise<Success>,
    ): Effect.Effect<Success, AcpError> => {
      const cancellationSequence = promptFence.cancellationSequence();
      return withProviderExitPriority(
        Effect.tryPromise({
          try: send,
          catch: requestFailure(operation, failureType),
        }),
        processClosed,
        operation,
      ).pipe(Effect.onInterrupt(() => Effect.raceFirst(
        promptFence.awaitCancellationAfter(cancellationSequence),
        processClosed.pipe(Effect.ignore, Effect.asVoid),
      ).pipe(Effect.ignore)));
    };
    const notify = (
      operation: AcpOperation,
      send: () => Promise<void>,
    ): Effect.Effect<void, AcpError> => withProviderExitPriority(
      Effect.tryPromise({ try: send, catch: notifyFailure(operation) }),
      processClosed,
      operation,
    );

    return {
      updates: Stream.fromQueue(updates),
      closed: processClosed,
      initialize: () => request(
        "initialize",
        "initialize",
        signal => connection.agent.request(methods.agent.initialize, {
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: {
            fs: { readTextFile: true, writeTextFile: true },
            terminal: true,
          },
          clientInfo: { name: "acpus", version: "0.1.0" },
        }, { cancellationSignal: signal }),
      ),
      newSession: cwd => request(
        "new_session",
        "session",
        signal => connection.agent.request(
          methods.agent.session.new,
          { cwd, mcpServers: [] },
          { cancellationSignal: signal },
        ),
      ),
      resumeSession: (sessionId, cwd) => request(
        "resume_session",
        "session",
        signal => connection.agent.request(
          methods.agent.session.resume,
          { sessionId, cwd, mcpServers: [] },
          { cancellationSignal: signal },
        ),
      ),
      loadSession: (sessionId, cwd) => request(
        "load_session",
        "session",
        signal => connection.agent.request(
          methods.agent.session.load,
          { sessionId, cwd, mcpServers: [] },
          { cancellationSignal: signal },
        ),
      ),
      setConfigOption: (sessionId, configId, value) => request(
        "configure_session",
        "configuration",
        signal => connection.agent.request(
          methods.agent.session.setConfigOption,
          { sessionId, configId, value },
          { cancellationSignal: signal },
        ),
      ),
      prompt: (sessionId, prompt) => Effect.suspend(() => {
        const promptEpoch = promptFence.beginPrompt();
        return request(
          "run_turn",
          "protocol",
          signal => connection.agent.request(
            methods.agent.session.prompt,
            { sessionId, prompt: [{ type: "text", text: prompt }] },
            { cancellationSignal: signal },
          ),
        ).pipe(
          // Let the stream reader classify already-enqueued post-response updates before another prompt opens.
          Effect.flatMap(response => Effect.yieldNow.pipe(Effect.andThen(Effect.try({
            try: () => ({
              response,
              promptEpoch,
              updateFence: promptFence.finishPrompt(promptEpoch),
            }),
            catch: cause => transportFailure("run_turn", cause),
          })))),
          Effect.onExit(() => Effect.sync(() => promptFence.abandonPrompt(promptEpoch))),
        );
      }),
      cancel: sessionId => notify(
        "cancel_turn",
        () => connection.agent.notify(methods.agent.session.cancel, { sessionId }),
      ),
      closeSession: sessionId => request(
        "close_session",
        "session",
        signal => connection.agent.request(
          methods.agent.session.close,
          { sessionId },
          { cancellationSignal: signal },
        ),
      ),
      signal: signal => provider.signal(signal).pipe(Effect.mapError(processCleanupFailure)),
      liveness: () => processes.liveness(provider.target),
      close: reason => Effect.try({
        try: () => {
          connection.close(reason);
          Queue.endUnsafe(updates);
        },
        catch: cause => transportFailure("close_session", cause),
      }),
    };
  });
}

type PromptUpdateMetadata = Readonly<{
  promptEpoch?: number;
  promptSequence?: number;
}>;

type PromptFence = Readonly<{
  stream: SdkStream;
  cancellationSequence(): number;
  awaitCancellationAfter(sequence: number): Effect.Effect<void>;
  beginPrompt(): number;
  finishPrompt(epoch: number): number;
  abandonPrompt(epoch: number): void;
  takeUpdate(): PromptUpdateMetadata;
}>;

function makePromptFence(stream: SdkStream): PromptFence {
  let nextEpoch = 0;
  let pendingEpoch: number | undefined;
  let active: {
    epoch: number;
    requestId: string | number | null;
    updateCount: number;
  } | undefined;
  const completed = new Map<number, number>();
  const updateMetadata: PromptUpdateMetadata[] = [];
  let deliveredCancellations = 0;
  const cancellationWaiters = new Set<{ after: number; resume: () => void }>();
  const reader = stream.readable.getReader();
  const readable = new ReadableStream<AnyMessage>({
    async pull(controller) {
      const message = await reader.read();
      if (message.done) {
        controller.close();
        return;
      }
      const value = message.value;
      if ("method" in value
        && !("id" in value)
        && value.method === methods.client.session.update) {
        if (active === undefined) {
          updateMetadata.push({});
        } else {
          active.updateCount += 1;
          updateMetadata.push({
            promptEpoch: active.epoch,
            promptSequence: active.updateCount,
          });
        }
      } else if (!("method" in value)
        && active !== undefined
        && value.id === active.requestId) {
        completed.set(active.epoch, active.updateCount);
        active = undefined;
      }
      controller.enqueue(value);
    },
    async cancel(reason) {
      await reader.cancel(reason);
    },
  });
  const writable = new WritableStream<AnyMessage>({
    async write(message) {
      if ("method" in message
        && "id" in message
        && message.method === methods.agent.session.prompt
        && pendingEpoch !== undefined) {
        active = {
          epoch: pendingEpoch,
          requestId: message.id,
          updateCount: 0,
        };
        pendingEpoch = undefined;
      }
      const writer = stream.writable.getWriter();
      try {
        await writer.write(message);
        if ("method" in message && message.method === methods.protocol.cancelRequest) {
          deliveredCancellations += 1;
          for (const waiter of cancellationWaiters) {
            if (deliveredCancellations <= waiter.after) continue;
            cancellationWaiters.delete(waiter);
            waiter.resume();
          }
        }
      } finally {
        writer.releaseLock();
      }
    },
    async close() {
      const writer = stream.writable.getWriter();
      try {
        await writer.close();
      } finally {
        writer.releaseLock();
      }
    },
    async abort(reason) {
      const writer = stream.writable.getWriter();
      try {
        await writer.abort(reason);
      } finally {
        writer.releaseLock();
      }
    },
  });

  return {
    stream: { readable, writable },
    cancellationSequence: () => deliveredCancellations,
    awaitCancellationAfter: sequence => deliveredCancellations > sequence
      ? Effect.void
      : Effect.callback<void>(resume => {
          const waiter = { after: sequence, resume: () => resume(Effect.void) };
          cancellationWaiters.add(waiter);
          return Effect.sync(() => cancellationWaiters.delete(waiter));
        }),
    beginPrompt() {
      if (pendingEpoch !== undefined || active !== undefined) {
        throw new Error("ACP transport already has an active prompt fence.");
      }
      pendingEpoch = ++nextEpoch;
      return pendingEpoch;
    },
    finishPrompt(epoch) {
      const fence = completed.get(epoch);
      if (fence === undefined) {
        throw new Error(`ACP transport did not observe the response fence for prompt '${epoch}'.`);
      }
      completed.delete(epoch);
      return fence;
    },
    abandonPrompt(epoch) {
      if (pendingEpoch === epoch) pendingEpoch = undefined;
      if (active?.epoch === epoch) active = undefined;
      completed.delete(epoch);
    },
    takeUpdate: () => updateMetadata.shift() ?? {},
  };
}

type SdkCallbackJob = Effect.Effect<void>;

type SdkCallbackDispatcher = Readonly<{
  run<Success, Failure>(
    effect: Effect.Effect<Success, Failure>,
    onInterrupt: () => Exit.Exit<Success, Failure>,
  ): Promise<Success>;
}>;

function makeSdkCallbackDispatcher(): Effect.Effect<SdkCallbackDispatcher, never, Scope.Scope> {
  return Effect.gen(function*() {
    const jobs = yield* Effect.acquireRelease(
      Queue.unbounded<SdkCallbackJob, Cause.Done>(),
      jobs => Effect.sync(() => {
        Queue.endUnsafe(jobs);
      }),
    );
    yield* Stream.fromQueue(jobs).pipe(
      Stream.runForEach(job => Effect.asVoid(Effect.forkScoped(job))),
      Effect.forkScoped,
    );

    return {
      run: <Success, Failure>(
        effect: Effect.Effect<Success, Failure>,
        onInterrupt: () => Exit.Exit<Success, Failure>,
      ): Promise<Success> => new Promise((resolve, reject) => {
        let settled = false;
        const settle = (exit: Exit.Exit<Success, Failure>) => {
          if (settled) return;
          settled = true;
          if (Exit.isSuccess(exit)) {
            resolve(exit.value);
          } else {
            reject(Cause.squash(exit.cause));
          }
        };
        const job = effect.pipe(
          Effect.onExit(exit => Effect.sync(() => {
            settle(Exit.isSuccess(exit) || !Cause.hasInterrupts(exit.cause) ? exit : onInterrupt());
          })),
          Effect.ignore,
        );
        if (!Queue.offerUnsafe(jobs, job)) settle(onInterrupt());
      }),
    };
  });
}

function callbackCancellation<Success>(
  operation: ClientOperationIssue["operation"],
): Exit.Exit<Success, ClientOperationIssue> {
  return Exit.fail(new ClientOperationIssue(operation, "cancelled", `${operation} was cancelled.`));
}

function withProviderExitPriority<Success>(
  operationEffect: Effect.Effect<Success, AcpError>,
  closed: Effect.Effect<ProcessExit, AcpError>,
  operation: AcpOperation,
): Effect.Effect<Success, AcpError> {
  const providerExit = closed.pipe(Effect.flatMap(info => Effect.fail(providerExitFailure(operation, info))));
  return Effect.raceFirst(operationEffect, providerExit).pipe(Effect.catch(error => {
    if (error.type === "provider_exit") return Effect.fail(error);
    return Effect.timeoutOption(Effect.result(closed), PROVIDER_EXIT_PRIORITY_MS).pipe(
      Effect.flatMap(Option.match({
        onNone: () => Effect.fail(error),
        onSome: result => Result.match(result, {
          onSuccess: info => Effect.fail(providerExitFailure(operation, info)),
          onFailure: closeError => Effect.fail(closeError),
        }),
      })),
    );
  }));
}

function requestFailure(
  operation: AcpOperation,
  failureType: "initialize" | "protocol" | "session" | "configuration",
): (cause: unknown) => AcpError {
  return cause => {
    if (isAcpError(cause)) return cause;
    if (cause instanceof RequestError) {
      return failure(failureType, operation, cause.message, cause.code === -32800, {
        code: cause.code,
        origin: "provider",
        providerEvidence: operation === "run_turn" ? "terminal_response" : "inbound_activity",
      });
    }
    return failure(failureType, operation, errorMessage(cause), true, {
      origin: "transport",
      providerEvidence: "none",
    });
  };
}

function notifyFailure(operation: AcpOperation): (cause: unknown) => AcpError {
  return cause => cause instanceof RequestError
    ? failure("protocol", operation, cause.message, cause.code === -32800, { code: cause.code })
    : failure("protocol", operation, errorMessage(cause), true);
}

function spawnFailure(error: OwnedProcessError): AcpError {
  return failure("spawn", "open_session", error.message, false, {
    ...(error.code === undefined ? {} : { code: error.code }),
  });
}

function processLifecycleFailure(error: OwnedProcessError): AcpError {
  return failure("protocol", "open_session", error.message, true, {
    ...(error.code === undefined ? {} : { code: error.code }),
    origin: "process",
  });
}

function processCleanupFailure(error: OwnedProcessError): AcpError {
  return failure("cleanup", "close_session", error.message, false, {
    ...(error.code === undefined ? {} : { code: error.code }),
    origin: "process",
  });
}

function transportFailure(operation: AcpOperation, cause: unknown): AcpError {
  return failure("protocol", operation, errorMessage(cause), true, {
    origin: "transport",
  });
}

function providerExitFailure(
  operation: AcpOperation,
  info: ProcessExit,
): Extract<AcpError, { type: "provider_exit" }> {
  return failure("provider_exit", operation, `The ACP Agent exited during ${operation}.`, true, {
    exitCode: info.exitCode,
    signal: info.signal,
  });
}

function failure<T extends AcpError["type"]>(
  type: T,
  operation: AcpOperation,
  message: string,
  retryable: boolean,
  extra: Record<string, unknown> = {},
): Extract<AcpError, { type: T }> {
  const origin = type === "spawn" || type === "provider_exit" ? "process" as const : "transport" as const;
  return {
    type,
    operation,
    origin,
    providerEvidence: "none",
    message,
    retryable,
    ...extra,
  } as Extract<AcpError, { type: T }>;
}

function isAcpError(value: unknown): value is AcpError {
  return typeof value === "object" && value !== null
    && "type" in value && typeof value.type === "string"
    && "operation" in value && typeof value.operation === "string";
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
