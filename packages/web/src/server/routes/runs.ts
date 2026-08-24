import { basename } from "node:path";
import type { Hono } from "hono";
import {
  getRunVisualizationSnapshot,
  listRuns,
} from "@acpus/runtime";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import type {
  RunDetails,
  RunRecord,
  RunRuntimeSnapshot,
  WorkspaceCatalog,
  WorkspaceSummary,
} from "../../api-types.js";
import { apiError, runtimeReadError } from "../errors.js";
import { graphFromOverlay } from "../graph.js";
import type { WebWorkspaceContext } from "../workspace-context.js";

export function registerRunRoutes(app: Hono, workspaces: WebWorkspaceContext): void {
  app.get("/api/workspaces", async (context) => {
    const listing = await workspaces.list();
    const catalog = {
      currentWorkspaceKey: listing.currentWorkspaceKey,
      workspaces: listing.workspaces.map(workspace => ({
        key: workspace.workspaceKey,
        name: basename(workspace.canonicalPath) || workspace.canonicalPath,
        path: workspace.canonicalPath,
        ...(workspace.runCount === undefined ? {} : { runCount: workspace.runCount }),
        ...(workspace.lastRunUpdatedAt === undefined
          ? {}
          : { lastRunUpdatedAt: workspace.lastRunUpdatedAt }),
      }) satisfies WorkspaceSummary),
    } satisfies WorkspaceCatalog;
    return context.json({ ok: true, catalog });
  });

  app.get("/api/workspaces/:workspaceKey/runs", async (context) => {
    const workspace = await workspaces.resolve(context.req.param("workspaceKey"));
    const read = await Effect.runPromise(Effect.result(listRuns(workspace.canonicalPath)));
    if (Result.isFailure(read)) runtimeReadError(read.failure);
    const runs = read.success;
    return context.json({
      ok: true,
      runs: runs.map(({ id, name, status, createdAt, updatedAt }) => ({
        id,
        name,
        status,
        createdAt,
        updatedAt,
      }) satisfies RunRecord),
    });
  });

  app.get("/api/workspaces/:workspaceKey/runs/:id/runtime-snapshot", async (context) => {
    const workspace = await workspaces.resolve(context.req.param("workspaceKey"));
    const runId = context.req.param("id");
    const read = await Effect.runPromise(Effect.result(
      getRunVisualizationSnapshot(workspace.canonicalPath, runId),
    ));
    if (Result.isFailure(read)) runtimeReadError(read.failure);
    const snapshot = read.success;
    if (!snapshot) apiError(404, "run_not_found", `Run '${runId}' was not found.`);
    const run = {
      id: snapshot.run.id,
      name: snapshot.run.name,
      status: snapshot.run.status,
      input: snapshot.run.input,
      ...(snapshot.run.output === undefined ? {} : { output: snapshot.run.output }),
      createdAt: snapshot.run.createdAt,
      updatedAt: snapshot.run.updatedAt,
      ...(snapshot.run.dynamic === undefined
        ? {}
        : { runtimeVersion: snapshot.run.dynamic.version }),
    } satisfies RunDetails;
    const response = {
      run,
      workflow: snapshot.workflow,
      graph: graphFromOverlay(snapshot.overlay, "runtime"),
      controls: {
        canCancelRun: snapshot.controls.canCancelRun,
        retryTargets: snapshot.controls.retryTargets.map(target => ({
          target: target.target,
          kind: target.kind,
          ...(target.nodeId === undefined ? {} : { nodeId: target.nodeId }),
        })),
      },
    } satisfies RunRuntimeSnapshot;
    return context.json({ ok: true, ...response });
  });
}
