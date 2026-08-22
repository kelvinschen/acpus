import type { Hono } from "hono";
import {
  getRuntimeHealth,
  inspectRuntimeStore,
  repairRuntimeStore,
  type RuntimeStoreFailure,
} from "@acpus/runtime";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import type {
  HealthReport,
  RuntimeStoreStatus,
  ServerConfig,
} from "../../api-types.js";
import { apiError } from "../errors.js";
import type { AccessPolicy } from "../security.js";

type SystemRouteOptions = {
  cwd: string;
  access?: AccessPolicy;
};

export function registerSystemRoutes(app: Hono, options: SystemRouteOptions): void {
  app.get("/api/health", async (context) => {
    const health = await Effect.runPromise(getRuntimeHealth(options.cwd));
    const report = {
      checks: health.checks.map(({ area, status, message }) => ({ area, status, message })),
    } satisfies HealthReport;
    return context.json({ ok: true, health: report });
  });

  app.get("/api/runtime-store", async (context) => {
    const inspected = await Effect.runPromise(Effect.result(inspectRuntimeStore(options.cwd)));
    if (Result.isFailure(inspected)) {
      apiError(500, "runtime_store_unavailable", inspected.failure.message);
    }
    return context.json({ ok: true, runtimeStore: publicRuntimeStoreStatus(inspected.success) });
  });

  app.post("/api/runtime-store", async (context) => {
    const repaired = await Effect.runPromise(Effect.result(repairRuntimeStore(options.cwd)));
    if (Result.isFailure(repaired)) runtimeStoreRepairError(repaired.failure);
    return context.json({ ok: true });
  });

  app.get("/api/config", (context) => {
    const config = {
      cwd: options.cwd,
      access: options.access?.token !== undefined ? "token" : "open",
    } satisfies ServerConfig;
    return context.json({ ok: true, config });
  });
}

function publicRuntimeStoreStatus(
  status: { state: "ready" } | { state: "repairable" | "unsupported"; message: string },
): RuntimeStoreStatus {
  if (status.state === "ready") return { state: "ready" };
  return status.state === "repairable"
    ? { state: "needs-fix", message: status.message }
    : { state: "unavailable", message: status.message };
}

function runtimeStoreRepairError(error: RuntimeStoreFailure): never {
  apiError(
    error.type === "failed" || error.type === "unreadable" ? 500 : error.type === "unsupported" ? 422 : 409,
    "runtime_store_fix_failed",
    error.message,
  );
}
