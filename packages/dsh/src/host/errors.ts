import { HarnessError } from "@deepseek-ai/dsh-llm";
import type { WorkspaceRuntimeOpenFailure } from "@acpus/runtime/host";
import type { RuntimePoolOpenFailure } from "./runtime-pool.js";

export class AcpusOperationError extends HarnessError {}

class WorkspaceRuntimeUnavailableError extends HarnessError {
  constructor(readonly failure: WorkspaceRuntimeOpenFailure) {
    super(failure.message, failure.type === "runtime-authority-busy"
      ? "ACPUS_RUNTIME_BUSY"
      : "ACPUS_RUNTIME_UNAVAILABLE");
  }
}

export function runtimePoolOperationError(failure: RuntimePoolOpenFailure): HarnessError {
  if (failure.type === "workspace-unavailable") {
    return new AcpusOperationError(
      failure.message,
      "ACPUS_WORKSPACE_UNAVAILABLE",
      { cause: failure.cause },
    );
  }
  return new WorkspaceRuntimeUnavailableError(failure);
}
