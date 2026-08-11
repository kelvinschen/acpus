import { Hono } from "hono";
import type { AccessPolicy } from "./security.js";
import { requireToken } from "./security.js";
import { ApiError } from "./errors.js";
import { registerArtifactRoutes } from "./routes/artifacts.js";
import { registerInspectionControlRoutes } from "./routes/inspection-controls.js";
import { registerRunRoutes } from "./routes/runs.js";
import { registerSystemRoutes } from "./routes/system.js";
import { registerWorkflowRoutes } from "./routes/workflows.js";
import { createWorkspaceContext } from "./workspace-context.js";

export type WebAppOptions = {
  cwd: string;
  access?: AccessPolicy;
  ensureDaemonRunning(cwd: string): void | Promise<void>;
};

export function createWebApp(options: WebAppOptions): Hono {
  const app = new Hono();
  const workspaces = createWorkspaceContext(options.cwd);

  app.use("*", requireToken(options.access ?? {}));
  registerSystemRoutes(app, options);
  registerRunRoutes(app, workspaces);
  registerInspectionControlRoutes(app, options, workspaces);
  registerArtifactRoutes(app, workspaces);
  registerWorkflowRoutes(app, options.cwd);

  app.notFound(context => {
    context.status(404);
    return context.json({ ok: false, error: { code: "not_found", message: "Route not found." } });
  });

  app.onError((error, context) => {
    if (error instanceof ApiError) {
      context.status(error.status as any);
      return context.json({ ok: false, error: { code: error.code, message: error.message } });
    }
    console.error("Acpus WebUI request failed:", error);
    context.status(500);
    return context.json({
      ok: false,
      error: { code: "internal_error", message: "Internal server error." },
    });
  });

  return app;
}
