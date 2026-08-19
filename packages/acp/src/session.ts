import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { isAbsolute } from "node:path";
import { Readable, Writable } from "node:stream";
import {
  PROTOCOL_VERSION,
  RequestError,
  client,
  methods,
  ndJsonStream,
  type ClientContext,
  type AnyMessage,
  type InitializeResponse,
  type SendRequestOptions,
  type SessionConfigOption,
  type SessionUpdate,
  type Stream,
} from "@agentclientprotocol/sdk";
import { errAsync, ResultAsync } from "neverthrow";
import {
  PersistenceIssue,
  acpSessionProjectionPath,
  boundConversation,
  launchIdentity,
  loadAcpSessionProjection,
  saveAcpSessionProjection,
  type AcpProjectedConversationEntry,
  type AcpSessionProjection,
} from "./persistence.js";
import {
  ClientOperationIssue,
  createReverseRpcHandlers,
} from "./reverse-rpc.js";
import type {
  AcpError,
  AcpEvent,
  AcpJsonValue,
  AcpOperation,
  AcpSession,
  AcpSessionConfiguration,
  AcpTokenUsage,
  AcpTurnInput,
  AcpTurnResult,
  OpenAcpSessionInput,
} from "./types.js";

type ExitInfo = Readonly<{
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}>;

type ProcessMonitor = Readonly<{
  spawned: Promise<void>;
  exitInfo(): ExitInfo | undefined;
  settleExit(): Promise<ExitInfo | undefined>;
  race<T>(request: Promise<T>, operation: AcpOperation): Promise<T>;
}>;

type ProjectionHolder = {
  value: AcpSessionProjection | undefined;
  projectUpdates: boolean;
};

type ConfigurationState = {
  options: SessionConfigOption[] | null | undefined;
};

const COOPERATIVE_CLOSE_GRACE_MS = 500;
const INHERIT_PROCESS_GROUP_ENV = "ACPUS_INTERNAL_ACP_INHERIT_PROCESS_GROUP";
const ownedProcessGroups = new WeakSet<ChildProcessWithoutNullStreams>();

type OpenControl = {
  readonly signal: AbortSignal | undefined;
  operation: AcpOperation;
  committed: boolean;
};

type OpenConnectionCleanup = () => Promise<unknown[]>;

type TurnUpdateEpoch = {
  accepting: boolean;
  promptRequestId?: string | number | null;
  pending: Set<Promise<void>>;
};

type TurnUpdateIngress = {
  epoch: TurnUpdateEpoch | undefined;
  settle(): void;
};

export function openAcpSession(input: OpenAcpSessionInput): ResultAsync<AcpSession, AcpError> {
  const invalid = validateOpenInput(input);
  if (invalid) return errAsync(invalid);
  if (input.signal?.aborted) return errAsync(cancelledFailure("open_session"));
  return ResultAsync.fromPromise(open(input), toAcpError("open_session"));
}

async function open(input: OpenAcpSessionInput): Promise<AcpSession> {
  const control: OpenControl = {
    signal: input.signal,
    operation: "open_session",
    committed: false,
  };
  throwIfOpenCancelled(control);
  const identity = launchIdentity(input.launch);
  let saved: AcpSessionProjection | undefined;
  try {
    saved = await loadAcpSessionProjection({
      stateDirectory: input.stateDirectory,
      recordId: input.recordId,
      cwd: input.cwd,
      launchIdentity: identity,
    });
    throwIfOpenCancelled(control);
  } catch (error) {
    throw control.signal?.aborted ? cancelledFailure(control.operation) : error;
  }
  const child = launchAgent(input);
  const monitor = monitorProcess(child);
  child.stderr.resume();
  let cleanupConnection: OpenConnectionCleanup | undefined;
  let abortCleanup: Promise<unknown[]> | undefined;
  const onAbort = (): void => {
    if (!control.committed) {
      abortCleanup ??= cleanupOpenResources(() => cleanupConnection, child, monitor);
    }
  };
  control.signal?.addEventListener("abort", onAbort, { once: true });
  if (control.signal?.aborted) onAbort();
  try {
    await monitor.spawned;
    throwIfOpenCancelled(control);
    return await openSpawned(
      input,
      saved,
      identity,
      child,
      monitor,
      control,
      cleanup => { cleanupConnection = cleanup; },
      () => {
        throwIfOpenCancelled(control);
        control.signal?.removeEventListener("abort", onAbort);
        control.committed = true;
      },
    );
  } catch (error) {
    control.signal?.removeEventListener("abort", onAbort);
    const primary = control.signal?.aborted && !control.committed
      ? cancelledFailure(control.operation)
      : error;
    const cleanupErrors = [
      ...(await abortCleanup ?? []),
      ...(await cleanupOpenResources(() => cleanupConnection, child, monitor)),
    ];
    if (cleanupErrors.length > 0) {
      throw cleanupFailure(primary, control.operation, cleanupErrors);
    }
    throw primary;
  }
}

async function openSpawned(
  input: OpenAcpSessionInput,
  saved: AcpSessionProjection | undefined,
  identity: AcpSessionProjection["launch"],
  child: ChildProcessWithoutNullStreams,
  monitor: ProcessMonitor,
  control: OpenControl,
  registerCleanup: (cleanup: OpenConnectionCleanup) => void,
  commit: () => void,
): Promise<AcpSession> {
  let sessionId: string | undefined;
  let currentEventHandler: ((event: AcpEvent) => unknown) | undefined;
  let currentClientIssue: ClientOperationIssue | undefined;
  let configurationDirty = false;
  let pendingConfiguration: AcpSessionConfiguration | undefined;
  let active = false;
  let projectTurnUpdates = false;
  let activeTurn: Promise<void> | undefined;
  let cancelActiveTurn: (() => void) | undefined;
  let closed = false;
  let closeResult: ResultAsync<void, AcpError> | undefined;
  const projection: ProjectionHolder = { value: saved, projectUpdates: false };
  const updates = createTurnUpdateFence(ndJsonStream(
    Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
    Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
  ));

  const emit = (event: AcpEvent): void => {
    if (projection.projectUpdates && projection.value !== undefined && projectTurnUpdates) {
      projection.value = projectEvent(projection.value, event);
    }
    const handler = currentEventHandler;
    if (handler === undefined) return;
    try {
      void Promise.resolve(handler(event)).catch(() => undefined);
    } catch {
      // Event observers never participate in protocol settlement.
    }
  };

  const rememberClientIssue = async <T>(operation: () => Promise<T>): Promise<T> => {
    try {
      return await operation();
    } catch (error) {
      if (active && error instanceof ClientOperationIssue && error.reason !== "permission") {
        currentClientIssue = error;
      }
      throw error;
    }
  };

  const reverse = createReverseRpcHandlers({
    getSessionId: () => sessionId,
    cwd: input.cwd,
    ...(input.env === undefined ? {} : { env: input.env }),
    permissionMode: input.permissionMode,
    onActivity: operation => {
      if (operation !== "session/request_permission") emit({ type: "activity", operation });
    },
  });
  const app = client({ name: "acpus" })
    .onRequest(methods.client.session.requestPermission, handler =>
      rememberClientIssue(() => reverse.requestPermission(handler.params, handler.signal)))
    .onRequest(methods.client.fs.readTextFile, handler =>
      rememberClientIssue(() => reverse.readTextFile(handler.params)))
    .onRequest(methods.client.fs.writeTextFile, handler =>
      rememberClientIssue(() => reverse.writeTextFile(handler.params)))
    .onRequest(methods.client.terminal.create, handler =>
      rememberClientIssue(() => reverse.createTerminal(handler.params)))
    .onRequest(methods.client.terminal.output, handler =>
      rememberClientIssue(() => reverse.terminalOutput(handler.params)))
    .onRequest(methods.client.terminal.waitForExit, handler =>
      rememberClientIssue(() => reverse.waitForTerminalExit(handler.params, handler.signal)))
    .onRequest(methods.client.terminal.kill, handler =>
      rememberClientIssue(() => reverse.killTerminal(handler.params)))
    .onRequest(methods.client.terminal.release, handler =>
      rememberClientIssue(() => reverse.releaseTerminal(handler.params)))
    .onNotification(methods.client.session.update, handler => {
      const ingress = updates.take();
      try {
        if (ingress?.epoch !== undefined && handler.params.sessionId === sessionId) {
          emit(eventFromUpdate(handler.params.update));
        }
      } finally {
        ingress?.settle();
      }
    });
  const connection = app.connect(updates.stream);
  const context = connection.agent;
  registerCleanup(async (): Promise<unknown[]> => {
    const errors: unknown[] = [];
    try {
      reverse.cancelPendingPermissions();
    } catch (error) {
      errors.push(error);
    }
    await reverse.closeAll().catch(error => { errors.push(error); });
    try {
      connection.close();
    } catch (error) {
      errors.push(error);
    }
    return errors;
  });

  const initialized = await openingAgentRequest(
    options => context.request(methods.agent.initialize, {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {
          fs: { readTextFile: true, writeTextFile: true },
          terminal: true,
        },
        clientInfo: { name: "acpus", version: "0.1.0" },
      }, options),
    monitor,
    control,
    "initialize",
    "initialize",
  );
  validateInitialize(initialized);
  const capabilities = capabilitiesFrom(initialized);
  const configuration: ConfigurationState = { options: undefined };

  if (saved !== undefined) {
    sessionId = saved.backend.sessionId;
    if (capabilities.resume) {
      const response = await openingAgentRequest(
        options => context.request(methods.agent.session.resume, {
            sessionId: sessionId!,
            cwd: input.cwd,
            mcpServers: [],
          }, options),
        monitor,
        control,
        "resume_session",
        "session",
      );
      configuration.options = response?.configOptions;
    } else if (capabilities.load) {
      const response = await openingAgentRequest(
        options => context.request(methods.agent.session.load, {
            sessionId: sessionId!,
            cwd: input.cwd,
            mcpServers: [],
          }, options),
        monitor,
        control,
        "load_session",
        "session",
      );
      configuration.options = response?.configOptions;
    } else {
      throw failure(
        "capability",
        "resume_session",
        "The ACP Agent cannot resume or load the recorded session.",
        false,
        { capability: "resume" },
      );
    }
  } else {
    const response = await openingAgentRequest(
      options => context.request(
        methods.agent.session.new,
        { cwd: input.cwd, mcpServers: [] },
        options,
      ),
      monitor,
      control,
      "new_session",
      "session",
    );
    if (!response || typeof response.sessionId !== "string" || response.sessionId.length === 0) {
      throw failure("protocol", "new_session", "The ACP Agent returned an invalid session id.", false);
    }
    sessionId = response.sessionId;
    configuration.options = response.configOptions;
  }

  const now = new Date().toISOString();
  projection.value = {
    ...(saved ?? {
      schema: "acpus.acp-session.v1",
      recordId: input.recordId,
      cwd: input.cwd,
      launch: identity,
      backend: { sessionId, capabilities },
      desiredConfiguration: { options: {} },
      conversation: [],
      createdAt: now,
      updatedAt: now,
    }),
    backend: { sessionId, capabilities },
    updatedAt: now,
  };
  const optionBaselines = configurationBaselines(configuration.options);

  if (saved !== undefined) {
    configuration.options = await applyConfiguration(
      context,
      monitor,
      sessionId,
      saved.desiredConfiguration,
      configuration.options,
      control,
    );
  }
  control.operation = "open_session";
  await saveAcpSessionProjection(input.stateDirectory, projection.value, {
    beforeRename: () => throwIfOpenCancelled(control),
    afterRename: commit,
  });
  projection.projectUpdates = true;

  const runTurn = (turnInput: AcpTurnInput): ResultAsync<AcpTurnResult, AcpError> => {
    if (closed) return errAsync(failure("session", "run_turn", "The ACP session is closed.", false));
    if (active) return errAsync(failure("session", "run_turn", "The ACP session already has an active turn.", false));
    const invalid = validateTurnInput(turnInput);
    if (invalid) return errAsync(invalid);
    active = true;
    const task = runTurnTask(turnInput);
    const settlement = task.then(() => undefined, () => undefined);
    activeTurn = settlement;
    void settlement.finally(() => {
      if (activeTurn === settlement) activeTurn = undefined;
    });
    return ResultAsync.fromPromise(task, toAcpError("run_turn"));
  };

  const runTurnTask = async (turnInput: AcpTurnInput): Promise<AcpTurnResult> => {
    let cancelPromise: Promise<void> | undefined;
    let updateEpoch: TurnUpdateEpoch | undefined;
    let cancelled = turnInput.signal?.aborted ?? false;
    const cancel = (): void => {
      if (cancelled && cancelPromise !== undefined) return;
      cancelled = true;
      reverse.cancelPendingPermissions();
      cancelPromise = agentNotify(
        context.notify(methods.agent.session.cancel, { sessionId: sessionId! }),
        "cancel_turn",
      );
      void cancelPromise.catch(() => undefined);
    };
    cancelActiveTurn = cancel;
    turnInput.signal?.addEventListener("abort", cancel, { once: true });
    if (turnInput.signal?.aborted) cancel();
    try {
      currentEventHandler = turnInput.onEvent;
      currentClientIssue = undefined;
      const currentProjection = requireProjection(projection);
      const desired = mergeConfiguration(currentProjection.desiredConfiguration, turnInput.configuration);
      if (turnInput.configuration !== undefined) {
        pendingConfiguration = configurationApplication(
          currentProjection.desiredConfiguration,
          desired,
          turnInput.configuration,
          optionBaselines,
        );
        configurationDirty = true;
      }
      projection.value = appendConversation({
        ...currentProjection,
        desiredConfiguration: desired,
        updatedAt: new Date().toISOString(),
      }, {
        type: "message",
        role: "user",
        content: turnInput.prompt,
      });
      await saveAcpSessionProjection(input.stateDirectory, projection.value);

      const configurationToApply = configurationDirty ? pendingConfiguration ?? desired : undefined;
      if (configurationToApply !== undefined) {
        configuration.options = await applyConfiguration(
          context,
          monitor,
          sessionId!,
          configurationToApply,
          configuration.options,
          undefined,
          turnInput.signal,
        );
        configurationDirty = false;
        pendingConfiguration = undefined;
      }

      if (turnInput.signal?.aborted) cancel();
      if (cancelled) {
        await cancelPromise;
        projection.value = withStop(requireProjection(projection), "cancelled");
        await saveAcpSessionProjection(input.stateDirectory, projection.value);
        return { status: "cancelled", stopReason: "cancelled" };
      }
      projectTurnUpdates = true;
      updateEpoch = updates.begin();
      const response = await agentRequest(
        context.request(methods.agent.session.prompt, {
          sessionId: sessionId!,
          prompt: [{ type: "text", text: turnInput.prompt }],
        }),
        monitor,
        "run_turn",
        "protocol",
      );
      turnInput.signal?.removeEventListener("abort", cancel);
      await cancelPromise;
      await updates.drain(updateEpoch);
      projectTurnUpdates = false;
      if (currentClientIssue !== undefined) throw currentClientIssue;
      if (!response || typeof response.stopReason !== "string" || response.stopReason.length === 0) {
        throw failure("protocol", "run_turn", "The ACP Agent returned an invalid prompt response.", false);
      }
      const usage = tokenUsage(response.usage);
      const status = cancelled || response.stopReason === "cancelled" ? "cancelled" : "completed";
      projection.value = withStop(requireProjection(projection), response.stopReason, usage);
      await saveAcpSessionProjection(input.stateDirectory, projection.value);
      return {
        status,
        stopReason: response.stopReason,
        ...(usage === undefined ? {} : { usage }),
      };
    } catch (error) {
      if (cancelled && projection.value !== undefined) {
        projection.value = withStop(projection.value, "cancelled");
        await saveAcpSessionProjection(input.stateDirectory, projection.value);
        return { status: "cancelled", stopReason: "cancelled" };
      }
      if (projection.value !== undefined) {
        await saveAcpSessionProjection(input.stateDirectory, projection.value);
      }
      throw error;
    } finally {
      if (updateEpoch !== undefined) updates.end(updateEpoch);
      projectTurnUpdates = false;
      turnInput.signal?.removeEventListener("abort", cancel);
      currentEventHandler = undefined;
      currentClientIssue = undefined;
      cancelActiveTurn = undefined;
      active = false;
    }
  };

  const close = (reason?: string): ResultAsync<void, AcpError> => {
    if (closeResult !== undefined) return closeResult;
    closed = true;
    closeResult = ResultAsync.fromPromise(closeTask(reason), toAcpError("close_session"));
    return closeResult;
  };

  const closeTask = async (reason?: string): Promise<void> => {
    let primary: unknown;
    try {
      reverse.cancelPendingPermissions();
      if (active) {
        cancelActiveTurn?.();
        await settleWithin(activeTurn, COOPERATIVE_CLOSE_GRACE_MS);
      }
      if (initialized.agentCapabilities?.sessionCapabilities?.close) {
        const closeRequest = agentRequest(
          context.request(methods.agent.session.close, { sessionId: sessionId! }),
          monitor,
          "close_session",
          "session",
        );
        const outcome = await settleWithin(closeRequest, COOPERATIVE_CLOSE_GRACE_MS);
        if (outcome.settled && outcome.error !== undefined) throw outcome.error;
      }
    } catch (error) {
      primary = error;
    } finally {
      const cleanupErrors: unknown[] = [];
      try {
        connection.close(reason);
      } catch (error) {
        cleanupErrors.push(error);
      }
      await reverse.closeAll().catch(error => { cleanupErrors.push(error); });
      await terminate(child).catch(error => { cleanupErrors.push(error); });
      await activeTurn;
      if (cleanupErrors.length > 0) {
        throw cleanupFailure(primary ?? new Error("ACP session close cleanup failed."), "close_session", cleanupErrors);
      }
    }
    if (primary !== undefined) throw primary;
  };

  return {
    recordId: input.recordId,
    sessionId,
    projectionPath: acpSessionProjectionPath(input.recordId),
    runTurn,
    close,
  };
}

function validateOpenInput(input: OpenAcpSessionInput): AcpError | undefined {
  if (!record(input)) return failure("invalid_input", "open_session", "open input must be an object.", false);
  if (typeof input.recordId !== "string") return failure("invalid_input", "open_session", "recordId must be a string.", false);
  if (!input.recordId.trim()) return failure("invalid_input", "open_session", "recordId must be non-empty.", false);
  if (typeof input.stateDirectory !== "string") return failure("invalid_input", "open_session", "stateDirectory must be a string.", false);
  if (!input.stateDirectory.trim()) return failure("invalid_input", "open_session", "stateDirectory must be non-empty.", false);
  if (typeof input.cwd !== "string") return failure("invalid_input", "open_session", "cwd must be a string.", false);
  if (!isAbsolute(input.cwd)) return failure("invalid_input", "open_session", "cwd must be absolute.", false);
  if (!record(input.launch)) return failure("invalid_input", "open_session", "launch must be an object.", false);
  if (input.launch.kind === "command" && (typeof input.launch.command !== "string" || !input.launch.command.trim())) {
    return failure("invalid_input", "open_session", "launch command must be non-empty.", false);
  }
  if (input.launch.kind === "argv" && (!Array.isArray(input.launch.argv)
    || input.launch.argv.length === 0
    || !input.launch.argv.every(argument => typeof argument === "string")
    || !input.launch.argv[0]?.trim())) {
    return failure("invalid_input", "open_session", "launch argv executable must be non-empty.", false);
  }
  if (input.launch.kind !== "command" && input.launch.kind !== "argv") {
    return failure("invalid_input", "open_session", "launch kind must be command or argv.", false);
  }
  if (input.launch.name !== undefined && typeof input.launch.name !== "string") {
    return failure("invalid_input", "open_session", "launch name must be a string.", false);
  }
  if (input.permissionMode !== "approve-reads" && input.permissionMode !== "approve-all" && input.permissionMode !== "deny-all") {
    return failure("invalid_input", "open_session", "permissionMode is invalid.", false);
  }
  if (input.env !== undefined && (!record(input.env)
    || !Object.values(input.env).every(value => value === undefined || typeof value === "string"))) {
    return failure("invalid_input", "open_session", "env must contain only string or undefined values.", false);
  }
  if (input.signal !== undefined && !abortSignal(input.signal)) {
    return failure("invalid_input", "open_session", "signal must be an AbortSignal.", false);
  }
  return undefined;
}

function validateTurnInput(input: AcpTurnInput): AcpError | undefined {
  if (!record(input)) return failure("invalid_input", "run_turn", "turn input must be an object.", false);
  if (typeof input.prompt !== "string") {
    return failure("invalid_input", "run_turn", "prompt must be a string.", false);
  }
  if (input.configuration !== undefined && !record(input.configuration)) {
    return failure("invalid_input", "run_turn", "configuration must be an object.", false);
  }
  if (input.configuration?.model !== undefined && typeof input.configuration.model !== "string") {
    return failure("invalid_input", "run_turn", "configuration.model must be a string.", false);
  }
  if (input.configuration?.model !== undefined && !input.configuration.model.trim()) {
    return failure("invalid_input", "run_turn", "configuration.model must be non-empty.", false);
  }
  if (input.configuration?.options !== undefined && (!record(input.configuration.options)
    || !Object.values(input.configuration.options).every(value => typeof value === "string"))) {
    return failure("invalid_input", "run_turn", "configuration.options must contain only string values.", false);
  }
  if (input.signal !== undefined && !abortSignal(input.signal)) {
    return failure("invalid_input", "run_turn", "signal must be an AbortSignal.", false);
  }
  if (input.onEvent !== undefined && typeof input.onEvent !== "function") {
    return failure("invalid_input", "run_turn", "onEvent must be a function.", false);
  }
  return undefined;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function abortSignal(value: unknown): value is AbortSignal {
  return record(value)
    && typeof value.aborted === "boolean"
    && typeof value.addEventListener === "function"
    && typeof value.removeEventListener === "function";
}

function launchAgent(input: OpenAcpSessionInput): ChildProcessWithoutNullStreams {
  const inheritProcessGroup = process.env[INHERIT_PROCESS_GROUP_ENV] !== undefined
    && input.env?.[INHERIT_PROCESS_GROUP_ENV] === process.env[INHERIT_PROCESS_GROUP_ENV];
  const env = { ...process.env, ...input.env };
  delete env[INHERIT_PROCESS_GROUP_ENV];
  const detached = process.platform !== "win32" && !inheritProcessGroup;
  const child = input.launch.kind === "argv"
    ? spawn(input.launch.argv[0], [...input.launch.argv.slice(1)], {
        cwd: input.cwd,
        env,
        stdio: "pipe",
        detached,
      })
    : spawn(input.launch.command, {
        cwd: input.cwd,
        env,
        stdio: "pipe",
        shell: true,
        detached,
      });
  if (detached) ownedProcessGroups.add(child);
  return child;
}

function monitorProcess(child: ChildProcessWithoutNullStreams): ProcessMonitor {
  let exitInfo: ExitInfo | undefined;
  let spawned = false;
  let resolveExit!: (info: ExitInfo) => void;
  const exited = new Promise<ExitInfo>(resolve => { resolveExit = resolve; });
  const spawnResult = new Promise<void>((resolve, reject) => {
    child.once("spawn", () => {
      spawned = true;
      resolve();
    });
    child.once("error", error => {
      if (!spawned) {
        reject(failure("spawn", "open_session", error.message, false, {
          ...(typeof (error as NodeJS.ErrnoException).code === "string"
            ? { code: (error as NodeJS.ErrnoException).code }
            : {}),
        }));
      } else if (exitInfo === undefined) {
        exitInfo = { exitCode: null, signal: null };
        resolveExit(exitInfo);
      }
    });
  });
  child.once("exit", (exitCode, signal) => {
    if (exitInfo !== undefined) return;
    exitInfo = { exitCode, signal };
    resolveExit(exitInfo);
  });
  return {
    spawned: spawnResult,
    exitInfo: () => exitInfo,
    async settleExit(): Promise<ExitInfo | undefined> {
      if (exitInfo !== undefined) return exitInfo;
      await Promise.race([exited, delay(100)]);
      return exitInfo;
    },
    async race<T>(request: Promise<T>, operation: AcpOperation): Promise<T> {
      if (exitInfo !== undefined) throw providerExitFailure(operation, exitInfo);
      return await Promise.race([
        request,
        exited.then(info => { throw providerExitFailure(operation, info); }),
      ]);
    },
  };
}

async function agentRequest<T>(
  request: Promise<T>,
  monitor: ProcessMonitor,
  operation: AcpOperation,
  failureType: "initialize" | "protocol" | "session" | "configuration",
): Promise<T> {
  try {
    return await monitor.race(request, operation);
  } catch (error) {
    if (isAcpError(error)) throw error;
    // A broken stdio connection can reject before Node publishes child exit.
    // Give that bounded lifecycle observation priority over transport wording.
    const exited = await monitor.settleExit();
    if (exited !== undefined) throw providerExitFailure(operation, exited);
    if (error instanceof RequestError) {
      throw failure(failureType, operation, error.message, error.code === -32800, { code: error.code });
    }
    throw failure(failureType, operation, error instanceof Error ? error.message : String(error), true);
  }
}

async function openingAgentRequest<T>(
  request: (options: SendRequestOptions) => Promise<T>,
  monitor: ProcessMonitor,
  control: OpenControl,
  operation: AcpOperation,
  failureType: "initialize" | "protocol" | "session" | "configuration",
): Promise<T> {
  control.operation = operation;
  throwIfOpenCancelled(control);
  try {
    const response = await agentRequest(
      request({ ...(control.signal === undefined ? {} : { cancellationSignal: control.signal }) }),
      monitor,
      operation,
      failureType,
    );
    throwIfOpenCancelled(control);
    return response;
  } catch (error) {
    throwIfOpenCancelled(control);
    throw error;
  }
}

async function agentNotify(request: Promise<void>, operation: AcpOperation): Promise<void> {
  try {
    await request;
  } catch (error) {
    if (isAcpError(error)) throw error;
    if (error instanceof RequestError) {
      throw failure("protocol", operation, error.message, error.code === -32800, { code: error.code });
    }
    throw failure("protocol", operation, error instanceof Error ? error.message : String(error), true);
  }
}

function providerExitFailure(
  operation: AcpOperation,
  info: ExitInfo,
): Extract<AcpError, { type: "provider_exit" }> {
  return failure("provider_exit", operation, "The ACP Agent exited during " + operation + ".", true, {
    exitCode: info.exitCode,
    signal: info.signal,
  });
}

function validateInitialize(value: InitializeResponse): void {
  if (!value || value.protocolVersion !== PROTOCOL_VERSION) {
    throw failure(
      "initialize",
      "initialize",
      `The ACP Agent selected unsupported protocol version ${String(value?.protocolVersion)}.`,
      false,
    );
  }
}

function capabilitiesFrom(value: InitializeResponse): { resume: boolean; load: boolean } {
  return {
    resume: value.agentCapabilities?.sessionCapabilities?.resume != null,
    load: value.agentCapabilities?.loadSession === true,
  };
}

function mergeConfiguration(
  current: AcpSessionProjection["desiredConfiguration"],
  next: AcpSessionConfiguration | undefined,
): { model?: string; options: Record<string, string> } {
  if (next === undefined) {
    return {
      ...(current.model === undefined ? {} : { model: current.model }),
      options: { ...current.options },
    };
  }
  return {
    ...(next.model !== undefined
      ? { model: next.model }
      : current.model === undefined ? {} : { model: current.model }),
    options: { ...(next.options ?? current.options) },
  };
}

function configurationBaselines(
  options: SessionConfigOption[] | null | undefined,
): Readonly<Record<string, string>> {
  return Object.fromEntries((options ?? []).flatMap(option => {
    if (option.type !== "select" || typeof option.currentValue !== "string") return [];
    return [[option.id, option.currentValue]];
  }));
}

function configurationApplication(
  current: AcpSessionProjection["desiredConfiguration"],
  desired: AcpSessionProjection["desiredConfiguration"],
  supplied: AcpSessionConfiguration,
  baselines: Readonly<Record<string, string>>,
): AcpSessionConfiguration {
  if (supplied.options === undefined) return supplied;
  const options = { ...desired.options };
  for (const key of Object.keys(current.options)) {
    if (Object.hasOwn(desired.options, key)) continue;
    const baseline = baselines[key];
    if (baseline === undefined) {
      throw failure(
        "configuration",
        "configure_session",
        "The ACP Agent did not advertise a reset value for removed option " + key + ".",
        false,
      );
    }
    options[key] = baseline;
  }
  return {
    ...(supplied.model === undefined ? {} : { model: supplied.model }),
    options,
  };
}

async function applyConfiguration(
  context: ClientContext,
  monitor: ProcessMonitor,
  sessionId: string,
  desired: AcpSessionConfiguration,
  advertised: SessionConfigOption[] | null | undefined,
  openControl?: OpenControl,
  cancellationSignal?: AbortSignal,
): Promise<SessionConfigOption[] | null | undefined> {
  let current = advertised;
  if (desired.model !== undefined) {
    const model = current?.find(option => option.category === "model" || option.id === "model");
    if (!model) {
      throw failure(
        "capability",
        "configure_session",
        "The ACP session did not advertise a model configuration option.",
        false,
        { capability: "configuration" },
      );
    }
    const response = await configurationRequest(
      context,
      monitor,
      sessionId,
      model.id,
      desired.model,
      openControl,
      cancellationSignal,
    );
    current = response?.configOptions;
  }
  const entries = Object.entries(desired.options ?? {}).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0);
  for (const [configId, value] of entries) {
    const response = await configurationRequest(
      context,
      monitor,
      sessionId,
      configId,
      value,
      openControl,
      cancellationSignal,
    );
    current = response?.configOptions;
  }
  return current;
}

function configurationRequest(
  context: ClientContext,
  monitor: ProcessMonitor,
  sessionId: string,
  configId: string,
  value: string,
  openControl: OpenControl | undefined,
  cancellationSignal?: AbortSignal,
) {
  const request = (options?: SendRequestOptions) => context.request(
    methods.agent.session.setConfigOption,
    { sessionId, configId, value },
    options,
  );
  return openControl === undefined
    ? agentRequest(
        request(cancellationSignal === undefined ? undefined : { cancellationSignal }),
        monitor,
        "configure_session",
        "configuration",
      )
    : openingAgentRequest(request, monitor, openControl, "configure_session", "configuration");
}

function eventFromUpdate(update: SessionUpdate): AcpEvent {
  switch (update.sessionUpdate) {
    case "agent_message_chunk":
    case "agent_thought_chunk":
      return {
        type: "message",
        channel: update.sessionUpdate === "agent_message_chunk" ? "assistant" : "thought",
        content: jsonValue(update.content),
        ...(update.messageId ? { messageId: update.messageId } : {}),
      };
    case "tool_call":
    case "tool_call_update":
      return {
        type: "tool",
        action: update.sessionUpdate === "tool_call" ? "call" : "update",
        toolCallId: update.toolCallId,
        ...(update.title ? { title: update.title } : {}),
        ...(update.name ? { name: update.name } : {}),
        ...(update.kind ? { kind: update.kind } : {}),
        ...(update.status ? { status: update.status } : {}),
        ...(update.rawInput !== undefined ? { input: jsonValue(update.rawInput) } : {}),
        ...(update.rawOutput !== undefined ? { output: jsonValue(update.rawOutput) } : {}),
        ...(update.content != null ? { content: jsonValue(update.content) } : {}),
        ...(update.locations != null ? { locations: jsonValue(update.locations) } : {}),
      };
    case "usage_update": {
      const tokens = tokenUsage(metaUsage(update._meta));
      return {
        type: "usage",
        context: { used: update.used, size: update.size },
        ...(tokens ? { tokens } : {}),
        ...(update.cost ? { cost: { amount: update.cost.amount, currency: update.cost.currency } } : {}),
      };
    }
    case "plan":
      return { type: "plan", value: jsonValue(update.entries) };
    case "available_commands_update":
      return { type: "session", update: "available_commands", value: jsonValue(update.availableCommands) };
    case "current_mode_update":
      return { type: "session", update: "current_mode", value: update.currentModeId };
    case "config_option_update":
      return { type: "session", update: "configuration", value: jsonValue(update.configOptions) };
    case "session_info_update":
      return { type: "session", update: "info", value: jsonValue(update) };
    default:
      return { type: "unknown", name: update.sessionUpdate, value: jsonValue(update) };
  }
}

function projectEvent(projection: AcpSessionProjection, event: AcpEvent): AcpSessionProjection {
  if (event.type === "message") {
    const text = textContent(event.content);
    if (text === undefined) return projection;
    return appendOrMergeText(projection, event.channel, text);
  }
  if (event.type !== "tool") return projection;
  const conversation = [...projection.conversation];
  const callIndex = findToolCall(conversation, event.toolCallId);
  const previous = callIndex < 0 ? undefined : conversation[callIndex];
  const call: AcpProjectedConversationEntry = {
    type: "tool-call",
    toolCallId: event.toolCallId,
    ...(event.title ?? (previous?.type === "tool-call" ? previous.title : undefined)
      ? { title: event.title ?? (previous?.type === "tool-call" ? previous.title : undefined)! }
      : {}),
    ...(event.name ?? (previous?.type === "tool-call" ? previous.name : undefined)
      ? { name: event.name ?? (previous?.type === "tool-call" ? previous.name : undefined)! }
      : {}),
    ...(event.kind ?? (previous?.type === "tool-call" ? previous.kind : undefined)
      ? { kind: event.kind ?? (previous?.type === "tool-call" ? previous.kind : undefined)! }
      : {}),
    ...(event.status ?? (previous?.type === "tool-call" ? previous.status : undefined)
      ? { status: event.status ?? (previous?.type === "tool-call" ? previous.status : undefined)! }
      : {}),
    ...(event.input ?? (previous?.type === "tool-call" ? previous.input : undefined)
      ? { input: event.input ?? (previous?.type === "tool-call" ? previous.input : undefined)! }
      : {}),
  };
  if (callIndex < 0) conversation.push(call);
  else conversation[callIndex] = call;
  if (event.content !== undefined) {
    conversation.push({ type: "tool-result", toolCallId: event.toolCallId, content: event.content });
  }
  return withConversation(projection, conversation);
}

function appendOrMergeText(
  projection: AcpSessionProjection,
  channel: "assistant" | "thought",
  text: string,
): AcpSessionProjection {
  const conversation = [...projection.conversation];
  const last = conversation.at(-1);
  if (channel === "thought" && last?.type === "thought") {
    conversation[conversation.length - 1] = { ...last, content: last.content + text };
  } else if (channel === "assistant" && last?.type === "message" && last.role === "assistant") {
    conversation[conversation.length - 1] = { ...last, content: last.content + text };
  } else {
    conversation.push(channel === "thought"
      ? { type: "thought", content: text }
      : { type: "message", role: "assistant", content: text });
  }
  return withConversation(projection, conversation);
}

function appendConversation(
  projection: AcpSessionProjection,
  entry: AcpProjectedConversationEntry,
): AcpSessionProjection {
  return withConversation(projection, [...projection.conversation, entry]);
}

function withConversation(
  projection: AcpSessionProjection,
  conversation: readonly AcpProjectedConversationEntry[],
): AcpSessionProjection {
  return {
    ...projection,
    conversation: boundConversation(conversation),
    updatedAt: new Date().toISOString(),
  };
}

function withStop(
  projection: AcpSessionProjection,
  stopReason: string,
  usage?: AcpTokenUsage,
): AcpSessionProjection {
  return {
    ...projection,
    lastStop: { stopReason, ...(usage === undefined ? {} : { usage }) },
    updatedAt: new Date().toISOString(),
  };
}

function requireProjection(holder: ProjectionHolder): AcpSessionProjection {
  if (holder.value === undefined) throw new Error("ACP session projection is unavailable.");
  return holder.value;
}

function findToolCall(conversation: readonly AcpProjectedConversationEntry[], toolCallId: string): number {
  for (let index = conversation.length - 1; index >= 0; index -= 1) {
    const entry = conversation[index]!;
    if (entry.type === "tool-call" && entry.toolCallId === toolCallId) return index;
  }
  return -1;
}

function textContent(value: AcpJsonValue): string | undefined {
  if (!value || Array.isArray(value) || typeof value !== "object") return undefined;
  return value.type === "text" && typeof value.text === "string" ? value.text : undefined;
}

function metaUsage(meta: unknown): unknown {
  if (!meta || typeof meta !== "object") return undefined;
  return (meta as Record<string, unknown>).usage;
}

function tokenUsage(value: unknown): AcpTokenUsage | undefined {
  if (!value || typeof value !== "object") return undefined;
  const source = value as Record<string, unknown>;
  const result: Record<string, number> = {};
  for (const key of [
    "inputTokens", "outputTokens", "cachedReadTokens", "cachedWriteTokens",
    "thoughtTokens", "totalTokens",
  ] as const) {
    if (typeof source[key] === "number" && Number.isInteger(source[key]) && source[key] >= 0) {
      result[key] = source[key];
    }
  }
  return Object.keys(result).length === 0 ? undefined : result;
}

function jsonValue(value: unknown, depth = 0): AcpJsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (depth >= 20) return null;
  if (Array.isArray(value)) return value.slice(0, 1_000).map(item => jsonValue(item, depth + 1));
  if (!value || typeof value !== "object") return null;
  return Object.fromEntries(Object.entries(value).slice(0, 1_000).flatMap(([key, entry]) =>
    entry === undefined ? [] : [[key, jsonValue(entry, depth + 1)]],
  ));
}

function toAcpError(operation: AcpOperation): (error: unknown) => AcpError {
  return error => {
    if (isAcpError(error)) return error;
    if (error instanceof PersistenceIssue) {
      return failure("persistence", operation, error.message, false, {
        path: error.path,
        code: error.operation,
      });
    }
    if (error instanceof ClientOperationIssue) {
      return failure("client_operation", clientOperation(error), error.message, false, {
        code: error.reason,
      });
    }
    if (error instanceof RequestError) {
      return failure("protocol", operation, error.message, error.code === -32800, { code: error.code });
    }
    return failure("protocol", operation, error instanceof Error ? error.message : String(error), true);
  };
}

function clientOperation(error: ClientOperationIssue): AcpOperation {
  return error.operation === "session/request_permission" ? "run_turn" : error.operation;
}

function isAcpError(value: unknown): value is AcpError {
  return !!value && typeof value === "object"
    && typeof (value as Partial<AcpError>).type === "string"
    && typeof (value as Partial<AcpError>).operation === "string";
}

function failure<T extends AcpError["type"]>(
  type: T,
  operation: AcpOperation,
  message: string,
  retryable: boolean,
  extra: Record<string, unknown> = {},
): Extract<AcpError, { type: T }> {
  return { type, operation, message, retryable, ...extra } as Extract<AcpError, { type: T }>;
}

function cancelledFailure(operation: AcpOperation): Extract<AcpError, { type: "cancelled" }> {
  return failure("cancelled", operation, "Opening the ACP session was cancelled.", false);
}

function throwIfOpenCancelled(control: OpenControl): void {
  if (!control.committed && control.signal?.aborted) throw cancelledFailure(control.operation);
}

async function cleanupOpenResources(
  connectionCleanup: () => OpenConnectionCleanup | undefined,
  child: ChildProcessWithoutNullStreams,
  monitor: ProcessMonitor,
): Promise<unknown[]> {
  const cleanup = connectionCleanup();
  const errors: unknown[] = cleanup === undefined
    ? []
    : await cleanup().catch((error: unknown) => [error]);
  await monitor.spawned.catch(() => undefined);
  await terminate(child).catch(error => { errors.push(error); });
  return errors;
}

function cleanupFailure(
  primary: unknown,
  operation: AcpOperation,
  cleanupErrors: readonly unknown[],
): Extract<AcpError, { type: "cleanup" }> {
  const primaryMessage = isAcpError(primary)
    ? primary.message
    : primary instanceof Error ? primary.message : String(primary);
  const cleanupMessage = cleanupErrors
    .map(error => error instanceof Error ? error.message : String(error))
    .join("; ");
  return failure(
    "cleanup",
    operation,
    `${primaryMessage} Cleanup failed: ${cleanupMessage}`,
    false,
  );
}

async function terminate(child: ChildProcessWithoutNullStreams): Promise<void> {
  const pid = child.pid;
  if (pid === undefined) return;
  if (process.platform !== "win32" && ownedProcessGroups.has(child)) {
    signalProcess(-pid, "SIGTERM");
    await Promise.race([waitForExit(child), delay(500)]);
    if (processExists(-pid)) {
      signalProcess(-pid, "SIGKILL");
      await Promise.race([waitForExit(child), delay(500)]);
    }
    if (processExists(-pid)) throw new Error("ACP Agent process group did not exit after SIGKILL.");
    return;
  }
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([waitForExit(child), delay(500)]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await Promise.race([waitForExit(child), delay(500)]);
  }
  if (child.exitCode === null && child.signalCode === null) {
    throw new Error("ACP Agent process did not exit after termination.");
  }
}

function signalProcess(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch (error) {
    if (!(error instanceof Error) || (error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function waitForExit(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise(resolve => child.once("exit", () => resolve()));
}

function delay(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function settleWithin(
  promise: Promise<unknown> | undefined,
  milliseconds: number,
): Promise<{ settled: boolean; error?: unknown }> {
  if (promise === undefined) return { settled: true };
  return await Promise.race([
    promise.then(
      () => ({ settled: true }),
      error => ({ settled: true, error }),
    ),
    delay(milliseconds).then(() => ({ settled: false })),
  ]);
}

function createTurnUpdateFence(stream: Stream): {
  stream: Stream;
  begin(): TurnUpdateEpoch;
  end(epoch: TurnUpdateEpoch): void;
  take(): TurnUpdateIngress | undefined;
  drain(epoch: TurnUpdateEpoch): Promise<void>;
} {
  let active: TurnUpdateEpoch | undefined;
  let next: TurnUpdateEpoch | undefined;
  const incoming: TurnUpdateIngress[] = [];
  let previousDelivery = Promise.resolve();
  const reader = stream.readable.getReader();
  const readable = new ReadableStream<AnyMessage>({
    async pull(controller) {
      await previousDelivery;
      const next = await reader.read();
      if (next.done) {
        controller.close();
        return;
      }
      const message = next.value;
      if (!("method" in message) && active?.promptRequestId === message.id) {
        active.accepting = false;
        active = undefined;
      }
      if ("method" in message
        && message.method === methods.client.session.update
        && !("id" in message)) {
        let resolveHandled!: () => void;
        let settled = false;
        const settle = (): void => {
          if (settled) return;
          settled = true;
          resolveHandled();
        };
        const handled = new Promise<void>(resolve => { resolveHandled = resolve; });
        const ingress = { epoch: active?.accepting ? active : undefined, settle };
        ingress.epoch?.pending.add(handled);
        incoming.push(ingress);
        previousDelivery = handled;
        setImmediate(() => {
          const index = incoming.indexOf(ingress);
          if (index >= 0) incoming.splice(index, 1);
          settle();
        });
      }
      controller.enqueue(message);
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
        && next !== undefined) {
        next.accepting = true;
        next.promptRequestId = message.id;
        active = next;
        next = undefined;
      }
      const writer = stream.writable.getWriter();
      try {
        await writer.write(message);
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
    stream: { writable, readable },
    begin() {
      const epoch = { accepting: false, pending: new Set<Promise<void>>() };
      next = epoch;
      return epoch;
    },
    end(epoch) {
      epoch.accepting = false;
      if (active === epoch) active = undefined;
      if (next === epoch) next = undefined;
    },
    take: () => incoming.shift(),
    async drain(epoch) {
      epoch.accepting = false;
      if (active === epoch) active = undefined;
      if (next === epoch) next = undefined;
      while (epoch.pending.size > 0) {
        const pending = [...epoch.pending];
        await Promise.all(pending);
        for (const handled of pending) epoch.pending.delete(handled);
      }
    },
  };
}
