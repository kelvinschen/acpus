import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Semaphore from "effect/Semaphore";
import type * as Scope from "effect/Scope";
import type { AgentTurnEvent } from "@acpus/agent-executor";
import type {
  AgentObservationEntryCursor,
  AgentObservationFenceInput,
  AgentObservationInspectionProjection,
  AgentObservationReadError,
  AgentObservationReconciliationError,
  AgentObservationTerminal,
  AgentObservationTurnContext,
} from "../observations/log.js";
import {
  ArtifactReadUnavailableError,
  readVerifiedArtifact,
  tryResolveArtifactRef,
  type ArtifactPathError,
  type BoundRegisteredArtifact,
} from "../artifacts/access.js";
import type { ArtifactRecord } from "../artifacts/types.js";
import { isRuntimeStoreBusyError } from "../storage/database.js";
import type { RuntimeLayout } from "../runtime-layout.js";
import {
  schedulerStoreError,
  type SchedulerStoreError,
  type SchedulerStorePort,
} from "../scheduler/store-port.js";
import {
  beginRunInspectionSnapshot,
  commitRunInspectionSnapshot,
  acquireBoundRuntimeReadSessionAdapter,
  acquireRuntimeReadSessionAdapterAtLayout,
  openExistingRuntimeStoreAdapterAtLayout as openExistingRuntimeStoreAtLayoutValue,
  openExistingWritableRuntimeStoreAdapter as openExistingWritableRuntimeStoreValue,
  openRuntimeStoreAdapter as openRuntimeStoreValue,
  rollbackRunInspectionSnapshot,
  type AdmitRunFailure,
  type AdmitRunInput,
  type ControlOptions,
  type ForkRunFailure,
  type ForkRunRecord,
  type RunRecord,
  type RuntimeReadFailure,
  type RuntimeStoreAdapter,
} from "./store.js";

export type RuntimeStoreBusy = {
  type: "runtime-store-busy";
  message: string;
  cause: unknown;
};

type EffectMethod<Method> = Method extends (...args: infer Args) => Promise<Result.Result<infer Success, infer Failure>>
  ? (...args: Args) => Effect.Effect<Success, Failure | RuntimeStoreBusy>
  : Method extends (...args: infer Args) => Result.Result<infer Success, infer Failure>
    ? (...args: Args) => Effect.Effect<Success, Failure | RuntimeStoreBusy>
    : Method extends (...args: infer Args) => Promise<infer Success>
      ? (...args: Args) => Effect.Effect<Success, RuntimeStoreBusy>
      : Method extends (...args: infer Args) => infer Success
        ? (...args: Args) => Effect.Effect<Success, RuntimeStoreBusy>
        : never;

type EffectMethods<Service> = {
  readonly [Key in keyof Service]: EffectMethod<Service[Key]>;
};

type SchedulerEffectMethod<Method> = Method extends (...args: infer Args) => Result.Result<infer Success, infer Failure>
  ? (...args: Args) => Effect.Effect<Success, Failure | SchedulerStoreError | RuntimeStoreBusy>
  : Method extends (...args: infer Args) => infer Success
    ? (...args: Args) => Effect.Effect<Success, SchedulerStoreError | RuntimeStoreBusy>
    : never;

type RuntimeSchedulerStore = {
  readonly [Key in keyof SchedulerStorePort]: SchedulerEffectMethod<SchedulerStorePort[Key]>;
};

type RuntimeObservationStore = {
  captureTurn<Request, TurnResult extends AgentObservationTerminal, Failure, Requirements>(
    context: AgentObservationTurnContext,
    request: Request & Readonly<{ onEvent?: (event: AgentTurnEvent) => unknown }>,
    runTurn: (request: Request & Readonly<{ onEvent?: (event: AgentTurnEvent) => unknown }>) => Effect.Effect<TurnResult, Failure, Requirements>,
    cancelled: () => TurnResult,
  ): Effect.Effect<TurnResult, Failure | RuntimeStoreBusy, Requirements>;
  markFenced(input: AgentObservationFenceInput): Effect.Effect<void, RuntimeStoreBusy>;
  readInspectionProjection(input: {
    runId: string;
    attemptIds?: readonly string[];
    beforeEntry?: AgentObservationEntryCursor;
    entryLimit?: number;
    latestTurnPerAttempt?: true;
    includeOlderCount?: boolean;
  }): Effect.Effect<AgentObservationInspectionProjection, AgentObservationReadError | RuntimeStoreBusy>;
  reconcileInterruptedTurns(
    runId: string,
  ): Effect.Effect<void, AgentObservationReconciliationError | RuntimeStoreBusy>;
  reconcileTerminalTurns(): Effect.Effect<void, RuntimeStoreBusy>;
};

type RuntimeStoreOperations = Omit<
  RuntimeStoreAdapter,
  | "admitRun"
  | "close"
  | "forkRun"
  | "observationLog"
  | "registerArtifact"
  | "runsRoot"
  | "scheduler"
  | "writeExecutionMetadata"
>;

export type RuntimeStoreShape = EffectMethods<RuntimeStoreOperations> & {
  readonly runsRoot: string;
  readonly scheduler: RuntimeSchedulerStore;
  readonly observationLog: RuntimeObservationStore;
  admitRun(input: AdmitRunInput): Effect.Effect<RunRecord, AdmitRunFailure | RuntimeStoreBusy>;
  forkRun(runId: string, options?: ControlOptions): Effect.Effect<ForkRunRecord, ForkRunFailure | RuntimeStoreBusy>;
  registerArtifact(
    input: Parameters<RuntimeStoreAdapter["registerArtifact"]>[0],
  ): Effect.Effect<void, SchedulerStoreError | RuntimeStoreBusy>;
  writeExecutionMetadata(
    input: Parameters<RuntimeStoreAdapter["writeExecutionMetadata"]>[0],
  ): Effect.Effect<void, SchedulerStoreError | RuntimeStoreBusy>;
  resolveArtifactRef(
    value: unknown,
    runId: string,
  ): Effect.Effect<BoundRegisteredArtifact, ArtifactPathError | RuntimeStoreBusy>;
  readVerifiedArtifact(
    runId: string,
    artifactId: string,
  ): Effect.Effect<{ artifact: ArtifactRecord; bytes: Buffer } | undefined, ArtifactReadUnavailableError | RuntimeStoreBusy>;
  withRunInspectionSnapshot<Success, Failure, Requirements>(
    operation: Effect.Effect<Success, Failure, Requirements>,
  ): Effect.Effect<Success, Failure | RuntimeStoreBusy, Requirements>;
};

export class RuntimeStore extends Context.Service<RuntimeStore, RuntimeStoreShape>()(
  "acpus/runtime/RuntimeStore",
) {}

export type RuntimeReadSession = {
  readonly layout: RuntimeLayout;
  readonly store: RuntimeStoreShape;
};

export function acquireRuntimeStore(
  cwd: string,
): Effect.Effect<RuntimeStoreShape, never, Scope.Scope> {
  return acquireStore(Effect.promise(() => openRuntimeStoreValue(cwd)));
}

export function acquireExistingWritableRuntimeStore(
  cwd: string,
): Effect.Effect<RuntimeStoreShape | undefined, RuntimeStoreBusy, Scope.Scope> {
  return Effect.acquireRelease(
    Effect.tryPromise({
      try: () => openExistingWritableRuntimeStoreValue(cwd),
      catch: runtimeStoreBusy,
    }),
    store => store === undefined ? Effect.void : Effect.sync(() => store.close()),
  ).pipe(
    Effect.map(store => store === undefined ? undefined : makeRuntimeStoreService(store)),
  );
}

export function acquireExistingRuntimeStoreAtLayout(
  layout: RuntimeLayout,
  readOnly: boolean,
  options: Parameters<typeof openExistingRuntimeStoreAtLayoutValue>[2] = {},
): Effect.Effect<RuntimeStoreShape | undefined, RuntimeStoreBusy, Scope.Scope> {
  return Effect.acquireRelease(
    Effect.tryPromise({
      try: () => openExistingRuntimeStoreAtLayoutValue(layout, readOnly, options),
      catch: runtimeStoreBusy,
    }),
    store => store === undefined ? Effect.void : Effect.sync(() => store.close()),
  ).pipe(
    Effect.map(store => store === undefined ? undefined : makeRuntimeStoreService(store)),
  );
}

export function acquireBoundRuntimeReadSession(
  cwd: string,
): Effect.Effect<RuntimeReadSession | undefined, RuntimeReadFailure, Scope.Scope> {
  return acquireBoundRuntimeReadSessionAdapter(cwd).pipe(
    Effect.map(session => session === undefined
      ? undefined
      : { layout: session.layout, store: makeRuntimeStoreService(session.store) }),
  );
}

export function acquireRuntimeReadSessionAtLayout(
  layout: RuntimeLayout,
): Effect.Effect<RuntimeReadSession, RuntimeReadFailure, Scope.Scope> {
  return acquireRuntimeReadSessionAdapterAtLayout(layout).pipe(
    Effect.map(session => ({ layout: session.layout, store: makeRuntimeStoreService(session.store) })),
  );
}

export function runtimeStoreLayer(cwd: string): Layer.Layer<RuntimeStore> {
  return Layer.effect(RuntimeStore, acquireRuntimeStore(cwd));
}

function acquireStore(
  acquire: Effect.Effect<RuntimeStoreAdapter>,
): Effect.Effect<RuntimeStoreShape, never, Scope.Scope> {
  return Effect.acquireRelease(
    acquire,
    store => Effect.sync(() => store.close()),
  ).pipe(Effect.map(makeRuntimeStoreService));
}

export function makeRuntimeStoreService(store: RuntimeStoreAdapter): RuntimeStoreShape {
  const inspectionSemaphore = Semaphore.makeUnsafe(1);
  return RuntimeStore.of({
    runsRoot: store.runsRoot,
    scheduler: makeSchedulerStore(store.scheduler),
    observationLog: makeObservationStore(store),
    resolveArtifactRef: (value, runId) => result(() => tryResolveArtifactRef(value, { runId, store })),
    readVerifiedArtifact: (runId, artifactId) => Effect.try({
      try: () => readVerifiedArtifact({ runId, store }, artifactId),
      catch: artifactReadFailure,
    }),
    withRunInspectionSnapshot: operation => inspectionSemaphore.withPermit(
      sync(() => beginRunInspectionSnapshot(store)).pipe(
        Effect.flatMap(() => operation),
        Effect.onExit(exit => sync(() => {
          if (Exit.isSuccess(exit)) commitRunInspectionSnapshot(store);
          else rollbackRunInspectionSnapshot(store);
        })),
      ),
    ),
    admitRun: input => adapterEffect(store.admitRun(input)),
    lookupAdmission: requestId => sync(() => store.lookupAdmission(requestId)),
    getFrozenRun: runId => sync(() => store.getFrozenRun(runId)),
    claimRuntimeAuthority: input => result(() => store.claimRuntimeAuthority(input)),
    heartbeatRuntimeAuthority: input => sync(() => store.heartbeatRuntimeAuthority(input)),
    setRuntimeAuthorityIdleState: input => sync(() => store.setRuntimeAuthorityIdleState(input)),
    releaseRuntimeAuthority: input => sync(() => store.releaseRuntimeAuthority(input)),
    listRuntimeWork: now => sync(() => store.listRuntimeWork(now)),
    forkRun: (runId, options) => adapterEffect(store.forkRun(runId, options)),
    cleanupStagedRunDirectories: () => promise(() => store.cleanupStagedRunDirectories()),
    deleteRun: runId => promiseResult(() => store.deleteRun(runId)),
    writeHookJournal: entry => sync(() => store.writeHookJournal(entry)),
    getHookJournal: runId => sync(() => store.getHookJournal(runId)),
    pruneHookJournal: cutoff => sync(() => store.pruneHookJournal(cutoff)),
    getHookDispatchCursor: runId => sync(() => store.getHookDispatchCursor(runId)),
    compareAndSetHookDispatchCursor: (runId, expectedSequence, nextSequence) =>
      sync(() => store.compareAndSetHookDispatchCursor(runId, expectedSequence, nextSequence)),
    getLastRunEventSequence: runId => sync(() => store.getLastRunEventSequence(runId)),
    getRunEventVersion: runId => sync(() => store.getRunEventVersion(runId)),
    readHookDispatchEvents: (runId, afterSequence) => sync(() => store.readHookDispatchEvents(runId, afterSequence)),
    getCommittedRuntimeEventsAfter: (runId, sequence) => sync(() => store.getCommittedRuntimeEventsAfter(runId, sequence)),
    getInspectionTimelineEvents: (runId, nodeKeys, limit) =>
      sync(() => store.getInspectionTimelineEvents(runId, nodeKeys, limit)),
    readRunInspectionToken: runId => sync(() => store.readRunInspectionToken(runId)),
    readRunInspection: (runId, afterEventSequence) => sync(() => store.readRunInspection(runId, afterEventSequence)),
    getRunDir: runId => sync(() => store.getRunDir(runId)),
    getRunDirectoryToken: runId => sync(() => store.getRunDirectoryToken(runId)),
    registerArtifact: input => scheduler(() => store.registerArtifact(input)),
    getArtifact: (runId, artifactId) => sync(() => store.getArtifact(runId, artifactId)),
    listArtifacts: (runId, limit) => sync(() => store.listArtifacts(runId, limit)),
    writeExecutionMetadata: input => scheduler(() => store.writeExecutionMetadata(input)),
    getExecutionMetadata: runId => sync(() => store.getExecutionMetadata(runId)),
    writeNodeProgress: input => sync(() => store.writeNodeProgress(input)),
    getRun: runId => sync(() => store.getRun(runId)),
    listRuns: () => sync(() => store.listRuns()),
    getRunStoreSummary: () => sync(() => store.getRunStoreSummary()),
    listWorkflowSources: () => sync(() => store.listWorkflowSources()),
    getRuntimeDiagnostics: () => sync(() => store.getRuntimeDiagnostics()),
  });
}

function makeSchedulerStore(store: SchedulerStorePort): RuntimeSchedulerStore {
  return {
    claimRun: (runId, ownerId, leaseMs) => scheduler(() => store.claimRun(runId, ownerId, leaseMs)),
    heartbeatRun: (claim, leaseMs) => scheduler(() => store.heartbeatRun(claim, leaseMs)),
    releaseRun: claim => scheduler(() => store.releaseRun(claim)),
    tryLoadRunSnapshot: runId => scheduler(() => store.tryLoadRunSnapshot(runId)),
    tryAppendSchedulerEvents: commit => scheduler(() => store.tryAppendSchedulerEvents(commit)),
    tryStartAttempt: input => scheduler(() => store.tryStartAttempt(input)),
    listReplayCandidates: runId => scheduler(() => store.listReplayCandidates(runId)),
    tryCommitReplay: input => scheduler(() => store.tryCommitReplay(input)),
    tryCommitAttemptResult: input => scheduler(() => store.tryCommitAttemptResult(input)),
    tryConsumeSignal: input => scheduler(() => store.tryConsumeSignal(input)),
    tryPauseRun: input => scheduler(() => store.tryPauseRun(input)),
    tryResumeRun: input => scheduler(() => store.tryResumeRun(input)),
    tryPlanRetry: input => scheduler(() => store.tryPlanRetry(input)),
    tryCommitRetry: input => scheduler(() => store.tryCommitRetry(input)),
    tryCancel: input => scheduler(() => store.tryCancel(input)),
    tryPlanAgentSteer: (runId, target) => scheduler(() => store.tryPlanAgentSteer(runId, target)),
    trySteerAgent: input => scheduler(() => store.trySteerAgent(input)),
    planAgentAttemptAdmission: input => schedulerResult(() => store.planAgentAttemptAdmission(input)),
    tryBindAgentAttemptSession: input => scheduler(() => store.tryBindAgentAttemptSession(input)),
    tryRecordAgentSessionReady: input => scheduler(() => store.tryRecordAgentSessionReady(input)),
    tryAdvanceAgentSessionCheckpoint: input => scheduler(() => store.tryAdvanceAgentSessionCheckpoint(input)),
    tryCommitAgentTurnDispatch: input => scheduler(() => store.tryCommitAgentTurnDispatch(input)),
    trySettleFencedAgentSessionCheckpoint: input => scheduler(() => store.trySettleFencedAgentSessionCheckpoint(input)),
    tryReconcileAgentSteers: input => scheduler(() => store.tryReconcileAgentSteers(input)),
    readAgentControlInspection: runId => scheduler(() => store.readAgentControlInspection(runId)),
    tryMarkExpiredOwnerAttemptsSuperseded: input => scheduler(() => store.tryMarkExpiredOwnerAttemptsSuperseded(input)),
  };
}

function makeObservationStore(store: RuntimeStoreAdapter): RuntimeObservationStore {
  return {
    captureTurn: (context, request, runTurn, cancelled) =>
      store.observationLog.captureTurn(context, request, runTurn, cancelled).pipe(
        Effect.catchDefect(defect => isRuntimeStoreBusyError(defect)
          ? Effect.fail(runtimeStoreBusy(defect))
          : Effect.die(defect)),
      ),
    markFenced: input => adapterEffect(store.observationLog.markFenced(input)),
    readInspectionProjection: input => adapterEffect(store.observationLog.readInspectionProjection(input)),
    reconcileInterruptedTurns: runId => adapterEffect(store.observationLog.reconcileInterruptedTurns(runId)),
    reconcileTerminalTurns: () => adapterEffect(store.observationLog.reconcileTerminalTurns()),
  };
}

function sync<Success>(operation: () => Success): Effect.Effect<Success, RuntimeStoreBusy> {
  return Effect.try({ try: operation, catch: runtimeStoreBusy });
}

function result<Success, Failure>(
  operation: () => Result.Result<Success, Failure>,
): Effect.Effect<Success, Failure | RuntimeStoreBusy> {
  return sync(operation).pipe(Effect.flatMap(Effect.fromResult));
}

function scheduler<Success>(
  operation: () => Success,
): Effect.Effect<Success, SchedulerStoreError | RuntimeStoreBusy> {
  return Effect.try({ try: operation, catch: schedulerFailure });
}

function schedulerResult<Success, Failure>(
  operation: () => Result.Result<Success, Failure>,
): Effect.Effect<Success, Failure | SchedulerStoreError | RuntimeStoreBusy> {
  return scheduler(operation).pipe(Effect.flatMap(Effect.fromResult));
}

function promise<Success>(operation: () => Promise<Success>): Effect.Effect<Success, RuntimeStoreBusy> {
  return Effect.tryPromise({ try: operation, catch: runtimeStoreBusy });
}

function promiseResult<Success, Failure>(
  operation: () => Promise<Result.Result<Success, Failure>>,
): Effect.Effect<Success, Failure | RuntimeStoreBusy> {
  return promise(operation).pipe(Effect.flatMap(Effect.fromResult));
}

function adapterEffect<Success, Failure, Requirements>(
  effect: Effect.Effect<Success, Failure, Requirements>,
): Effect.Effect<Success, Failure | RuntimeStoreBusy, Requirements> {
  return effect.pipe(Effect.catchDefect(defect => isRuntimeStoreBusyError(defect)
    ? Effect.fail(runtimeStoreBusy(defect))
    : Effect.die(defect)));
}

function runtimeStoreBusy(error: unknown): RuntimeStoreBusy {
  if (!isRuntimeStoreBusyError(error)) throw error;
  return {
    type: "runtime-store-busy",
    message: error instanceof Error ? error.message : "Runtime store is busy.",
    cause: error,
  };
}

function schedulerFailure(error: unknown): SchedulerStoreError | RuntimeStoreBusy {
  const failure = schedulerStoreError(error);
  return failure ?? runtimeStoreBusy(error);
}

function artifactReadFailure(error: unknown): ArtifactReadUnavailableError | RuntimeStoreBusy {
  if (error instanceof ArtifactReadUnavailableError) return error;
  return runtimeStoreBusy(error);
}
