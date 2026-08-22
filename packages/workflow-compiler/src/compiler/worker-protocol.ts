import { validateWorkflowIR, type DiagnosticIR, type WorkflowIR } from "@acpus/core/ir";
import { isSha256Digest, type Sha256Digest } from "@acpus/core/content-identity";
import * as Result from "effect/Result";
import type { CompiledWorkflowModule, CompileWorkflowModuleError } from "./module.js";
import type { ProcessResult } from "./process.js";

export type WorkerSystemFailure = {
  type: "worker-system-failed";
  message: string;
};

export type WorkerProtocolFailure =
  | { type: "worker-result-invalid-json"; message: string; stdoutTail: string; stderrTail: string }
  | { type: "worker-result-invalid"; message: string; stdoutTail: string; stderrTail: string };

export type CompileWorkerEnvelope =
  | { schemaVersion: 1; ok: true; result: CompiledWorkflowModule }
  | { schemaVersion: 1; ok: false; error: CompileWorkflowModuleError | WorkerSystemFailure };

type CompletedProcess = Extract<ProcessResult, { ok: true }>;

export function interpretCompileWorkerOutput(
  processResult: CompletedProcess,
  raw: string,
  expectedSourceDigest: Sha256Digest,
): Result.Result<CompiledWorkflowModule, CompileWorkflowModuleError | WorkerSystemFailure | WorkerProtocolFailure> {
  const envelope = parseCompileWorkerEnvelope(raw, processResult.stdoutTail, processResult.stderrTail);
  if (Result.isFailure(envelope)) return Result.fail(envelope.failure);
  if (processResult.exitCode === 0 && !envelope.success.ok) {
    return Result.fail(invalidResult("Workflow compile worker exited successfully with an error result.", processResult));
  }
  if (processResult.exitCode !== 0 && envelope.success.ok) {
    return Result.fail(invalidResult("Workflow compile worker exited unsuccessfully with a success result.", processResult));
  }
  if (envelope.success.ok && envelope.success.result.sourceDigest !== expectedSourceDigest) {
    return Result.fail(invalidResult("Workflow compile worker source digest did not match the checked source digest.", processResult));
  }
  return envelope.success.ok ? Result.succeed(envelope.success.result) : Result.fail(envelope.success.error);
}

export function parseCompileWorkerEnvelope(
  raw: string,
  stdoutTail = "",
  stderrTail = "",
): Result.Result<CompileWorkerEnvelope, WorkerProtocolFailure> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return Result.fail({
      type: "worker-result-invalid-json",
      message: `Workflow compile worker result is not valid JSON: ${error.message}`,
      stdoutTail,
      stderrTail,
    });
  }

  if (!isRecord(parsed) || parsed.schemaVersion !== 1 || typeof parsed.ok !== "boolean") {
    return Result.fail(invalidEnvelope("expected schemaVersion 1 and a boolean ok field", stdoutTail, stderrTail));
  }
  if (parsed.ok) {
    if (!hasExactKeys(parsed, ["schemaVersion", "ok", "result"]) || !isCompiledWorkflowModule(parsed.result)) {
      return Result.fail(invalidEnvelope("success result has an invalid shape or digest", stdoutTail, stderrTail));
    }
    return Result.succeed(parsed as CompileWorkerEnvelope);
  }
  if (!hasExactKeys(parsed, ["schemaVersion", "ok", "error"]) || !isWorkerEnvelopeError(parsed.error)) {
    return Result.fail(invalidEnvelope("error result has an invalid shape or tag", stdoutTail, stderrTail));
  }
  return Result.succeed(parsed as CompileWorkerEnvelope);
}

function isCompiledWorkflowModule(value: unknown): value is CompiledWorkflowModule {
  return isRecord(value)
    && hasExactKeys(value, ["ir", "sourceDigest"])
    && isSha256Digest(value.sourceDigest)
    && isWorkflowIR(value.ir);
}

function isWorkflowIR(value: unknown): value is WorkflowIR {
  if (!(isRecord(value)
    && hasExactKeys(value, ["irVersion", "name", "agents", "root", "diagnostics"], ["description", "inputSchema"])
    && value.irVersion === 8
    && typeof value.name === "string"
    && (value.description === undefined || typeof value.description === "string")
    && isRecord(value.agents)
    && isRecord(value.root)
    && Array.isArray(value.diagnostics))) return false;
  const ir = value as WorkflowIR;
  const findings = validateWorkflowIR(ir);
  const authoritativeFindings = validateWorkflowIR({ ...ir, diagnostics: [] });
  const authoritative = new Set(authoritativeFindings.map(diagnosticIdentity));
  if (findings.some(finding => !authoritative.has(diagnosticIdentity(finding)))) return false;
  const reported = new Set(ir.diagnostics.map(diagnosticIdentity));
  return authoritativeFindings.every(finding => reported.has(diagnosticIdentity(finding)));
}

function diagnosticIdentity(diagnostic: DiagnosticIR): string {
  return JSON.stringify([
    diagnostic.code,
    diagnostic.severity,
    diagnostic.message,
    diagnostic.path ?? null,
    diagnostic.source?.file ?? null,
    diagnostic.source?.line ?? null,
    diagnostic.source?.column ?? null,
    diagnostic.hint ?? null,
  ]);
}

function isWorkerEnvelopeError(value: unknown): value is CompileWorkflowModuleError | WorkerSystemFailure {
  if (!isRecord(value) || typeof value.type !== "string" || typeof value.message !== "string") return false;
  if (value.type === "worker-system-failed") return hasExactKeys(value, ["type", "message"]);
  if ([
    "workflow-source-read-failed",
    "workflow-source-changed",
    "module-import-failed",
    "invalid-default-export",
    "workflow-build-failed",
    "task-analysis-failed",
  ].includes(value.type)) {
    return hasExactKeys(value, ["type", "entry", "message"]) && typeof value.entry === "string";
  }
  return value.type === "workflow-outside-workspace"
    && hasExactKeys(value, ["type", "workflowFile", "cwd", "message"])
    && typeof value.workflowFile === "string"
    && typeof value.cwd === "string";
}

function invalidEnvelope(reason: string, stdoutTail: string, stderrTail: string): WorkerProtocolFailure {
  return {
    type: "worker-result-invalid",
    message: `Workflow compile worker result is invalid: ${reason}.`,
    stdoutTail,
    stderrTail,
  };
}

function invalidResult(message: string, result: CompletedProcess): WorkerProtocolFailure {
  return {
    type: "worker-result-invalid",
    message,
    stdoutTail: result.stdoutTail,
    stderrTail: result.stderrTail,
  };
}

function hasExactKeys(value: Record<string, unknown>, required: string[], optional: string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every(key => Object.prototype.hasOwnProperty.call(value, key))
    && Object.keys(value).every(key => allowed.has(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
