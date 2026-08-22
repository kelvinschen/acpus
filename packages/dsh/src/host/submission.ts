import type { JsonValue } from "@acpus/expression/ir";
import {
  finalizeAgentBindings,
  tryNormalizeWorkflowInput,
  tryParseAgentInjectionMap,
  type AgentInjectionMap,
  type AgentPresetCatalog,
} from "@acpus/runtime";
import type { WorkspaceRuntime } from "@acpus/runtime/host";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
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

export function prepareAuthoringWorkflow(
  workspace: string,
  workflow: string,
): Effect.Effect<PreparedAuthoringWorkflow | InvalidWorkflow> {
  return Effect.result(tryPrepareWorkflow({
    workspaceDir: workspace,
    source: {
      kind: "files",
      entry: "workflow.ts",
      files: [{ path: "workflow.ts", content: workflow }],
    },
  })).pipe(Effect.map(prepared => Result.match(prepared, {
    onSuccess: value => ({ status: "prepared" as const, prepared: value }),
    onFailure: invalidWorkflow,
  })));
}

export function normalizeAuthoringInput(
  prepared: PreparedWorkflow,
  value: JsonValue,
): { status: "valid"; input: JsonValue } | InvalidWorkflow {
  const normalized = tryNormalizeWorkflowInput(prepared.ir, value);
  return Result.match(normalized, {
    onSuccess: input => ({ status: "valid" as const, input }),
    onFailure: error => ({
      status: "invalid",
      phase: "input",
      diagnostics: [{
        code: "ACPUS_INPUT_INVALID",
        severity: "error",
        message: error.message,
      }],
    }),
  });
}

export function normalizeAgentInjections(
  value: JsonValue,
  declarations?: Record<string, unknown>,
): { status: "valid"; agents: AgentInjectionMap } | InvalidWorkflow {
  const parsed = tryParseAgentInjectionMap(value, declarations);
  return Result.match(parsed, {
    onSuccess: agents => ({ status: "valid" as const, agents }),
    onFailure: error => ({
      status: "invalid",
      phase: "agents",
      diagnostics: [{
        code: "ACPUS_AGENT_INJECTIONS_INVALID",
        severity: "error",
        message: error.message,
        ...(error.path === undefined ? {} : { path: error.path }),
      }],
    }),
  });
}

export function preflightAgentBindings(
  declarations: PreparedWorkflow["ir"]["agents"],
  agents: AgentInjectionMap,
  presetCatalog?: AgentPresetCatalog,
): { status: "valid" } | InvalidWorkflow {
  const finalized = finalizeAgentBindings({
    declarations,
    injections: agents,
    ...(presetCatalog === undefined ? {} : { presetCatalog }),
  });
  return Result.match(finalized, {
    onSuccess: () => ({ status: "valid" as const }),
    onFailure: failure => ({
      status: "invalid",
      phase: "agents",
      diagnostics: [{
        code: failure.type === "agent-injections-invalid"
          ? "ACPUS_AGENT_INJECTIONS_INVALID"
          : failure.type === "agent-preset-not-found"
            ? "ACPUS_AGENT_PRESET_NOT_FOUND"
            : "ACPUS_AGENT_BINDINGS_UNRESOLVED",
        severity: "error",
        message: failure.message,
        ...(failure.type === "agent-injections-invalid" && failure.path !== undefined
          ? { path: failure.path }
          : {}),
      }],
    }),
  });
}

export function submitPreparedWorkflow(input: {
  runtime: WorkspaceRuntime;
  prepared: PreparedWorkflow;
  normalizedInput: JsonValue;
  agentInjections?: AgentInjectionMap;
  admissionRequestId: string;
  link: RunLink;
  links: RunLinkStore;
}): Effect.Effect<AcpusRunReceipt, AcpusOperationError> {
  return Effect.gen(function* () {
    const existing = yield* readAdmissionReceipt(input);
    if (existing !== undefined) return existing;

    const submission = {
      requestId: input.admissionRequestId,
      prepared: input.prepared,
      input: input.normalizedInput,
      ...(input.agentInjections === undefined
        ? {}
        : { agentInjections: input.agentInjections }),
    };
    let submitted = yield* Effect.result(input.runtime.submit(submission));
    if (Result.isFailure(submitted)) {
      if (submitted.failure.outcome === "not-admitted") {
        return yield* Effect.fail(new AcpusOperationError(
          submitted.failure.message,
          `ACPUS_${submitted.failure.code}`,
        ));
      }
      let recovered = yield* Effect.result(
        input.runtime.findAdmission(input.admissionRequestId),
      );
      if (Result.isSuccess(recovered)
        && recovered.success === undefined
        && submitted.failure.outcome === "unknown") {
        submitted = yield* Effect.result(input.runtime.submit(submission));
        if (Result.isSuccess(submitted)) return yield* persistReceipt(input, submitted.success);
        recovered = yield* Effect.result(input.runtime.findAdmission(input.admissionRequestId));
      }
      if (Result.isSuccess(recovered) && recovered.success !== undefined) {
        return yield* persistReceipt(input, recovered.success);
      }
      return yield* Effect.fail(new AcpusOperationError(
        "Acpus could not confirm the durable admission outcome. Keep the original workspace and retry after Runtime recovery; do not submit a replacement task.",
        "ACPUS_ADMISSION_OUTCOME_UNKNOWN",
      ));
    }
    return yield* persistReceipt(input, submitted.success);
  });
}

function persistReceipt(
  input: { admissionRequestId: string; links: RunLinkStore },
  run: { id: string; name: string },
): Effect.Effect<AcpusRunReceipt, AcpusOperationError> {
  return input.links.admitted(input.admissionRequestId, run).pipe(Effect.map(admitted => ({
    status: "admitted",
    runId: run.id,
    task: { name: admitted.workflowName, occurrence: admitted.occurrence },
  })));
}

export function readAdmissionReceipt(input: {
  runtime: WorkspaceRuntime;
  admissionRequestId: string;
  link: RunLink;
}): Effect.Effect<AcpusRunReceipt | undefined, AcpusOperationError> {
  if (input.link.runId === undefined) return Effect.succeed(undefined);
  if (input.link.workflowName === undefined || input.link.occurrence === undefined) {
    return Effect.fail(new AcpusOperationError(
      `Admission '${input.admissionRequestId}' is missing workflow metadata.`,
      "ACPUS_ADMISSION_INCONSISTENT",
    ));
  }
  const link = input.link as RunLink & {
    runId: string;
    workflowName: string;
    occurrence: number;
  };
  return Effect.result(input.runtime.findAdmission(input.admissionRequestId)).pipe(
    Effect.flatMap(admission => {
      if (Result.isFailure(admission)) {
        return Effect.fail(new AcpusOperationError(
          admission.failure.message,
          "ACPUS_READ_FAILED",
        ));
      }
      if (admission.success?.id !== link.runId) {
        return Effect.fail(new AcpusOperationError(
          `Admission '${input.admissionRequestId}' did not resolve to a live run.`,
          "ACPUS_ADMISSION_INCONSISTENT",
        ));
      }
      return Effect.succeed({
        status: "admitted" as const,
        runId: link.runId,
        task: { name: link.workflowName, occurrence: link.occurrence },
      });
    }),
  );
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
