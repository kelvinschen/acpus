import type { Hono } from "hono";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import type { WorkflowVisualizationSource } from "../../api-types.js";
import { apiError } from "../errors.js";
import {
  listProjectWorkflowCatalog,
  listWorkflowFiles,
} from "../workflows/source.js";
import { tryVisualizeWorkflowSource } from "../workflows/visualization.js";

export function registerWorkflowRoutes(app: Hono, cwd: string): void {
  app.get("/api/workflows/catalog", async (context) => {
    return context.json({ ok: true, catalog: await listProjectWorkflowCatalog(cwd) });
  });

  app.get("/api/workflows/files", async (context) => {
    const dir = context.req.query("dir") ?? "";
    const files = await Effect.runPromise(Effect.result(listWorkflowFiles(cwd, dir)));
    if (Result.isFailure(files)) apiError(400, "invalid_workflow_path", files.failure.message);
    return context.json({ ok: true, files: files.success });
  });

  app.post("/api/workflows/visualize", async (context) => {
    const body = await context.req.json().catch(() =>
      apiError(400, "invalid_json", "Visualization body must be JSON."),
    );
    const source = parseWorkflowVisualizationSource(body);
    const visualization = await Effect.runPromise(Effect.result(tryVisualizeWorkflowSource(cwd, source)));
    return context.json({
      ok: true,
      result: Result.match(visualization, {
        onSuccess: ready => ready,
        onFailure: failure => ({ status: "failed" as const, phase: failure.phase, message: failure.message }),
      }),
    });
  });
}

function parseWorkflowVisualizationSource(body: unknown): WorkflowVisualizationSource {
  if (!body || typeof body !== "object") apiError(400, "invalid_visualization_source", "Visualization body must be an object.");
  const record = body as Record<string, unknown>;
  const source = record.source;
  if (!source || typeof source !== "object") apiError(400, "invalid_visualization_source", "Visualization body requires a source object.");
  const value = source as Record<string, unknown>;
  if (value.kind === "catalog" && typeof value.name === "string" && value.name.length > 0) {
    return { kind: "catalog", name: value.name };
  }
  if (value.kind === "file" && typeof value.path === "string" && value.path.length > 0) {
    return { kind: "file", path: value.path };
  }
  apiError(400, "invalid_visualization_source", "Visualization source must be a catalog name or workspace file path.");
}
