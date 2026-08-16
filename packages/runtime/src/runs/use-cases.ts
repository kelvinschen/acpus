import type { JsonValue } from "@acpus/expression/ir";
import type { WorkflowIR } from "@acpus/core/ir";
import { err, ok, ResultAsync } from "neverthrow";
import { tryNormalizeWorkflowInput, type SchemaNormalizationFailure } from "../admission/input.js";
import type { PreparedRunWorkflow } from "../admission/prepared-workflow.js";
import {
  ArtifactReadUnavailableError,
  readVerifiedArtifact,
  tryResolveArtifactRef,
} from "../artifacts/access.js";
import { parseArtifactUri } from "../artifacts/reference.js";
import type { ArtifactRecord } from "../artifacts/types.js";
import { probeProcessIdentity } from "../process-liveness.js";
import {
  canCancelRun,
  retryControlTargets,
  settleRetryControlSnapshot,
  type RuntimeControlTarget,
} from "../scheduler/control-plan.js";
import { throwSchedulerStoreResult } from "../scheduler/store-port.js";
import { createWorkflowVisualizationOverlay, type WorkflowVisualizationOverlay } from "../visualization/overlay.js";
import { resolveRuntimeLayout, resolveRuntimeWorkspaceLayout } from "../runtime-layout.js";
import { inspectRuntimeStore } from "../runtime-store-lifecycle.js";
import { inspectAcpOwnership } from "@acpus/agent-executor";
import {
  openBoundRuntimeReadSession,
  openExistingRuntimeStore,
  openExistingWritableRuntimeStore,
  runtimeReadFailureFromError,
  withRunInspectionSnapshot,
  type RuntimeDiagnostics,
  type RuntimeAuthorityDiagnostics,
  type RunDetails,
  type RunDeleteFailure, type RunRecord,
  type RuntimeReadFailure,
  type RuntimeStore,
} from "../store/store.js";
export type { RunDeleteFailure } from "../store/store.js";

export type RunVisualizationControlTarget = RuntimeControlTarget;

export type RunVisualizationControls = {
  canCancelRun: boolean;
  retryTargets: RunVisualizationControlTarget[];
};

export type RunVisualizationWorkflow = Pick<WorkflowIR, "name" | "description" | "agents">;

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
  read: (store: RuntimeStore) => T | Promise<T>,
): ResultAsync<T, RuntimeReadFailure> {
  return new ResultAsync((async () => {
    const session = await openBoundRuntimeReadSession(cwd);
    if (session.isErr()) return err(session.error);
    if (!session.value) return ok(absent);
    try {
      return ok(await read(session.value.store));
    } catch (error) {
      return err(runtimeReadFailureFromError(error));
    } finally {
      session.value.close();
    }
  })());
}

export function listRuns(cwd: string): ResultAsync<RunRecord[], RuntimeReadFailure> {
  return withBoundRuntimeRead(cwd, [] as RunRecord[], store => store.listRuns());
}

export function getRun(cwd: string, runId: string): ResultAsync<RunDetails | undefined, RuntimeReadFailure> {
  return withBoundRuntimeRead(cwd, undefined, store => store.getRun(runId));
}

export function deleteRun(cwd: string, runId: string): ResultAsync<RunRecord | undefined, RunDeleteFailure> {
  return new ResultAsync((async () => {
    const store = await openExistingWritableRuntimeStore(cwd);
    if (!store) return ok(undefined);
    try {
      return await store.deleteRun(runId);
    } finally {
      store.close();
    }
  })());
}

export function getArtifact(
  cwd: string,
  runId: string,
  artifactId: string,
): ResultAsync<ArtifactRecord | undefined, RuntimeReadFailure> {
  return withBoundRuntimeRead(cwd, undefined, store => store.getArtifact(runId, artifactId));
}

export function resolveArtifact(
  cwd: string,
  artifactRef: string,
): ResultAsync<ResolvedArtifact, ArtifactResolutionFailure | RuntimeReadFailure> {
  return new ResultAsync((async () => {
    const parsed = parseArtifactUri(artifactRef);
    if (parsed.isErr()) return err(parsed.error);
    const session = await openBoundRuntimeReadSession(cwd);
    if (session.isErr()) return err(session.error);
    if (!session.value) return err(artifactNotFound(artifactRef, parsed.value));
    try {
      const resolved = tryResolveArtifactRef(
        { kind: "artifact", uri: artifactRef },
        { runId: parsed.value.runId, store: session.value.store },
      );
      if (resolved.isErr()) {
        if (resolved.error.type === "artifact-run-mismatch") throw new Error(resolved.error.message);
        return err(resolved.error);
      }
      return ok({ ...resolved.value.artifact, uri: artifactRef });
    } catch (error) {
      return err(runtimeReadFailureFromError(error));
    } finally {
      session.value.close();
    }
  })());
}

export function readArtifact(
  cwd: string,
  runId: string,
  artifactId: string,
): ResultAsync<{ artifact: ArtifactRecord; bytes: Buffer } | undefined, RuntimeReadFailure> {
  return new ResultAsync((async () => {
    const session = await openBoundRuntimeReadSession(cwd);
    if (session.isErr()) return err(session.error);
    if (!session.value) return ok(undefined);
    try {
      return ok(readVerifiedArtifact({ runId, store: session.value.store }, artifactId));
    } catch (error) {
      if (error instanceof ArtifactReadUnavailableError) {
        return err({ type: "runtime-store-unavailable", message: error.message });
      }
      return err(runtimeReadFailureFromError(error));
    } finally {
      session.value.close();
    }
  })());
}

export function listArtifacts(cwd: string, runId: string): ResultAsync<ArtifactRecord[] | undefined, RuntimeReadFailure> {
  return withBoundRuntimeRead(cwd, undefined, store => {
    if (!store.getRun(runId)) return undefined;
    return store.listArtifacts(runId);
  });
}

export function getRunVisualizationSnapshot(
  cwd: string,
  runId: string,
): ResultAsync<RunVisualizationSnapshot | undefined, RuntimeReadFailure> {
  return withBoundRuntimeRead(cwd, undefined, async store => {
    return await withRunInspectionSnapshot(store, async () => {
      const run = store.getRun(runId);
      if (!run) return undefined;
      const frozen = store.getFrozenRun(runId);
      if (!frozen) throw new Error(`Run '${runId}' has no frozen workflow.`);
      const scheduler = throwSchedulerStoreResult(store.scheduler.tryLoadRunSnapshot(runId));
      const retryScheduler = settleRetryControlSnapshot({
        frozen,
        snapshot: scheduler,
        now: new Date(),
      }).snapshot;
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
          retryTargets: retryControlTargets(retryScheduler),
        },
      };
    });
  });
}

export function tryNormalizeForkInput(
  cwd: string,
  runId: string,
  input: JsonValue | undefined,
  prepared?: PreparedRunWorkflow,
): ResultAsync<JsonValue | undefined, ForkInputNormalizationFailure | RuntimeReadFailure> {
  return new ResultAsync((async () => {
    const session = await openBoundRuntimeReadSession(cwd);
    if (session.isErr()) return err(session.error);
    if (!session.value) return err(runNotFound(runId));
    try {
      const frozen = session.value.store.getFrozenRun(runId);
      if (!frozen) return err(runNotFound(runId));
      if (input !== undefined) return tryNormalizeWorkflowInput(prepared?.ir ?? frozen.ir, input, "Fork input");
      return prepared ? tryNormalizeWorkflowInput(prepared.ir, frozen.input, "Fork input") : ok(undefined);
    } catch (error) {
      return err(runtimeReadFailureFromError(error));
    } finally {
      session.value.close();
    }
  })());
}

export async function getRuntimeHealth(cwd: string): Promise<RuntimeHealthReport> {
  let persistence: RuntimePersistence;
  try {
    persistence = { path: resolveRuntimeWorkspaceLayout(cwd).workspaceRoot };
  } catch (error) {
    return {
      ok: false,
      phase: "doctor",
      state: "unreadable",
      checks: [{
        area: "store",
        status: "fail",
        message: error instanceof Error ? error.message : String(error),
      }],
    };
  }

  const status = await inspectRuntimeStore(cwd);
  if (status.isErr()) {
    return lifecycleHealthFailure(persistence, status.error.message);
  }
  if (status.value.state === "repairable") {
    return {
      ok: true,
      phase: "doctor",
      state: "unreadable",
      persistence,
      checks: [{
        area: "store",
        status: "warn",
        message: `${status.value.message} Run 'acpus doctor --fix'.`,
      }],
    };
  }
  if (status.value.state === "unsupported") {
    return lifecycleHealthFailure(persistence, status.value.message);
  }

  let store: Awaited<ReturnType<typeof openExistingRuntimeStore>>;
  try {
    store = await openExistingRuntimeStore(cwd);
  } catch (error) {
    return lifecycleHealthFailure(persistence, error instanceof Error ? error.message : String(error));
  }
  if (!store) {
    const acp = await acpOwnershipCheck(cwd);
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
    };
  }
  try {
    const diagnostics = store.getRuntimeDiagnostics();
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
    const acp = await acpOwnershipCheck(cwd, diagnostics.authority);
    if (acp) checks.push(acp);
    return {
      ok: checks.every(check => check.status !== "fail"),
      phase: "doctor",
      state: "ready",
      persistence,
      checks,
    };
  } catch (error) {
    return {
      ok: false,
      phase: "doctor",
      state: "unreadable",
      persistence,
      checks: [{
        area: "store",
        status: "fail",
        message: error instanceof Error ? error.message : String(error),
      }],
    };
  } finally {
    store.close();
  }
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

async function acpOwnershipCheck(cwd: string, authority?: RuntimeAuthorityDiagnostics): Promise<RuntimeHealthCheck | undefined> {
  try {
    const ownership = await inspectAcpOwnership({
      workersRoot: resolveRuntimeLayout(cwd).acpWorkersRoot,
      ...(authority === undefined ? {} : {
        owner: {
          generation: authority.epoch,
          ...(authority.pid === undefined ? {} : { pid: authority.pid }),
          ...(authority.processStartToken === undefined ? {} : { startToken: authority.processStartToken }),
        },
      }),
    });
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
    };
  } catch {
    return undefined;
  }
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
