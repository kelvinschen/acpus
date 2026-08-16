import type { JsonValue } from "@acpus/expression/ir";
import { tryNormalizeWorkflowInput } from "@acpus/runtime";
import type { WorkspaceRuntime } from "@acpus/runtime/host";
import {
  tryPrepareWorkflow,
  type PreparedWorkflow,
  type WorkflowPreparationFailure,
} from "@acpus/workflow-compiler";
import { AcpusOperationError } from "./errors.js";
import type { RunLink, RunLinkStore } from "./run-links.js";
import type { ResolvedTaskSelector } from "../task.js";

type WorkflowDiagnostic = {
  code: string;
  severity: "error" | "info" | "warning";
  message: string;
  source?: { file?: string; line?: number; column?: number };
  path?: string;
  hint?: string;
};

export type InvalidWorkflow = {
  status: "invalid";
  phase: string;
  diagnostics: WorkflowDiagnostic[];
};

export type PreparedAuthoringWorkflow = {
  status: "prepared";
  prepared: PreparedWorkflow;
};

export type AcpusRunReceipt = {
  status: "admitted";
  runId: string;
  task: ResolvedTaskSelector;
};

export async function prepareAuthoringWorkflow(
  workspace: string,
  workflow: string,
): Promise<PreparedAuthoringWorkflow | InvalidWorkflow> {
  const prepared = await tryPrepareWorkflow({
    workspaceDir: workspace,
    source: {
      kind: "files",
      entry: "workflow.ts",
      files: [{ path: "workflow.ts", content: workflow }],
    },
  });
  return prepared.match(
    value => ({ status: "prepared", prepared: value }),
    invalidWorkflow,
  );
}

export function normalizeAuthoringInput(
  prepared: PreparedWorkflow,
  value: JsonValue,
): { status: "valid"; input: JsonValue } | InvalidWorkflow {
  const normalized = tryNormalizeWorkflowInput(prepared.ir, value);
  return normalized.match(
    input => ({ status: "valid", input }),
    error => ({
      status: "invalid",
      phase: "input",
      diagnostics: [{
        code: "ACPUS_INPUT_INVALID",
        severity: "error",
        message: error.message,
      }],
    }),
  );
}

export async function submitPreparedWorkflow(input: {
  runtime: WorkspaceRuntime;
  prepared: PreparedWorkflow;
  normalizedInput: JsonValue;
  admissionRequestId: string;
  link: RunLink;
  links: RunLinkStore;
  signal?: AbortSignal;
}): Promise<AcpusRunReceipt> {
  const existing = await readAdmissionReceipt(input);
  if (existing !== undefined) return existing;

  input.signal?.throwIfAborted();
  const submitted = await input.runtime.submit({
    requestId: input.admissionRequestId,
    prepared: input.prepared,
    input: input.normalizedInput,
  });
  if (submitted.isErr()) {
    throw new AcpusOperationError(submitted.error.message, `ACPUS_${submitted.error.code}`);
  }
  const admitted = await input.links.admitted(input.admissionRequestId, submitted.value);
  return {
    status: "admitted",
    runId: submitted.value.id,
    task: { name: admitted.workflowName, occurrence: admitted.occurrence },
  };
}

export async function readAdmissionReceipt(input: {
  runtime: WorkspaceRuntime;
  admissionRequestId: string;
  link: RunLink;
}): Promise<AcpusRunReceipt | undefined> {
  if (input.link.runId === undefined) return undefined;
  if (input.link.workflowName === undefined || input.link.occurrence === undefined) {
    throw new AcpusOperationError(
      `Admission '${input.admissionRequestId}' is missing workflow metadata.`,
      "ACPUS_ADMISSION_INCONSISTENT",
    );
  }
  const admission = await input.runtime.findAdmission(input.admissionRequestId);
  if (admission.isErr()) {
    throw new AcpusOperationError(admission.error.message, "ACPUS_READ_FAILED");
  }
  if (admission.value?.id !== input.link.runId) {
    throw new AcpusOperationError(
      `Admission '${input.admissionRequestId}' did not resolve to a live run.`,
      "ACPUS_ADMISSION_INCONSISTENT",
    );
  }
  return {
    status: "admitted",
    runId: input.link.runId,
    task: {
      name: input.link.workflowName,
      occurrence: input.link.occurrence,
    },
  };
}

function invalidWorkflow(failure: WorkflowPreparationFailure): InvalidWorkflow {
  const diagnostics = "diagnostics" in failure
    ? failure.diagnostics.slice(0, 50).map(diagnostic => ({
        code: diagnostic.code,
        severity: diagnostic.severity,
        message: diagnostic.message,
        ...(diagnostic.source === undefined ? {} : { source: diagnostic.source }),
        ...(diagnostic.path === undefined ? {} : { path: diagnostic.path }),
        ...(diagnostic.hint === undefined ? {} : { hint: diagnostic.hint }),
      }))
    : [{
        code: failure.type,
        severity: "error" as const,
        message: failure.message,
        ...("path" in failure ? { path: failure.path } : {}),
      }];
  return { status: "invalid", phase: failure.phase, diagnostics };
}
