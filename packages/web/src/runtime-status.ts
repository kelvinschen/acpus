export type DisplayStatus =
  | "queued"
  | "running"
  | "awaiting"
  | "paused"
  | "completed"
  | "failed"
  | "canceled"
  | "skipped"
  | "not_started";

const activeDisplayStatuses = new Set<DisplayStatus>(["running", "awaiting"]);

export function normalizeRuntimeStatus(status: string | undefined): DisplayStatus {
  switch (status) {
    case "pending":
    case "ready":
      return "queued";
    case "started":
      return "running";
    case "cancelled":
      return "canceled";
    case "timed_out":
      return "failed";
    case "consumed":
    case "superseded":
      return "completed";
    case "running":
    case "awaiting":
    case "paused":
    case "completed":
    case "failed":
    case "canceled":
    case "skipped":
    case "not_started":
      return status;
    default:
      return "not_started";
  }
}

export function displayRunStatus(status: string | undefined): DisplayStatus {
  return normalizeRuntimeStatus(status);
}

export function displayNodeStatus(status: string | undefined): DisplayStatus {
  return normalizeRuntimeStatus(status);
}

export function isActiveDisplayStatus(status: string | undefined): boolean {
  return activeDisplayStatuses.has(normalizeRuntimeStatus(status));
}

export function runtimeStatusLabel(status: string | undefined): string {
  return normalizeRuntimeStatus(status).replaceAll("_", " ");
}
