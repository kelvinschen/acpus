import { randomUUID } from "node:crypto";
import {
  createManagedAcpExecutor,
  recoverAcpOwnership,
  type ManagedAcpExecutor,
  type NamedAcpAgentLaunchRegistry,
} from "@acpus/agent-executor";
import { isAbsolute } from "node:path";
import { err, ok, ResultAsync, type Result } from "neverthrow";
import { readVerifiedArtifact } from "./artifacts/access.js";
import type { ArtifactRecord } from "./artifacts/types.js";
import {
  tryLoadRuntimeConfiguration,
  type RuntimeConfiguration,
} from "./configuration.js";
import { createRuntimeAuthorityIdentity } from "./daemon/authority.js";
import { RuntimeMutationQueue } from "./daemon/mutation-queue.js";
import {
  RunExecutionSessions,
  type RunIncident,
  type RunSessionControlFailure,
} from "./daemon/sessions.js";
import { runRuntimeTick } from "./daemon/tick.js";
import { formatHookLoadError, loadHooksConfig } from "./hooks/loader.js";
import { createHookRunner } from "./hooks/runner.js";
import {
  observeInspectionAtStore,
  readInspectionAtStore,
} from "./inspection/use-cases.js";
import type {
  InspectionError,
  InspectionObservation,
  InspectionRead,
  InspectionViewQuery,
  ObserveInspectionQuery,
} from "./inspection/types.js";
import {
  resolveRuntimeLayout,
  resolveRuntimeWorkspaceLayout,
  runAcpStateRoot,
  runtimeLayoutForGeneration,
  type RuntimeLayoutOptions,
} from "./runtime-layout.js";
import {
  initializeRuntimeStoreIfAbsent,
  inspectRuntimeStoreInternal,
  repairRuntimeStoreInternal,
  type RuntimeStoreAssessment,
  type RuntimeStoreFailure,
} from "./runtime-store-lifecycle.js";
import { acquireRuntimeSharedLock } from "./runtime-lock.js";
import type {
  RuntimeAuthorityIdentity,
  RuntimeControlFailure,
  RuntimeControlIntent,
  RuntimeControlResult,
  RuntimeSubmission,
  RuntimeSubmitFailure,
} from "./runtime-contracts.js";
import { isRuntimeStoreBusyError } from "./storage/database.js";
import { captureProcessIdentity } from "./process-liveness.js";
import {
  openRuntimeReadSessionAtLayout,
  openRuntimeStoreAtLayout,
  runtimeReadFailureFromError,
  type RunDetails,
  type RuntimeAuthorityBusy,
  type RuntimeReadFailure,
  type RuntimeStore,
} from "./store/store.js";

const EXECUTOR_SHUTDOWN_GRACE_MS = 10_000;

export type WorkspaceRuntimeOpenFailure =
  | { type: "runtime-store-unsupported" | "runtime-store-unavailable"; message: string }
  | RuntimeAuthorityBusy
  | { type: "runtime-configuration-invalid" | "runtime-open-failed"; message: string };

export type WorkspaceRuntimeLocation = Readonly<{
  workspace: string;
  stateRoot: string;
}>;

export type WorkspaceRuntimeHostDependencies = Readonly<{
  namedAgentLaunches?: NamedAcpAgentLaunchRegistry;
}>;

type WorkspaceRuntimeInternalOptions = {
  stateRoot?: string;
  heartbeatMs?: number;
  packageVersion?: string;
  onRunIncident?: (incident: RunIncident) => void;
  protocolVersion?: number;
  idleStopMs?: number;
  managedAcpExecutor?: ManagedAcpExecutor;
  namedAgentLaunches?: NamedAcpAgentLaunchRegistry;
  onAuthorityLost?: (runtime: OwnedWorkspaceRuntime) => void;
};

export interface WorkspaceRuntime {
  readonly workspace: string;
  submit(input: RuntimeSubmission): ResultAsync<RunDetails, RuntimeSubmitFailure>;
  control(
    input: RuntimeControlIntent,
  ): ResultAsync<RuntimeControlResult, RuntimeControlFailure>;
  inspect(input: InspectionViewQuery): ResultAsync<InspectionRead, InspectionError>;
  observeInspection(
    input: ObserveInspectionQuery,
    signal?: AbortSignal,
  ): AsyncIterable<Result<InspectionObservation, InspectionError>>;
  listArtifacts(
    runId: string,
  ): ResultAsync<ArtifactRecord[] | undefined, RuntimeReadFailure>;
  readArtifact(
    runId: string,
    artifactId: string,
  ): ResultAsync<{ artifact: ArtifactRecord; bytes: Buffer } | undefined, RuntimeReadFailure>;
  findAdmission(
    requestId: string,
  ): ResultAsync<RunDetails | undefined, RuntimeReadFailure>;
  close(): Promise<void>;
}

export type WorkspaceRuntimeActivity = {
  activeSessions: number;
  activeHooks: number;
  activeMutations: boolean;
  tickActive: boolean;
  runsStarted: number;
  idleBlockers: number;
};

export type OwnedWorkspaceRuntime = WorkspaceRuntime & {
  readonly authority: RuntimeAuthorityIdentity;
  activity(): WorkspaceRuntimeActivity;
  setIdleState(idleSinceAt: string | undefined, idleStopMs: number): boolean;
};

export function openWorkspaceRuntime(
  location: WorkspaceRuntimeLocation,
  dependencies: WorkspaceRuntimeHostDependencies = {},
): ResultAsync<WorkspaceRuntime, WorkspaceRuntimeOpenFailure> {
  if (!isAbsolute(location.stateRoot)) {
    return new ResultAsync(Promise.resolve(err({
      type: "runtime-open-failed" as const,
      message: "Workspace Runtime stateRoot must be an absolute path.",
    })));
  }
  return new ResultAsync(openHostWorkspaceRuntimeValue(location.workspace, {
    stateRoot: location.stateRoot,
    ...(dependencies.namedAgentLaunches === undefined
      ? {}
      : { namedAgentLaunches: dependencies.namedAgentLaunches }),
  }));
}

export function openWorkspaceRuntimeInternal(
  cwd: string,
  options: WorkspaceRuntimeInternalOptions = {},
): ResultAsync<OwnedWorkspaceRuntime, WorkspaceRuntimeOpenFailure> {
  return new ResultAsync(openPreparedWorkspaceRuntimeValue(cwd, options));
}

async function openHostWorkspaceRuntimeValue(
  cwd: string,
  options: WorkspaceRuntimeInternalOptions,
): Promise<Result<OwnedWorkspaceRuntime, WorkspaceRuntimeOpenFailure>> {
  const configuration = loadWorkspaceRuntimeConfiguration();
  if (configuration.isErr()) return err(configuration.error);
  const repaired = await repairRuntimeStoreInternal(cwd, runtimeLayoutOptions(options));
  if (repaired.isErr()) return err(storeRepairOpenFailure(repaired.error));
  return openWorkspaceRuntimeValue(cwd, options, configuration.value);
}

async function openPreparedWorkspaceRuntimeValue(
  cwd: string,
  options: WorkspaceRuntimeInternalOptions,
): Promise<Result<OwnedWorkspaceRuntime, WorkspaceRuntimeOpenFailure>> {
  const configuration = loadWorkspaceRuntimeConfiguration();
  if (configuration.isErr()) return err(configuration.error);
  return openWorkspaceRuntimeValue(cwd, options, configuration.value);
}

async function openWorkspaceRuntimeValue(
  cwd: string,
  options: WorkspaceRuntimeInternalOptions,
  configuration: RuntimeConfiguration,
): Promise<Result<OwnedWorkspaceRuntime, WorkspaceRuntimeOpenFailure>> {
  let store: RuntimeStore | undefined;
  let executor: ManagedAcpExecutor | undefined;
  let authorityFence:
    | { workspaceRealpath: string; ownerId: string; epoch: number }
    | undefined;
  try {
    const opened = await openReadyWorkspaceRuntimeStore(cwd, runtimeLayoutOptions(options));
    store = opened.store;
    const ownerId = randomUUID();
    const ownerProcess = captureProcessIdentity();
    const claim = store.claimRuntimeAuthority({
      workspaceRealpath: opened.layout.canonicalPath,
      ownerId,
      pid: ownerProcess.pid,
      ...(ownerProcess.startToken === undefined ? {} : { processStartToken: ownerProcess.startToken }),
      ...(options.protocolVersion === undefined ? {} : { protocolVersion: options.protocolVersion }),
      ...(options.packageVersion === undefined ? {} : { packageVersion: options.packageVersion }),
      nodeVersion: process.version,
      execPath: process.execPath,
      ...(options.idleStopMs === undefined ? {} : { idleStopMs: options.idleStopMs }),
    });
    if (claim.isErr()) {
      store.close();
      return err(claim.error);
    }
    authorityFence = {
      workspaceRealpath: claim.value.workspaceRealpath,
      ownerId: claim.value.ownerId,
      epoch: claim.value.epoch,
    };
    const hooksConfig = await loadHooksConfig(opened.layout.canonicalPath);
    if (hooksConfig.isErr()) throw new Error(formatHookLoadError(hooksConfig.error));
    const hookRunner = createHookRunner(hooksConfig.value, store);
    const executorOptions = {
      workersRoot: opened.layout.acpWorkersRoot,
      sessionStateDirectoryForRun: (runId: string) => runAcpStateRoot(opened.layout, runId),
      owner: { generation: claim.value.epoch, ...ownerProcess },
      ...(options.namedAgentLaunches === undefined
        ? {}
        : { namedAgentLaunches: options.namedAgentLaunches }),
    };
    await recoverAcpOwnership(executorOptions);
    executor = options.managedAcpExecutor ?? await createManagedAcpExecutor(executorOptions);
    const sessions = new RunExecutionSessions(
      opened.layout.canonicalPath,
      store,
      hookRunner,
      configuration,
      options.onRunIncident,
      executor,
      ownerId,
    );
    await store.observationLog.reconcileTerminalTurns();
    await store.cleanupStagedRunDirectories();
    return ok(new WorkspaceRuntimeImplementation({
      cwd: opened.layout.canonicalPath,
      store,
      layout: opened.layout,
      authority: createRuntimeAuthorityIdentity(opened.layout, claim.value.epoch),
      authorityFence,
      executor,
      sessions,
      heartbeatMs: options.heartbeatMs ?? 1_000,
      ...(options.onAuthorityLost === undefined ? {} : { onAuthorityLost: options.onAuthorityLost }),
    }));
  } catch (error) {
    const failures = [error];
    await settleResources(failures, [
      () => executor?.shutdown(),
      () => {
        if (store && authorityFence) store.releaseRuntimeAuthority(authorityFence);
      },
      () => store?.close(),
    ]);
    const settled = failures.length === 1
      ? failures[0]
      : new AggregateError(failures, "Workspace Runtime startup could not release every resource.");
    return err(openFailure(settled));
  }
}

class WorkspaceRuntimeImplementation implements OwnedWorkspaceRuntime {
  readonly workspace: string;
  readonly authority: RuntimeAuthorityIdentity;
  private readonly cwd: string;
  private readonly store: RuntimeStore;
  private readonly layout: Awaited<ReturnType<typeof openReadyWorkspaceRuntimeStore>>["layout"];
  private readonly authorityFence: { workspaceRealpath: string; ownerId: string; epoch: number };
  private readonly executor: ManagedAcpExecutor;
  private readonly sessions: RunExecutionSessions;
  private readonly mutations = new RuntimeMutationQueue();
  private readonly heartbeatTimer: NodeJS.Timeout;
  private readonly tickTimer: NodeJS.Timeout;
  private readonly onAuthorityLost: ((runtime: OwnedWorkspaceRuntime) => void) | undefined;
  private activeHeartbeat?: Promise<void>;
  private activeTick?: Promise<void>;
  private closePromise?: Promise<void>;
  private stopped = false;
  private ticking = false;
  private heartbeating = false;
  private latestTick = { runsStarted: 0, idleBlockers: 0 };

  constructor(input: {
    cwd: string;
    store: RuntimeStore;
    layout: Awaited<ReturnType<typeof openReadyWorkspaceRuntimeStore>>["layout"];
    authority: RuntimeAuthorityIdentity;
    authorityFence: { workspaceRealpath: string; ownerId: string; epoch: number };
    executor: ManagedAcpExecutor;
    sessions: RunExecutionSessions;
    heartbeatMs: number;
    onAuthorityLost?: (runtime: OwnedWorkspaceRuntime) => void;
  }) {
    this.cwd = input.cwd;
    this.workspace = input.cwd;
    this.store = input.store;
    this.layout = input.layout;
    this.authority = input.authority;
    this.authorityFence = input.authorityFence;
    this.executor = input.executor;
    this.sessions = input.sessions;
    this.onAuthorityLost = input.onAuthorityLost;
    this.heartbeatTimer = setInterval(() => {
      this.activeHeartbeat = this.heartbeat();
    }, input.heartbeatMs);
    this.tickTimer = setInterval(() => {
      this.startTick();
    }, input.heartbeatMs);
    this.startTick();
  }

  submit(input: RuntimeSubmission): ResultAsync<RunDetails, RuntimeSubmitFailure> {
    if (this.stopped) {
      return new ResultAsync(Promise.resolve(err(submitFailure(
        "not-admitted", "EXECUTION_UNAVAILABLE", "Workspace Runtime is closed.",
      ))));
    }
    let admittedRunId: string | undefined;
    return new ResultAsync(this.mutations.enqueue(async () => {
      try {
        const result = await this.store.admitRun({
          requestId: input.requestId,
          prepared: input.prepared,
          cwd: this.cwd,
          input: input.input,
          ...(input.agentOverrides === undefined ? {} : { agentOverrides: input.agentOverrides }),
        });
        if (result.isErr()) {
          return err(submitFailure(
            "not-admitted",
            result.error.type === "admission-request-conflict" ? "CONTROL_CONFLICT" : "INVALID_REQUEST",
            result.error.message,
          ));
        }
        admittedRunId = result.value.id;
        try {
          const run = result.value.status === "pending"
            ? this.sessions.start(result.value.id).run
            : this.store.getRun(result.value.id);
          if (!run) throw new Error(`Admitted run '${result.value.id}' was not found.`);
          return ok(run);
        } catch {
          return err(submitFailure(
            "admitted",
            "EXECUTION_UNAVAILABLE",
            "Run was admitted, but its execution session could not be started.",
            result.value.id,
          ));
        }
      } catch (error) {
        if (isRuntimeStoreBusyError(error)) {
          return err(submitFailure(
            admittedRunId === undefined ? "unknown" : "admitted",
            "STORE_BUSY",
            "Runtime store is busy. Retry the request.",
            admittedRunId,
          ));
        }
        return err(submitFailure(
          admittedRunId === undefined ? "unknown" : "admitted",
          "INTERNAL_ERROR",
          "Run admission failed.",
          admittedRunId,
        ));
      }
    }));
  }

  control(input: RuntimeControlIntent): ResultAsync<RuntimeControlResult, RuntimeControlFailure> {
    if (this.stopped) {
      return new ResultAsync(Promise.resolve(err({
        type: "runtime-control-failed",
        code: "RUN_NOT_CONTROLLABLE",
        message: "Workspace Runtime is closed.",
      })));
    }
    return new ResultAsync(this.mutations.enqueue(async () => {
      if (!this.store.getRun(input.runId)) {
        return err({
          type: "runtime-control-failed",
          code: "RUN_NOT_FOUND",
          message: `Run '${input.runId}' was not found.`,
        });
      }
      try {
        const result = await this.sessions.control(input);
        return result.isErr() ? err(controlFailure(input, result.error)) : ok(result.value);
      } catch (error) {
        if (isRuntimeStoreBusyError(error)) {
          return err({
            type: "runtime-control-failed",
            code: "STORE_BUSY",
            message: "Runtime store is busy. Retry the request.",
          });
        }
        throw error;
      }
    }));
  }

  inspect(input: InspectionViewQuery): ResultAsync<InspectionRead, InspectionError> {
    return new ResultAsync((async () => {
      const session = await openRuntimeReadSessionAtLayout(this.layout);
      if (session.isErr()) return err({ ...session.error, runId: input.runId });
      try {
        return await readInspectionAtStore(session.value.store, input);
      } finally {
        session.value.close();
      }
    })());
  }

  observeInspection(
    input: ObserveInspectionQuery,
    signal?: AbortSignal,
  ): AsyncIterable<Result<InspectionObservation, InspectionError>> {
    return this.observeInspectionFromReadSession(input, signal);
  }

  private async *observeInspectionFromReadSession(
    input: ObserveInspectionQuery,
    signal?: AbortSignal,
  ): AsyncIterable<Result<InspectionObservation, InspectionError>> {
    const session = await openRuntimeReadSessionAtLayout(this.layout);
    if (session.isErr()) {
      yield err({ ...session.error, runId: input.view.runId });
      return;
    }
    try {
      yield* observeInspectionAtStore(session.value.store, {
        ...input,
        ...(signal === undefined ? {} : { signal }),
      });
    } finally {
      session.value.close();
    }
  }

  listArtifacts(
    runId: string,
  ): ResultAsync<ArtifactRecord[] | undefined, RuntimeReadFailure> {
    return this.boundRead(() =>
      this.store.getRun(runId) ? this.store.listArtifacts(runId) : undefined);
  }

  readArtifact(
    runId: string,
    artifactId: string,
  ): ResultAsync<{ artifact: ArtifactRecord; bytes: Buffer } | undefined, RuntimeReadFailure> {
    return this.boundRead(() => readVerifiedArtifact({ runId, store: this.store }, artifactId));
  }

  findAdmission(requestId: string): ResultAsync<RunDetails | undefined, RuntimeReadFailure> {
    return this.boundRead(() => {
      const record = this.store.lookupAdmission(requestId);
      return record === undefined ? undefined : this.store.getRun(record.id);
    });
  }

  activity(): WorkspaceRuntimeActivity {
    return {
      activeSessions: this.sessions.activeCount(),
      activeHooks: this.sessions.hookActiveCount(),
      activeMutations: !this.mutations.isIdle(),
      tickActive: this.ticking,
      ...this.latestTick,
    };
  }

  setIdleState(idleSinceAt: string | undefined, idleStopMs: number): boolean {
    return this.store.setRuntimeAuthorityIdleState({
      ...this.authorityFence,
      ...(idleSinceAt === undefined ? {} : { idleSinceAt }),
      idleStopMs,
    });
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.stopped = true;
    clearInterval(this.heartbeatTimer);
    clearInterval(this.tickTimer);
    this.closePromise = (async () => {
      const failures: unknown[] = [];
      await settleResources(failures, [
        () => this.activeTick,
        () => this.activeHeartbeat,
        () => this.mutations.drain(),
        () => settleConcurrentResources(failures, [
          () => this.sessions.stopExecutors(EXECUTOR_SHUTDOWN_GRACE_MS),
          () => this.executor.shutdown(),
        ]),
        () => this.sessions.drainHooks(),
        () => this.store.releaseRuntimeAuthority(this.authorityFence),
        () => this.store.close(),
      ]);
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) {
        throw new AggregateError(failures, "Workspace Runtime shutdown could not release every resource.");
      }
    })();
    return this.closePromise;
  }

  private boundRead<T>(read: () => T): ResultAsync<T, RuntimeReadFailure> {
    return new ResultAsync((async () => {
      try {
        return ok(read());
      } catch (error) {
        return err(runtimeReadFailureFromError(error));
      }
    })());
  }

  private startTick(): void {
    if (this.ticking || this.stopped) return;
    this.activeTick = this.tick();
  }

  private async heartbeat(): Promise<void> {
    if (this.heartbeating || this.stopped) return;
    this.heartbeating = true;
    try {
      if (!this.store.heartbeatRuntimeAuthority(this.authorityFence)) this.authorityLost();
    } catch (error) {
      if (!this.stopped && !isRuntimeStoreBusyError(error)) this.authorityLost();
    } finally {
      this.heartbeating = false;
    }
  }

  private async tick(): Promise<void> {
    this.ticking = true;
    try {
      const result = await runRuntimeTick(this.store, {
        startSession: runId => this.sessions.start(runId).disposition,
        dispatchHooks: runId => this.sessions.dispatchHooks(runId),
      });
      this.latestTick = { runsStarted: result.runs, idleBlockers: result.idleBlockers };
    } catch (error) {
      if (!this.stopped && !isRuntimeStoreBusyError(error)) this.authorityLost();
    } finally {
      this.ticking = false;
    }
  }

  private authorityLost(): void {
    if (this.stopped) return;
    try {
      this.onAuthorityLost?.(this);
    } catch {}
    if (!this.onAuthorityLost) void this.close().catch(() => {});
  }
}

async function openReadyWorkspaceRuntimeStore(
  cwd: string,
  options: RuntimeLayoutOptions,
): Promise<{
  store: RuntimeStore;
  layout: ReturnType<typeof runtimeLayoutForGeneration>;
}> {
  const first = await inspectRuntimeStoreInternal(cwd, options);
  if (first.isErr()) {
    if (first.error.reason === "busy") return openPublishedWorkspaceRuntimeStore(cwd, options);
    throw openReadinessError(first.error);
  }
  if (first.value.current.state === "absent") await initializeRuntimeStoreIfAbsent(cwd, options);
  else if (first.value.current.state !== "ready") throw assessmentReadinessError(first.value);
  const workspace = resolveRuntimeWorkspaceLayout(cwd, options);
  let lock;
  try {
    lock = await acquireRuntimeSharedLock(workspace);
  } catch (error) {
    throw openReadinessError(error);
  }
  let adopted = false;
  try {
    const checked = await inspectRuntimeStoreInternal(cwd, options);
    if (checked.isErr()) {
      if (checked.error.reason !== "busy") throw openReadinessError(checked.error);
      const layout = resolveRuntimeLayout(cwd, options);
      if (layout.generationId === undefined) throw openReadinessError(checked.error);
      adopted = true;
      return {
        store: await openRuntimeStoreAtLayout(layout, { lock, prevalidated: true }),
        layout,
      };
    }
    if (checked.value.current.state !== "ready") throw assessmentReadinessError(checked.value);
    const layout = runtimeLayoutForGeneration(workspace, checked.value.current.generationId);
    adopted = true;
    return {
      store: await openRuntimeStoreAtLayout(layout, { lock, prevalidated: true }),
      layout,
    };
  } catch (error) {
    if (!adopted) lock.release();
    throw error;
  }
}

async function openPublishedWorkspaceRuntimeStore(
  cwd: string,
  options: RuntimeLayoutOptions,
): Promise<{
  store: RuntimeStore;
  layout: ReturnType<typeof runtimeLayoutForGeneration>;
}> {
  const workspace = resolveRuntimeWorkspaceLayout(cwd, options);
  const lock = await acquireRuntimeSharedLock(workspace);
  let adopted = false;
  try {
    const layout = resolveRuntimeLayout(cwd, options);
    if (layout.generationId === undefined) {
      throw new Error("The current Runtime generation is not published.");
    }
    adopted = true;
    return {
      store: await openRuntimeStoreAtLayout(layout, { lock, prevalidated: true }),
      layout,
    };
  } finally {
    if (!adopted) lock.release();
  }
}

function runtimeLayoutOptions(options: WorkspaceRuntimeInternalOptions): RuntimeLayoutOptions {
  return options.stateRoot === undefined ? {} : { runtimeHome: options.stateRoot };
}

function loadWorkspaceRuntimeConfiguration(): Result<RuntimeConfiguration, WorkspaceRuntimeOpenFailure> {
  return tryLoadRuntimeConfiguration(process.env).mapErr(failure => ({
    type: "runtime-configuration-invalid" as const,
    message: failure.message,
  }));
}

function assessmentReadinessError(source: RuntimeStoreAssessment): WorkspaceRuntimeOpenFailure {
  if (source.current.state === "unsupported") {
    return { type: "runtime-store-unsupported", message: source.current.detail };
  }
  return {
    type: "runtime-store-unavailable",
    message: "Runtime store changed while Workspace Runtime was opening.",
  };
}

function storeRepairOpenFailure(failure: RuntimeStoreFailure): WorkspaceRuntimeOpenFailure {
  return {
    type: failure.type === "unsupported" ? "runtime-store-unsupported" : "runtime-store-unavailable",
    message: failure.message,
  };
}

function openReadinessError(source: { type: "inspect-failed"; message: string } | unknown): WorkspaceRuntimeOpenFailure {
  return {
    type: "runtime-store-unavailable",
    message: typeof source === "object"
      && source !== null
      && "message" in source
      && typeof source.message === "string"
      ? source.message
      : source instanceof Error ? source.message : String(source),
  };
}

function openFailure(error: unknown): WorkspaceRuntimeOpenFailure {
  if (isWorkspaceRuntimeOpenFailure(error)) return error;
  return {
    type: "runtime-open-failed",
    message: error instanceof Error ? error.message : String(error),
  };
}

function isWorkspaceRuntimeOpenFailure(error: unknown): error is WorkspaceRuntimeOpenFailure {
  return typeof error === "object" && error !== null && "type" in error
    && typeof (error as { type?: unknown }).type === "string"
    && String((error as { type: string }).type).startsWith("runtime-");
}

function submitFailure(
  outcome: RuntimeSubmitFailure["outcome"],
  code: RuntimeSubmitFailure["code"],
  message: string,
  runId?: string,
): RuntimeSubmitFailure {
  return {
    type: "runtime-submit-failed",
    outcome,
    ...(runId === undefined ? {} : { runId }),
    code,
    message,
  };
}

function controlFailure(
  intent: RuntimeControlIntent,
  failure: RunSessionControlFailure,
): RuntimeControlFailure {
  const code: RuntimeControlFailure["code"] = failure.type === "run-not-found"
    ? "RUN_NOT_FOUND"
    : failure.type === "prepared-workflow-invalid"
      || failure.type === "schema-mismatch"
      || failure.type === "agent-overrides-invalid"
      || failure.type === "invalid-steer-instruction"
      ? "INVALID_REQUEST"
      : failure.type === "idempotency-conflict"
        || failure.type === "fork-request-conflict"
        || failure.type === "ambiguous-steer-target"
        || failure.type === "steer-session-conflict"
        ? "CONTROL_CONFLICT"
        : "RUN_NOT_CONTROLLABLE";
  const message = failure.type === "idempotency-conflict"
    ? `Control request '${intent.requestId}' conflicts with a different request.`
    : failure.type === "version-mismatch"
      || failure.type === "owner-epoch-inactive"
      || failure.type === "owner-epoch-still-active"
      || failure.type === "owner-epoch-stale"
      || failure.type === "instance-not-ready"
      || failure.type === "terminal-attempt"
      || failure.type === "attempt-not-found"
      ? `Control '${intent.type}' could not be applied to run '${intent.runId}'.`
      : failure.message;
  const ambiguity = failure.type === "ambiguous-retry-target"
    || failure.type === "ambiguous-cancel-target"
    || failure.type === "ambiguous-steer-target"
    || failure.type === "signal-target-ambiguous"
    || failure.type === "dynamic-target-ambiguity";
  return {
    type: "runtime-control-failed",
    code,
    message,
    ...(ambiguity ? { ambiguity: true } : {}),
  };
}

async function settleResources(
  failures: unknown[],
  steps: Array<() => void | Promise<void> | undefined>,
): Promise<void> {
  for (const step of steps) {
    try {
      await step();
    } catch (error) {
      failures.push(error);
    }
  }
}

async function settleConcurrentResources(
  failures: unknown[],
  steps: Array<() => void | Promise<void> | undefined>,
): Promise<void> {
  const pending = steps.map(step => {
    try {
      return Promise.resolve(step());
    } catch (error) {
      return Promise.reject(error);
    }
  });
  failures.push(...(await Promise.allSettled(pending))
    .flatMap(result => result.status === "rejected" ? [result.reason] : []));
}
