import { HarnessError } from "@deepseek-ai/dsh-llm";
import type { WorkspaceRuntimeOpenFailure } from "@acpus/runtime/host";

export class AcpusOperationError extends HarnessError {}

export class WorkspaceRuntimeUnavailableError extends HarnessError {
  constructor(readonly failure: WorkspaceRuntimeOpenFailure) {
    super(failure.message, failure.type === "runtime-authority-busy"
      ? "ACPUS_RUNTIME_BUSY"
      : "ACPUS_RUNTIME_UNAVAILABLE");
  }
}
