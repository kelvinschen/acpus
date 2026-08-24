import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import {
  createAgentSessionSupervisor,
  inspectAcpOwnership,
  type AgentSessionSupervisor,
  type NamedAcpAgentLaunchRegistry,
} from "@acpus/agent-executor";
import { makeNodeProcessHost, type ProcessHostShape } from "@acpus/owned-process";
import { isAbsolute } from "node:path";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FiberSet from "effect/FiberSet";
import * as Result from "effect/Result";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { ArtifactReadUnavailableError, readVerifiedArtifact } from "./artifacts/access.js";
import type { ArtifactRecord } from "./artifacts/types.js";
import {
  resolveConfiguredAgentCommand,
  type AgentPresetProvider,
} from "./acpus-config.js";
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
import { formatHookLoadError, loadHooksConfigResult } from "./hooks/loader.js";
import { createHookRunner } from "./hooks/runner.js";
import {
  observeInspectionAtStore,
  readInspectionAtStore,
} from "./inspection/use-cases.js";
import {
  ownershipHealthProjection,
  withInspectionOwnershipHealth,
  withObservationOwnershipHealth,
} from "./inspection/ownership-health.js";
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
  type RuntimeLayout,
  type RuntimeLayoutOptions,
} from "./runtime-layout.js";
import {
  initializeRuntimeStoreIfAbsent,
  inspectRuntimeStoreInternal,
  repairRuntimeStoreInternal,
  type RuntimeStoreAssessment,
  type RuntimeStoreFailure,
} from "./runtime-store-lifecycle.js";
import { openRuntimeSharedLock } from "./runtime-lock-adapter.js";
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
  openRuntimeStoreAdapterAtLayout,
  runtimeReadFailureFromError,
  type RunDetails,
  type RuntimeAuthorityBusy,
  type RuntimeReadFailure,
  type RuntimeStoreAdapter,
} from "./store/store.js";
import {
  acquireRuntimeReadSessionAtLayout,
  makeRuntimeStoreService,
  type RuntimeStoreShape,
} from "./store/service.js";

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
  agentPresetProvider?: AgentPresetProvider;
}>;

type WorkspaceRuntimeInternalOptions = {
  stateRoot?: string;
  heartbeatMs?: number;
  packageVersion?: string;
  onRunIncident?: (incident: RunIncident) => void;
  protocolVersion?: number;
  idleStopMs?: number;
  agentSessionSupervisor?: AgentSessionSupervisor;
  namedAgentLaunches?: NamedAcpAgentLaunchRegistry;
  agentPresetProvider?: AgentPresetProvider;
  onAuthorityLost?: (runtime: OwnedWorkspaceRuntime) => void;
};

export interface WorkspaceRuntime {
  readonly workspace: string;
  submit(input: RuntimeSubmission): Effect.Effect<RunDetails, RuntimeSubmitFailure>;
  control(
    input: RuntimeControlIntent,
  ): Effect.Effect<RuntimeControlResult, RuntimeControlFailure>;
  inspect(input: InspectionViewQuery): Effect.Effect<InspectionRead, InspectionError>;
  observeInspection(
    input: ObserveInspectionQuery,
    signal?: AbortSignal,
  ): Stream.Stream<InspectionObservation, InspectionError>;
  listArtifacts(
    runId: string,
  ): Effect.Effect<ArtifactRecord[] | undefined, RuntimeReadFailure>;
  readArtifact(
    runId: string,
    artifactId: string,
  ): Effect.Effect<{ artifact: ArtifactRecord; bytes: Buffer } | undefined, RuntimeReadFailure>;
  findAdmission(
    requestId: string,
  ): Effect.Effect<RunDetails | undefined, RuntimeReadFailure>;
  close(): Effect.Effect<void>;
}

type WorkspaceRuntimeActivity = {
  activeSessions: number;
  activeHooks: number;
  activeMutations: boolean;
  tickActive: boolean;
  runsStarted: number;
  idleBlockers: number;
};

type WorkspaceSupervisorOwner = {
  cleanup: Effect.Effect<void, Error>;
  observed: boolean;
};

export type OwnedWorkspaceRuntime = WorkspaceRuntime & {
  readonly authority: RuntimeAuthorityIdentity;
  activity(): WorkspaceRuntimeActivity;
  setIdleState(idleSinceAt: string | undefined, idleStopMs: number): boolean;
  stopScheduling(): void;
};

export function openWorkspaceRuntime(
  location: WorkspaceRuntimeLocation,
  dependencies: WorkspaceRuntimeHostDependencies = {},
): Effect.Effect<WorkspaceRuntime, WorkspaceRuntimeOpenFailure> {
  if (!isAbsolute(location.stateRoot)) {
    return Effect.fail({
      type: "runtime-open-failed" as const,
      message: "Workspace Runtime stateRoot must be an absolute path.",
    });
  }
  return openHostWorkspaceRuntime(location.workspace, {
    stateRoot: location.stateRoot,
    ...(dependencies.namedAgentLaunches === undefined
      ? {}
      : { namedAgentLaunches: dependencies.namedAgentLaunches }),
    ...(dependencies.agentPresetProvider === undefined
      ? {}
      : { agentPresetProvider: dependencies.agentPresetProvider }),
  });
}

export function openWorkspaceRuntimeInternal(
  cwd: string,
  options: WorkspaceRuntimeInternalOptions = {},
): Effect.Effect<OwnedWorkspaceRuntime, WorkspaceRuntimeOpenFailure> {
  return openPreparedWorkspaceRuntime(cwd, options);
}

function openHostWorkspaceRuntime(
  cwd: string,
  options: WorkspaceRuntimeInternalOptions,
): Effect.Effect<OwnedWorkspaceRuntime, WorkspaceRuntimeOpenFailure> {
  return Effect.gen(function*() {
    const configuration = yield* Effect.fromResult(loadWorkspaceRuntimeConfiguration());
    const repaired = yield* repairRuntimeStoreInternal(cwd, runtimeLayoutOptions(options));
    if (Result.isFailure(repaired)) {
      return yield* Effect.fail(storeRepairOpenFailure(repaired.failure));
    }
    return yield* openWorkspaceRuntimeWithScope(cwd, options, configuration);
  });
}

function openPreparedWorkspaceRuntime(
  cwd: string,
  options: WorkspaceRuntimeInternalOptions,
): Effect.Effect<OwnedWorkspaceRuntime, WorkspaceRuntimeOpenFailure> {
  return Effect.fromResult(loadWorkspaceRuntimeConfiguration()).pipe(
    Effect.flatMap(configuration => openWorkspaceRuntimeWithScope(cwd, options, configuration)),
  );
}

function openWorkspaceRuntimeWithScope(
  cwd: string,
  options: WorkspaceRuntimeInternalOptions,
  configuration: RuntimeConfiguration,
): Effect.Effect<OwnedWorkspaceRuntime, WorkspaceRuntimeOpenFailure> {
  return Effect.gen(function*() {
    const rootScope = yield* Scope.make();
    const opened = yield* Effect.exit(openWorkspaceRuntimeInScope(
      cwd,
      options,
      configuration,
      rootScope,
    ));
    if (Exit.isSuccess(opened)) return opened.value;
    const released = yield* Effect.exit(Scope.close(rootScope, opened));
    const failures = [Cause.squash(opened.cause), ...exitFailures(released)];
    return yield* Effect.fail(openFailure(failures.length === 1
      ? failures[0]
      : new AggregateError(failures, "Workspace Runtime startup could not release every resource.")));
  });
}

function openWorkspaceRuntimeInScope(
  cwd: string,
  options: WorkspaceRuntimeInternalOptions,
  configuration: RuntimeConfiguration,
  rootScope: Scope.Closeable,
): Effect.Effect<OwnedWorkspaceRuntime, WorkspaceRuntimeOpenFailure> {
  return Effect.gen(function*() {
    const ownedScope = yield* Scope.fork(rootScope);
    const opened = yield* Scope.provide(ownedScope)(acquireReadyWorkspaceRuntimeStore(
        cwd,
        runtimeLayoutOptions(options),
        options.agentPresetProvider,
      )).pipe(Effect.mapError(openFailure));
    const store = opened.store;
    const ownerId = randomUUID();
    const ownerProcess = captureProcessIdentity();
    const claim = yield* Effect.try({
      try: () => store.claimRuntimeAuthority({
      workspaceRealpath: opened.layout.canonicalPath,
      ownerId,
      pid: ownerProcess.pid,
      ...(ownerProcess.startToken === undefined ? {} : { processStartToken: ownerProcess.startToken }),
      ...(options.protocolVersion === undefined ? {} : { protocolVersion: options.protocolVersion }),
      ...(options.packageVersion === undefined ? {} : { packageVersion: options.packageVersion }),
      nodeVersion: process.version,
      execPath: process.execPath,
      ...(options.idleStopMs === undefined ? {} : { idleStopMs: options.idleStopMs }),
      }),
      catch: openFailure,
    }).pipe(Effect.flatMap(Effect.fromResult));
    const authorityFence = {
      workspaceRealpath: claim.workspaceRealpath,
      ownerId: claim.ownerId,
      epoch: claim.epoch,
    };
    yield* Scope.addFinalizer(ownedScope, Effect.sync(() => {
      store.releaseRuntimeAuthority(authorityFence);
    }));
    const hooksConfig = yield* Effect.tryPromise({
      try: () => loadHooksConfigResult(opened.layout.canonicalPath),
      catch: openFailure,
    });
    if (Result.isFailure(hooksConfig)) {
      return yield* Effect.fail(openFailure(new Error(formatHookLoadError(hooksConfig.failure))));
    }
    const processes = makeNodeProcessHost();
    const hookScope = yield* Scope.fork(ownedScope);
    const hookRunner = yield* Scope.provide(hookScope)(
      createHookRunner(hooksConfig.success, store, processes),
    );
    const configHomeDir = homedir();
    const supervisorOptions = {
      workersRoot: opened.layout.acpWorkersRoot,
      sessionStateDirectoryForRun: (runId: string) => runAcpStateRoot(opened.layout, runId),
      owner: { epoch: claim.epoch, ...ownerProcess },
      ...(options.namedAgentLaunches === undefined
        ? {}
        : { namedAgentLaunches: options.namedAgentLaunches }),
      configuredAgentCommand: (names: readonly string[]) => resolveConfiguredAgentCommand({
        workspaceDir: opened.layout.canonicalPath,
        homeDir: configHomeDir,
        names,
      }).pipe(Effect.mapError(failure => ({
        type: "agent-config" as const,
        message: `Invalid Acpus config at '${failure.path}': ${failure.message}`,
      }))),
    };
    let supervisor = options.agentSessionSupervisor;
    if (supervisor === undefined) {
      supervisor = yield* Scope.provide(ownedScope)(
        createAgentSessionSupervisor(supervisorOptions, processes),
      ).pipe(Effect.mapError(failure => openFailure(new Error(failure.message))));
    }
    const supervisorOwner: WorkspaceSupervisorOwner = {
      cleanup: yield* Effect.cached(supervisor.shutdown().pipe(
        Effect.mapError(error => new Error(error.message)),
      )),
      observed: false,
    };
    yield* Scope.addFinalizer(ownedScope, Effect.suspend(() => supervisorOwner.observed
      ? supervisorOwner.cleanup.pipe(Effect.ignoreCause)
      : supervisorOwner.cleanup.pipe(Effect.orDie)));
    const sessions = new RunExecutionSessions(
      opened.layout.canonicalPath,
      store,
      hookRunner,
      configuration,
      processes,
      ownedScope,
      options.onRunIncident,
      supervisor,
      claim.epoch,
      ownerId,
    );
    yield* store.observationLog.reconcileTerminalTurns().pipe(
      Effect.catchDefect(error => Effect.fail(openFailure(error))),
    );
    yield* Effect.tryPromise({
      try: () => store.cleanupStagedRunDirectories(),
      catch: openFailure,
    });
    const operations = yield* Scope.provide(ownedScope)(FiberSet.make<void>());
    const runtime = new WorkspaceRuntimeImplementation({
      cwd: opened.layout.canonicalPath,
      store,
      layout: opened.layout,
      authority: createRuntimeAuthorityIdentity(opened.layout, claim.ownerId, claim.epoch),
      authorityFence,
      supervisorOwner,
      sessions,
      processes,
      rootScope,
      ownedScope,
      operations,
      ...(options.onAuthorityLost === undefined ? {} : { onAuthorityLost: options.onAuthorityLost }),
    });
    yield* runtime.initialize(options.heartbeatMs ?? 1_000);
    return runtime;
  });
}

class WorkspaceRuntimeImplementation implements OwnedWorkspaceRuntime {
  readonly workspace: string;
  readonly authority: RuntimeAuthorityIdentity;
  private readonly cwd: string;
  private readonly store: RuntimeStoreAdapter;
  private readonly runtimeStore: RuntimeStoreShape;
  private readonly layout: Effect.Success<ReturnType<typeof acquireReadyWorkspaceRuntimeStore>>["layout"];
  private readonly authorityFence: { workspaceRealpath: string; ownerId: string; epoch: number };
  private readonly supervisorOwner: WorkspaceSupervisorOwner;
  private readonly sessions: RunExecutionSessions;
  private readonly processes: ProcessHostShape;
  private readonly rootScope: Scope.Closeable;
  private readonly ownedScope: Scope.Closeable;
  private readonly operations: FiberSet.FiberSet<void>;
  private readonly shutdownRequested = Deferred.makeUnsafe<void>();
  private readonly mutations = new RuntimeMutationQueue();
  private readonly onAuthorityLost: ((runtime: OwnedWorkspaceRuntime) => void) | undefined;
  private cleanup: Effect.Effect<void> = Effect.void;
  private cleanupObserved = false;
  private lifecycle?: Fiber.Fiber<void>;
  private closeEffect: Effect.Effect<void> = Effect.void;
  private stopped = false;
  private ticking = false;
  private latestTick = { runsStarted: 0, idleBlockers: 0 };

  constructor(input: {
    cwd: string;
    store: RuntimeStoreAdapter;
    layout: Effect.Success<ReturnType<typeof acquireReadyWorkspaceRuntimeStore>>["layout"];
    authority: RuntimeAuthorityIdentity;
    authorityFence: { workspaceRealpath: string; ownerId: string; epoch: number };
    supervisorOwner: WorkspaceSupervisorOwner;
    sessions: RunExecutionSessions;
    processes: ProcessHostShape;
    rootScope: Scope.Closeable;
    ownedScope: Scope.Closeable;
    operations: FiberSet.FiberSet<void>;
    onAuthorityLost?: (runtime: OwnedWorkspaceRuntime) => void;
  }) {
    this.cwd = input.cwd;
    this.workspace = input.cwd;
    this.store = input.store;
    this.runtimeStore = makeRuntimeStoreService(input.store);
    this.layout = input.layout;
    this.authority = input.authority;
    this.authorityFence = input.authorityFence;
    this.supervisorOwner = input.supervisorOwner;
    this.sessions = input.sessions;
    this.processes = input.processes;
    this.rootScope = input.rootScope;
    this.ownedScope = input.ownedScope;
    this.operations = input.operations;
    this.onAuthorityLost = input.onAuthorityLost;
  }

  initialize(heartbeatMs: number): Effect.Effect<void> {
    const runtime = this;
    return Effect.gen(function*() {
      runtime.cleanup = yield* Effect.cached(Effect.uninterruptible(runtime.shutdownOwned()));
      yield* Scope.addFinalizer(runtime.ownedScope, Effect.suspend(() => runtime.cleanupObserved
        ? runtime.cleanup.pipe(Effect.ignoreCause)
        : runtime.cleanup));
      yield* FiberSet.run(runtime.operations, runtime.tickLoop(heartbeatMs), { startImmediately: true });
      yield* FiberSet.run(runtime.operations, runtime.heartbeatLoop(heartbeatMs), { startImmediately: true });
      runtime.lifecycle = yield* Effect.forkIn(runtime.lifecycleEffect(), runtime.rootScope, {
        startImmediately: true,
      });
      runtime.closeEffect = yield* Effect.cached(Effect.uninterruptible(runtime.closeWorkspace()));
    });
  }

  submit(input: RuntimeSubmission): Effect.Effect<RunDetails, RuntimeSubmitFailure> {
    const runtime = this;
    return this.mutations.enqueue(Effect.gen(function* () {
      if (runtime.stopped) {
        return yield* Effect.fail(submitFailure(
          "not-admitted", "EXECUTION_UNAVAILABLE", "Workspace Runtime is closed.",
        ));
      }
      const admitted = yield* runtime.runtimeStore.admitRun({
          requestId: input.requestId,
          prepared: input.prepared,
          cwd: runtime.cwd,
          input: input.input,
          ...(input.agentInjections === undefined ? {} : { agentInjections: input.agentInjections }),
        }).pipe(Effect.mapError(failure => failure.type === "runtime-store-busy"
          ? submitFailure("unknown", "STORE_BUSY", "Runtime store is busy. Retry the request.")
          : submitFailure(
            "not-admitted",
            failure.type === "admission-request-conflict" ? "CONTROL_CONFLICT" : "INVALID_REQUEST",
            failure.message,
          )));
      const unavailable = () => submitFailure(
            "admitted",
            "EXECUTION_UNAVAILABLE",
            "Run was admitted, but its execution session could not be started.",
            admitted.id,
          );
      const run = admitted.status === "pending"
        ? yield* runtime.sessions.start(admitted.id).pipe(
          Effect.map(started => started.run),
          Effect.mapError(unavailable),
        )
        : yield* runtime.runtimeStore.getRun(admitted.id).pipe(Effect.mapError(unavailable));
      if (!run) return yield* Effect.fail(unavailable());
      return run;
    }));
  }

  control(input: RuntimeControlIntent): Effect.Effect<RuntimeControlResult, RuntimeControlFailure> {
    const runtime = this;
    return this.mutations.enqueue(Effect.gen(function* () {
      if (runtime.stopped) {
        return yield* Effect.fail({
          type: "runtime-control-failed" as const,
          code: "RUN_NOT_CONTROLLABLE" as const,
          message: "Workspace Runtime is closed.",
        });
      }
      const existing = yield* runtime.runtimeStore.getRun(input.runId).pipe(
        Effect.mapError(() => runtimeControlStoreBusy()),
      );
      if (!existing) {
        return yield* Effect.fail({
          type: "runtime-control-failed" as const,
          code: "RUN_NOT_FOUND" as const,
          message: `Run '${input.runId}' was not found.`,
        });
      }
      return yield* runtime.sessions.control(input).pipe(
        Effect.mapError(failure => failure.type === "runtime-store-busy"
          ? runtimeControlStoreBusy()
          : controlFailure(input, failure)),
      );
    }));
  }

  inspect(input: InspectionViewQuery): Effect.Effect<InspectionRead, InspectionError> {
    const runtime = this;
    return Effect.scoped(Effect.gen(function* () {
      const session = yield* acquireRuntimeReadSessionAtLayout(runtime.layout).pipe(
        Effect.mapError(failure => ({ ...failure, runId: input.runId })),
      );
      const read = yield* readInspectionAtStore(
        session.store,
        input,
        proof => runtime.sessions.provesAgentTurn(proof),
      );
      const processIdentity = captureProcessIdentity();
      const ownership = yield* inspectAcpOwnership({
        workersRoot: runtime.layout.acpWorkersRoot,
        owner: {
          epoch: runtime.authorityFence.epoch,
          pid: processIdentity.pid,
          ...(processIdentity.startToken === undefined ? {} : { startToken: processIdentity.startToken }),
        },
      }, runtime.processes);
      return withInspectionOwnershipHealth(read, ownershipHealthProjection(ownership));
    }));
  }

  observeInspection(
    input: ObserveInspectionQuery,
    signal?: AbortSignal,
  ): Stream.Stream<InspectionObservation, InspectionError> {
    return Stream.unwrap(acquireRuntimeReadSessionAtLayout(this.layout).pipe(
      Effect.mapError(failure => ({ ...failure, runId: input.view.runId })),
      Effect.map(session => observeInspectionAtStore(session.store, {
      ...input,
      ...(signal === undefined ? {} : { signal }),
    }, proof => this.sessions.provesAgentTurn(proof)).pipe(
      Stream.mapEffect(observed => {
        if (observed.kind === "update") return Effect.succeed(observed);
        const processIdentity = captureProcessIdentity();
        return inspectAcpOwnership({
          workersRoot: this.layout.acpWorkersRoot,
          owner: {
            epoch: this.authorityFence.epoch,
            pid: processIdentity.pid,
            ...(processIdentity.startToken === undefined ? {} : { startToken: processIdentity.startToken }),
          },
        }, this.processes).pipe(Effect.map(ownership =>
          withObservationOwnershipHealth(observed, ownershipHealthProjection(ownership))));
      }),
    ))));
  }

  listArtifacts(
    runId: string,
  ): Effect.Effect<ArtifactRecord[] | undefined, RuntimeReadFailure> {
    return this.boundRead(() =>
      this.store.getRun(runId) ? this.store.listArtifacts(runId) : undefined);
  }

  readArtifact(
    runId: string,
    artifactId: string,
  ): Effect.Effect<{ artifact: ArtifactRecord; bytes: Buffer } | undefined, RuntimeReadFailure> {
    return this.boundRead(() => readVerifiedArtifact({ runId, store: this.store }, artifactId));
  }

  findAdmission(requestId: string): Effect.Effect<RunDetails | undefined, RuntimeReadFailure> {
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

  close(): Effect.Effect<void> {
    this.requestShutdown();
    return this.closeEffect;
  }

  stopScheduling(): void {
    this.stopped = true;
  }

  private closeWorkspace(): Effect.Effect<void> {
    const runtime = this;
    return Effect.gen(function*() {
      runtime.requestShutdown();
      const lifecycle = runtime.lifecycle;
      if (lifecycle === undefined) return;
      const settled = yield* Fiber.await(lifecycle);
      const released = yield* Effect.exit(Scope.close(runtime.rootScope, settled));
      return yield* failCleanup(
        [...exitFailures(settled), ...exitFailures(released)],
        "Workspace Runtime shutdown could not release every resource.",
      );
    });
  }

  private lifecycleEffect(): Effect.Effect<void> {
    return Deferred.await(this.shutdownRequested).pipe(
      Effect.andThen(Effect.uninterruptible(this.closeOwnedScope())),
    );
  }

  private closeOwnedScope(): Effect.Effect<void> {
    const runtime = this;
    return Effect.gen(function*() {
      const semantic = yield* Effect.exit(runtime.cleanup);
      runtime.cleanupObserved = true;
      const structural = yield* Effect.exit(Scope.close(runtime.ownedScope, semantic));
      return yield* failCleanup(
        [...exitFailures(semantic), ...exitFailures(structural)],
        "Workspace Runtime shutdown could not release every resource.",
      );
    });
  }

  private shutdownOwned(): Effect.Effect<void> {
    const runtime = this;
    return Effect.gen(function*() {
      runtime.stopped = true;
      const failures: unknown[] = [];
      failures.push(...exitFailures(yield* Effect.exit(
        FiberSet.clear(runtime.operations).pipe(
          Effect.andThen(FiberSet.awaitEmpty(runtime.operations)),
        ),
      )));
      failures.push(...exitFailures(yield* Effect.exit(runtime.mutations.drain())));
      runtime.supervisorOwner.observed = true;
      const concurrent = yield* Effect.forEach([
        runtime.sessions.stopExecutors(EXECUTOR_SHUTDOWN_GRACE_MS),
        runtime.supervisorOwner.cleanup,
      ], operation => Effect.exit(operation), { concurrency: "unbounded" });
      for (const settled of concurrent) failures.push(...exitFailures(settled));
      failures.push(...exitFailures(yield* Effect.exit(runtime.sessions.drainHooks())));
      return yield* failCleanup(
        failures,
        "Workspace Runtime shutdown could not release every resource.",
      );
    });
  }

  private boundRead<T>(read: () => T): Effect.Effect<T, RuntimeReadFailure> {
    return Effect.try({
      try: read,
      catch: error => error instanceof ArtifactReadUnavailableError
        ? { type: "runtime-store-unavailable" as const, message: error.message }
        : runtimeReadFailureFromError(error),
    });
  }

  private tickLoop(heartbeatMs: number): Effect.Effect<void> {
    const runtime = this;
    return Effect.gen(function*() {
      while (!runtime.stopped) {
        yield* Effect.uninterruptible(runtime.tick());
        if (runtime.stopped) return;
        yield* Effect.sleep(heartbeatMs);
      }
    });
  }

  private heartbeatLoop(heartbeatMs: number): Effect.Effect<void> {
    const runtime = this;
    return Effect.gen(function*() {
      while (true) {
        yield* Effect.sleep(heartbeatMs);
        yield* Effect.uninterruptible(runtime.heartbeat());
      }
    });
  }

  private heartbeat(): Effect.Effect<void> {
    return Effect.sync(() => {
      if (this.stopped) return;
      try {
        if (!this.store.heartbeatRuntimeAuthority(this.authorityFence)) this.authorityLost();
      } catch (error) {
        if (!this.stopped && !isRuntimeStoreBusyError(error)) this.authorityLost();
      }
    });
  }

  private tick(): Effect.Effect<void> {
    const runtime = this;
    return Effect.suspend(() => {
      runtime.ticking = true;
      return runRuntimeTick(runtime.runtimeStore, {
        startSession: runId => runtime.sessions.start(runId).pipe(Effect.map(started => started.disposition)),
        dispatchHooks: runId => runtime.sessions.dispatchHooks(runId),
      }).pipe(
        Effect.tap(result => Effect.sync(() => {
          runtime.latestTick = { runsStarted: result.runs, idleBlockers: result.idleBlockers };
        })),
        Effect.catch(() => Effect.void),
        Effect.catchCause(() => Effect.sync(() => {
          if (!runtime.stopped) runtime.authorityLost();
        })),
        Effect.ensuring(Effect.sync(() => {
          runtime.ticking = false;
        })),
      );
    });
  }

  private authorityLost(): void {
    if (this.stopped) return;
    try {
      this.onAuthorityLost?.(this);
    } catch {}
    this.requestShutdown();
  }

  private requestShutdown(): void {
    this.stopped = true;
    Deferred.doneUnsafe(this.shutdownRequested, Effect.void);
  }
}

type ReadyWorkspaceRuntimeStore = {
  store: RuntimeStoreAdapter;
  layout: RuntimeLayout;
};

function acquireReadyWorkspaceRuntimeStore(
  cwd: string,
  options: RuntimeLayoutOptions,
  agentPresetProvider?: AgentPresetProvider,
): Effect.Effect<ReadyWorkspaceRuntimeStore, unknown, Scope.Scope> {
  return Effect.gen(function*() {
    const first = yield* inspectRuntimeStoreInternal(cwd, options);
    if (Result.isFailure(first)) {
      if (first.failure.reason === "busy") {
        return yield* acquirePublishedWorkspaceRuntimeStore(cwd, options, agentPresetProvider);
      }
      return yield* Effect.fail(openReadinessError(first.failure));
    }
    if (first.success.current.state === "absent") yield* initializeRuntimeStoreIfAbsent(cwd, options);
    else if (first.success.current.state !== "ready") {
      return yield* Effect.fail(assessmentReadinessError(first.success));
    }
    const workspace = resolveRuntimeWorkspaceLayout(cwd, options);
    return yield* acquireWorkspaceRuntimeStoreResource(
      workspace,
      Effect.gen(function*() {
        const checked = yield* inspectRuntimeStoreInternal(cwd, options);
        if (Result.isFailure(checked)) {
          if (checked.failure.reason !== "busy") return yield* Effect.fail(openReadinessError(checked.failure));
          const layout = resolveRuntimeLayout(cwd, options);
          if (layout.generationId === undefined) return yield* Effect.fail(openReadinessError(checked.failure));
          return layout;
        }
        if (checked.success.current.state !== "ready") {
          return yield* Effect.fail(assessmentReadinessError(checked.success));
        }
        return runtimeLayoutForGeneration(workspace, checked.success.current.generationId);
      }),
      agentPresetProvider,
    );
  });
}

function acquirePublishedWorkspaceRuntimeStore(
  cwd: string,
  options: RuntimeLayoutOptions,
  agentPresetProvider?: AgentPresetProvider,
): Effect.Effect<ReadyWorkspaceRuntimeStore, unknown, Scope.Scope> {
  const workspace = resolveRuntimeWorkspaceLayout(cwd, options);
  return acquireWorkspaceRuntimeStoreResource(
    workspace,
    Effect.gen(function*() {
      const layout = yield* Effect.try({
        try: () => resolveRuntimeLayout(cwd, options),
        catch: error => error,
      });
      if (layout.generationId === undefined) {
        return yield* Effect.fail(new Error("The current Runtime generation is not published."));
      }
      return layout;
    }),
    agentPresetProvider,
  );
}

function acquireWorkspaceRuntimeStoreResource(
  workspace: RuntimeLayout,
  selectLayout: Effect.Effect<RuntimeLayout, unknown>,
  agentPresetProvider?: AgentPresetProvider,
): Effect.Effect<ReadyWorkspaceRuntimeStore, unknown, Scope.Scope> {
  const acquire = Effect.gen(function*() {
    const lock = yield* Effect.tryPromise({
      try: () => openRuntimeSharedLock(workspace),
      catch: openReadinessError,
    });
    return yield* Effect.gen(function*() {
      const layout = yield* selectLayout;
      const store = yield* Effect.tryPromise({
        try: () => openRuntimeStoreAdapterAtLayout(layout, {
          lock: false,
          prevalidated: true,
          ...(agentPresetProvider === undefined ? {} : { agentPresetProvider }),
        }),
        catch: error => error,
      });
      return { store, layout, lock };
    }).pipe(Effect.onExit(exit => Exit.isFailure(exit)
      ? Effect.sync(() => lock.release())
      : Effect.void));
  });
  return Effect.acquireRelease(
    acquire,
    ({ store, lock }) => Effect.sync(() => {
      try {
        store.close();
      } finally {
        lock.release();
      }
    }),
  ).pipe(Effect.map(({ store, layout }) => ({ store, layout })));
}

function runtimeLayoutOptions(options: WorkspaceRuntimeInternalOptions): RuntimeLayoutOptions {
  return options.stateRoot === undefined ? {} : { runtimeHome: options.stateRoot };
}

function loadWorkspaceRuntimeConfiguration(): Result.Result<RuntimeConfiguration, WorkspaceRuntimeOpenFailure> {
  return Result.mapError(tryLoadRuntimeConfiguration(process.env), failure => ({
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
      || failure.type === "agent-injections-invalid"
      || failure.type === "agent-bindings-unresolved"
      || failure.type === "agent-preset-not-found"
      || failure.type === "agent-preset-catalog-invalid"
      || failure.type === "acpus-config-invalid"
      || failure.type === "acpus-config-read-failed"
      || failure.type === "agent-preset-catalog-scope-invalid"
      || failure.type === "agent-preset-provider-failed"
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

function runtimeControlStoreBusy(): RuntimeControlFailure {
  return {
    type: "runtime-control-failed",
    code: "STORE_BUSY",
    message: "Runtime store is busy. Retry the request.",
  };
}

function exitFailures(exit: Exit.Exit<unknown, unknown>): unknown[] {
  return Exit.isFailure(exit) ? [Cause.squash(exit.cause)] : [];
}

function failCleanup(failures: readonly unknown[], message: string): Effect.Effect<void> {
  if (failures.length === 0) return Effect.void;
  return Effect.die(failures.length === 1
    ? failures[0]
    : new AggregateError(failures, message));
}
