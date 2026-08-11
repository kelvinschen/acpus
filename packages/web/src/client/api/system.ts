import type {
  HealthReport,
  RuntimeStoreStatus,
  ServerConfig,
} from "../../api-types.js";
import { decodeEmpty, decodeField, requestJson } from "./transport.js";
import { hasOnlyKeys, isRecord } from "./wire.js";

export async function getHealth(): Promise<HealthReport> {
  return requestJson("/api/health", undefined, decodeField("health", isHealthReport));
}

export async function getRuntimeStore(): Promise<RuntimeStoreStatus> {
  return requestJson(
    "/api/runtime-store",
    undefined,
    decodeField("runtimeStore", isRuntimeStoreStatus),
  );
}

export async function repairRuntimeStore(): Promise<void> {
  return requestJson<void>("/api/runtime-store", {
    method: "POST",
  }, decodeEmpty);
}

export async function getConfig(): Promise<ServerConfig> {
  return requestJson("/api/config", undefined, decodeField("config", isServerConfig));
}

function isHealthReport(value: unknown): value is HealthReport {
  return isRecord(value)
    && Array.isArray(value.checks)
    && value.checks.every(check => isRecord(check)
      && typeof check.area === "string"
      && (check.status === "ok" || check.status === "warn" || check.status === "fail")
      && typeof check.message === "string");
}

function isRuntimeStoreStatus(value: unknown): value is RuntimeStoreStatus {
  if (!isRecord(value)) return false;
  if (value.state === "ready") return hasOnlyKeys(value, ["state"]);
  return (value.state === "needs-fix" || value.state === "unavailable")
    && hasOnlyKeys(value, ["state", "message"])
    && typeof value.message === "string";
}

function isServerConfig(value: unknown): value is ServerConfig {
  return isRecord(value)
    && hasOnlyKeys(value, ["cwd", "access"])
    && typeof value.cwd === "string"
    && (value.access === "open" || value.access === "token");
}
