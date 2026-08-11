import type { WorkflowPreparationFailure } from "@acpus/workflow-compiler";

export type WorkflowImportFailure =
  | { type: "usage"; message: string }
  | { type: "import"; errorCode: string; message: string }
  | { type: "preparation"; failure: WorkflowPreparationFailure };

export class WorkflowImportAbort extends Error {
  constructor(readonly failure: WorkflowImportFailure) {
    super(failure.type === "preparation" ? failure.failure.message : failure.message);
  }
}

export function abortUsage(message: string): never {
  throw new WorkflowImportAbort({ type: "usage", message });
}

export function abortImport(errorCode: string, message: string): never {
  throw new WorkflowImportAbort({ type: "import", errorCode, message });
}

export function causeMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
