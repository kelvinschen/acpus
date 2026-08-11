import type { RuntimeReadFailure } from "@acpus/runtime";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function apiError(status: number, code: string, message: string): never {
  throw new ApiError(status, code, message);
}

export function runtimeReadError(error: Pick<RuntimeReadFailure, "type" | "message">): never {
  if (error.type === "runtime-store-repair-required") {
    apiError(409, "runtime_store_fix_required", error.message);
  }
  if (error.type === "runtime-store-unsupported") {
    apiError(422, "runtime_store_unavailable", error.message);
  }
  apiError(503, "runtime_store_unavailable", error.message);
}
