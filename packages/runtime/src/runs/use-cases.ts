import type { JsonValue } from "@acpus/expression/ir";
import type { AdmittedWorkflowIR } from "@acpus/core/ir";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { tryNormalizeWorkflowInput, type SchemaNormalizationFailure } from "../admission/input.js";
import type { PreparedRunWorkflow } from "../admission/prepared-workflow.js";
import { ArtifactReadUnavailableError } from "../artifacts/access.js";
import { parseArtifactUri } from "../artifacts/reference.js";
import type { ArtifactRecord } from "../artifacts/types.js";
import { probeProcessIdentity } from "../process-liveness.js";
import {
  canCancelRun,
  planRetryControl,
  retryControlTargets,
  settleRetryControlSnapshot,
  type RuntimeControlTarget,
} from "../scheduler/control-plan.js";
import { planRetrySessionImpact } from "../scheduler/retry-session-impact.js";
import { createWorkflowVisualizationOverlay, type WorkflowVisualizationOverlay } from "../visualization/overlay.js";
import { resolveRuntimeLayout, resolveRuntimeWorkspaceLayout } from "../runtime-layout.js";
import { inspectRuntimeStoreInternal } from "../runtime-store-lifecycle.js";
import { inspectAcpOwnership } from "@acpus/agent-executor";
import { makeNodeProcessHost } from "@acpus/owned-process";
import {
  type RuntimeDiagnostics,
  type RuntimeAuthorityDiagnostics,
  type RunDetails,
  type RunDeleteFailure, type RunRecord,
  type RuntimeReadFailure,
} from "../store/store.js";
import {
  acquireBoundRuntimeReadSession,
  acquireExistingWritableRuntimeStore,
  type RuntimeStoreBusy,
  type RuntimeStoreShape,
} from "../store/service.js";
export type { RunDeleteFailure } from "../store/store.js";

export type RunVisualizationControlTarget = RuntimeControlTarget;

export type RunVisualizationControls = {
  canCancelRun: boolean;
  retryTargets: RunVisualizationControlTarget[];
};

export type RunVisualizationWorkflow = Pick<AdmittedWorkflowIR, "name" | "description" | "agents">;

export type RunVisualizationSnapshot = {
  run: RunDetails;
  workflow: RunVisualizationWorkflow;
  overlay: WorkflowVisualizationOverlay;
  controls: RunVisualizationControls;
};

type RuntimeHealthStatus = "ok" | "warn" | "fail";

export type RuntimeHealthCheck = {
  area: "workspace" | "store" | "daemon" | "runs" | "idle-stop" | "acp";
  status: RuntimeHealthStatus;
  message: string;
  details?: Record<string, JsonValue>;
};

export type RuntimePersistence = {
  path: string;
};

type RuntimeHealthReportBase = {
  ok: boolean;
  phase: "doctor";
  checks: RuntimeHealthCheck[];
};

export type RuntimeHealthReport = RuntimeHealthReportBase & (
  | { state: "not-initialized"; persistence: RuntimePersistence }
  | { state: "ready"; persistence: RuntimePersistence }
  | { state: "unreadable"; persistence?: RuntimePersistence }
);

export type ForkInputNormalizationFailure =
  | { type: "run-not-found"; runId: string; message: string }
  | SchemaNormalizationFailure;

export type ArtifactResolutionFailure =
  | { type: "invalid-artifact-ref"; message: string }
  | { type: "artifact-not-found"; runId: string; artifactId: string; message: string }
  | { type: "artifact-path-invalid"; runId: string; artifactId: string; message: string };

export type ResolvedArtifact = ArtifactRecord & {
  uri: string;
};

function withBoundRuntimeRead<T>(
  cwd: string,
  absent: T,
  read: (store: RuntimeStoreShape) => Effect.Effect<T, RuntimeStoreBusy>,
): Effect.Effect<T, RuntimeReadFailure> {
  return Effect.scoped(Effect.gen(function* () {
    const session = yield* acquireBoundRuntimeReadSession(cwd);
    if (!session) return absent;
    return yield* read(session.store).pipe(Effect.mapError(runtimeReadBusyFailure));
  }));
}

export function listRuns(cwd: string): Effect.Effect<RunRecord[], RuntimeReadFailure> {
  return withBoundRuntimeRead(cwd, [] as RunRecord[], store => store.listRuns());
}

export function getRun(cwd: string, runId: string): Effect.Effect<RunDetails | undefined, RuntimeReadFailure> {
  return withBoundRuntimeRead(cwd, undefined, store => store.getRun(runId));
}

export function deleteRun(cwd: string, runId: string): Effect.Effect<RunRecord | undefined, RunDeleteFailure> {
  return Effect.scoped(Effect.gen(function* () {
    const store = yield* acquireExistingWritableRuntimeStore(cwd).pipe(
      Effect.catch(failure => Effect.die(failure.cause)),
    );
    if (!store) return undefined;
    return yield* store.deleteRun(runId).pipe(
      Effect.catchIf(
        (failure): failure is RuntimeStoreBusy => isRuntimeStoreBusy(failure),
        failure => Effect.die(failure.cause),
      ),
    );
  }));
}

export function getArtifact(
  cwd: string,
  runId: string,
  artifactId: string,
): Effect.Effect<ArtifactRecord | undefined, RuntimeReadFailure> {
  return withBoundRuntimeRead(cwd, undefined, store => store.getArtifact(runId, artifactId));
}

export function resolveArtifact(
  cwd: string,
  artifactRef: string,
): Effect.Effect<ResolvedArtifact, ArtifactResolutionFailure | RuntimeReadFailure> {
  return Effect.scoped(Effect.gen(function* () {
    const parsed = yield* Effect.fromResult(parseArtifactUri(artifactRef));
    const session = yield* acquireBoundRuntimeReadSession(cwd);
    if (!session) return yield* Effect.fail(artifactNotFound(artifactRef, parsed));
    const resolved = yield* Effect.result(session.store.resolveArtifactRef(
      { kind: "artifact", uri: artifactRef },
      parsed.runId,
    ));
    if (Result.isFailure(resolved)) {
      if (isRuntimeStoreBusy(resolved.failure)) {
        return yield* Effect.fail(runtimeReadBusyFailure(resolved.failure));
      }
      if (resolved.failure.type === "artifact-run-mismatch") {
        return yield* Effect.fail(runtimeReadUnavailable(resolved.failure.message));
      }
      return yield* Effect.fail(resolved.failure);
    }
    return { ...resolved.success.artifact, uri: artifactRef };
  }));
}

export function readArtifact(
  cwd: string,
  runId: string,
  artifactId: string,
): Effect.Effect<{ artifact: ArtifactRecord; bytes: Buffer } | undefined, RuntimeReadFailure> {
  return Effect.scoped(Effect.gen(function* () {
    const session = yield* acquireBoundRuntimeReadSession(cwd);
    if (!session) return undefined;
    return yield* session.store.readVerifiedArtifact(runId, artifactId).pipe(
      Effect.mapError(error => error instanceof ArtifactReadUnavailableError
        ? runtimeReadUnavailable(error.message)
        : runtimeReadBusyFailure(error)),
    );
  }));
}

export function listArtifacts(cwd: string, runId: string): Effect.Effect<ArtifactRecord[] | undefined, RuntimeReadFailure> {
  return withBoundRuntimeRead(cwd, undefined, store => Effect.gen(function* () {
    if (!(yield* store.getRun(runId))) return undefined;
    return yield* store.listArtifacts(runId);
  }));
}

export function getRunVisualizationSnapshot(
  cwd: string,
  runId: string,
): Effect.Effect<RunVisualizationSnapshot | undefined, RuntimeReadFailure> {
  return withBoundRuntimeRead(cwd, undefined, store =>
    store.withRunInspectionSnapshot(Effect.gen(function* () {
      const run = yield* store.getRun(runId);
      if (!run) return undefined;
      const frozen = yield* store.getFrozenRun(runId);
      if (!frozen) throw new Error(`Run '${runId}' has no frozen workflow.`);
      const scheduler = yield* store.scheduler.tryLoadRunSnapshot(runId).pipe(schedulerFailureAsDefect);
      const retryScheduler = settleRetryControlSnapshot({
        frozen,
        snapshot: scheduler,
        now: new Date(),
      }).snapshot;
      const retryTargets = retryControlTargets(retryScheduler).filter(target => {
        const retry = planRetryControl(retryScheduler, target.target);
        return Result.isSuccess(retry) && Result.isSuccess(planRetrySessionImpact({
          frozen,
          snapshot: retryScheduler,
          reexecutedNodeKeys: retry.success.reexecutedNodeKeys,
        }));
      });
      return {
        run,
        workflow: {
          name: frozen.ir.name,
          ...(frozen.ir.description === undefined ? {} : { description: frozen.ir.description }),
          agents: frozen.ir.agents,
        },
        overlay: createWorkflowVisualizationOverlay(frozen.ir, run.dynamic, { runId, status: run.status }),
        controls: {
          canCancelRun: canCancelRun(scheduler),
          retryTargets,
        },
      };
    })),
  );
}

export function tryNormalizeForkInput(
  cwd: string,
  runId: string,
  input: JsonValue | undefined,
  prepared?: PreparedRunWorkflow,
): Effect.Effect<JsonValue | undefined, ForkInputNormalizationFailure | RuntimeReadFailure> {
  return Effect.scoped(Effect.gen(function* () {
    const session = yield* acquireBoundRuntimeReadSession(cwd);
    if (!session) return yield* Effect.fail(runNotFound(runId));
    const frozen = yield* session.store.getFrozenRun(runId).pipe(Effect.mapError(runtimeReadBusyFailure));
    if (!frozen) return yield* Effect.fail(runNotFound(runId));
    const normalized = input !== undefined
      ? tryNormalizeWorkflowInput(prepared?.ir ?? frozen.ir, input, "Fork input")
      : prepared ? tryNormalizeWorkflowInput(prepared.ir, frozen.input, "Fork input") : Result.succeed(undefined);
    return yield* Effect.fromResult(normalized);
  }));
}

function runtimeReadBusyFailure(failure: RuntimeStoreBusy): RuntimeReadFailure {
  return runtimeReadUnavailable(failure.message);
}

function runtimeReadUnavailable(message: string): RuntimeReadFailure {
  return { type: "runtime-store-unavailable", message };
}

function isRuntimeStoreBusy(failure: unknown): failure is RuntimeStoreBusy {
  return typeof failure === "object" && failure !== null
    && "type" in failure && failure.type === "runtime-store-busy";
}

function schedulerFailureAsDefect<Success, Failure, Requirements>(
  effect: Effect.Effect<Success, Failure | RuntimeStoreBusy, Requirements>,
): Effect.Effect<Success, RuntimeStoreBusy, Requirements> {
  return effect.pipe(Effect.catchIf(
    (failure): failure is Failure => !isRuntimeStoreBusy(failure),
    failure => Effect.die(failure),
  ));
}

export function getRuntimeHealth(cwd: string): Effect.Effect<RuntimeHealthReport> {
  return Effect.gen(function* () {
    const resolvedPersistence = yield* Effect.result(Effect.try({
      try: () => ({ path: resolveRuntimeWorkspaceLayout(cwd).workspaceRoot }),
      catch: errorMessage,
    }));
    if (Result.isFailure(resolvedPersistence)) {
      return {
        ok: false,
        phase: "doctor",
        state: "unreadable",
        checks: [{
          area: "store",
          status: "fail",
          message: resolvedPersistence.failure,
        }],
      } satisfies RuntimeHealthReport;
    }
    const persistence = resolvedPersistence.success;
    const inspected = yield* inspectRuntimeStoreInternal(cwd);
    if (Result.isFailure(inspected)) {
      return lifecycleHealthFailure(persistence, inspected.failure.message);
    }
    const current = inspected.success.current;
    if (current.state !== "absent" && current.state !== "ready" && current.state !== "unsupported") {
      return {
        ok: true,
        phase: "doctor",
        state: "unreadable",
        persistence,
        checks: [{
          area: "store",
          status: "warn",
          message: "The Runtime store needs repair for this version of Acpus. Run 'acpus doctor --fix'.",
        }],
      } satisfies RuntimeHealthReport;
    }
    if (current.state === "unsupported") {
      return lifecycleHealthFailure(persistence, current.detail);
    }

    return yield* readRuntimeHealth(cwd, persistence);
  });
}

function readRuntimeHealth(
  cwd: string,
  persistence: RuntimePersistence,
): Effect.Effect<RuntimeHealthReport> {
  return Effect.scoped(Effect.gen(function* () {
    const session = yield* acquireBoundRuntimeReadSession(cwd);
    if (!session) {
      const acp = yield* acpOwnershipCheck(cwd);
      return {
        ok: true,
        phase: "doctor",
        state: "not-initialized",
        persistence,
        checks: [
          {
            area: "workspace",
            status: "ok",
            message: "Runtime store is not initialized.",
            details: { cwd },
          },
          ...(acp === undefined ? [] : [acp]),
        ],
      } satisfies RuntimeHealthReport;
    }
    const diagnostics = yield* session.store.getRuntimeDiagnostics();
    const checks: RuntimeHealthCheck[] = [
      { area: "workspace", status: "ok", message: "Workspace resolved.", details: { cwd } },
      { area: "store", status: "ok", message: "Runtime store opened read-only." },
      runtimeAuthorityCheck(diagnostics.authority),
      {
        area: "runs",
        status: "ok",
        message: `${diagnostics.runs.total} runs, ${diagnostics.runs.runnable} runnable.`,
        details: diagnostics.runs as unknown as Record<string, JsonValue>,
      },
      idleStopCheck(diagnostics),
    ];
    if (diagnostics.leases.stale > 0) {
      checks.push({
        area: "runs",
        status: "warn",
        message: `${diagnostics.leases.stale} stale run leases found.`,
        details: { staleRunLeases: diagnostics.leases.stale },
      });
    }
    const acp = yield* acpOwnershipCheck(cwd, diagnostics.authority);
    if (acp) checks.push(acp);
    return {
      ok: checks.every(check => check.status !== "fail"),
      phase: "doctor",
      state: "ready",
      persistence,
      checks,
    } satisfies RuntimeHealthReport;
  })).pipe(
    Effect.catch(failure => Effect.succeed(lifecycleHealthFailure(persistence, failure.message))),
    Effect.catchDefect(defect => Effect.succeed(lifecycleHealthFailure(persistence, errorMessage(defect)))),
  );
}

function lifecycleHealthFailure(persistence: RuntimePersistence, message: string): RuntimeHealthReport {
  return {
    ok: false,
    phase: "doctor",
    state: "unreadable",
    persistence,
    checks: [{ area: "store", status: "fail", message }],
  };
}

function acpOwnershipCheck(
  cwd: string,
  authority?: RuntimeAuthorityDiagnostics,
): Effect.Effect<RuntimeHealthCheck | undefined> {
  return inspectAcpOwnership({
      workersRoot: resolveRuntimeLayout(cwd).acpWorkersRoot,
      ...(authority?.pid === undefined ? {} : {
        owner: {
          epoch: authority.epoch,
          pid: authority.pid,
          ...(authority.processStartToken === undefined ? {} : { startToken: authority.processStartToken }),
        },
      }),
    }, makeNodeProcessHost()).pipe(
    Effect.map(ownership => {
    if (ownership.degraded === 0 && ownership.orphaned === 0) return undefined;
    return {
      area: "acp",
      status: "warn",
      message: `ACP ownership warning: degraded=${ownership.degraded} orphaned=${ownership.orphaned}`,
      details: {
        degraded: ownership.degraded,
        orphaned: ownership.orphaned,
        manifests: ownership.manifests as unknown as JsonValue,
      },
    } satisfies RuntimeHealthCheck;
    }),
    Effect.catchDefect(() => Effect.succeed(undefined)),
  );
}

function runNotFound(runId: string): Extract<ForkInputNormalizationFailure, { type: "run-not-found" }> {
  return { type: "run-not-found", runId, message: `Run '${runId}' was not found.` };
}

function artifactNotFound(
  uri: string,
  identity: { runId: string; artifactId: string },
): Extract<ArtifactResolutionFailure, { type: "artifact-not-found" }> {
  return {
    type: "artifact-not-found",
    ...identity,
    message: `Artifact '${uri}' is not registered in run '${identity.runId}'.`,
  };
}

function runtimeAuthorityCheck(authority: RuntimeAuthorityDiagnostics | undefined): RuntimeHealthCheck {
  if (!authority) return { area: "daemon", status: "ok", message: "No Runtime authority is present." };
  const heartbeatAgeMs = authority.heartbeatAt ? Date.now() - Date.parse(authority.heartbeatAt) : undefined;
  const idleAgeMs = authority.idleSinceAt ? Date.now() - Date.parse(authority.idleSinceAt) : undefined;
  const processLiveness = authority.pid === undefined
    ? undefined
    : probeProcessIdentity({
      pid: authority.pid,
      ...(authority.processStartToken === undefined ? {} : { startToken: authority.processStartToken }),
    });
  const processAlive = processLiveness === undefined || processLiveness === "unknown" ? undefined : processLiveness === "alive";
  const stale = heartbeatAgeMs !== undefined && heartbeatAgeMs > 30_000;
  return {
    area: "daemon",
    status: stale || processAlive === false ? "warn" : "ok",
    message: stale ? "Runtime authority heartbeat is stale." : processAlive === false ? "Runtime authority pid is not alive." : idleAgeMs === undefined ? "Runtime authority is fresh." : "Runtime authority is fresh and idle.",
    details: {
      epoch: authority.epoch,
      ...(authority.pid === undefined ? {} : { pid: authority.pid }),
      ...(heartbeatAgeMs === undefined ? {} : { heartbeatAgeMs }),
      ...(authority.idleSinceAt === undefined ? {} : { idleSinceAt: authority.idleSinceAt }),
      ...(idleAgeMs === undefined ? {} : { idleAgeMs }),
      ...(authority.idleStopMs === undefined ? {} : { idleStopMs: authority.idleStopMs }),
      ...(processAlive === undefined ? {} : { processAlive }),
      ...(authority.packageVersion === undefined ? {} : { packageVersion: authority.packageVersion }),
      ...(authority.nodeVersion === undefined ? {} : { nodeVersion: authority.nodeVersion }),
      ...(authority.execPath === undefined ? {} : { execPath: authority.execPath }),
    },
  };
}

function idleStopCheck(diagnostics: RuntimeDiagnostics): RuntimeHealthCheck {
  const { runnable: runnableRuns } = diagnostics.runs;
  const idleSinceAt = diagnostics.authority?.idleSinceAt;
  const idleAgeMs = idleSinceAt ? Date.now() - Date.parse(idleSinceAt) : undefined;
  const blockers = [
    runnableRuns > 0 ? "runnable runs" : undefined,
  ].filter((blocker): blocker is string => blocker !== undefined);
  return {
    area: "idle-stop",
    status: "ok",
    message: blockers.length === 0 ? "No idle-stop blockers." : `Idle-stop blocked by ${blockers.join(", ")}.`,
    details: {
      runnableRuns,
      ...(idleSinceAt === undefined ? {} : { idleSinceAt }),
      ...(idleAgeMs === undefined ? {} : { idleAgeMs }),
      ...(diagnostics.authority?.idleStopMs === undefined ? {} : { idleStopMs: diagnostics.authority.idleStopMs }),
    },
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
