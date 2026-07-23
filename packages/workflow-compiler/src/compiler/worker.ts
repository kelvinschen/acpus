import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { err, ok, ResultAsync, type Result } from "neverthrow";
import type { WorkflowIR } from "@acpus/core/ir";
import type { CompiledWorkflowModule, CompileWorkflowModuleError } from "./module.js";
import { runProcess, type ProcessResult } from "./process.js";

type WorkerSystemFailure = {
  type: "worker-system-failed";
  message: string;
};

type WorkerProtocolFailure =
  | { type: "worker-result-invalid-json"; message: string; stdoutTail: string; stderrTail: string }
  | { type: "worker-result-invalid"; message: string; stdoutTail: string; stderrTail: string };

export type CompileWorkerFailure =
  | CompileWorkflowModuleError
  | WorkerSystemFailure
  | { type: "worker-spawn-failed"; message: string; code?: string; stdoutTail: string; stderrTail: string }
  | { type: "worker-exit-failed"; message: string; exitCode: number | null; signal: NodeJS.Signals | null; stdoutTail: string; stderrTail: string }
  | { type: "worker-result-read-failed"; message: string; path: string; code?: string; stdoutTail: string; stderrTail: string }
  | WorkerProtocolFailure;

export type CompileWorkerEnvelope =
  | { schemaVersion: 1; ok: true; result: CompiledWorkflowModule }
  | { schemaVersion: 1; ok: false; error: CompileWorkflowModuleError | WorkerSystemFailure };

type CompletedProcess = Extract<ProcessResult, { ok: true }>;

export function compileWorkflow(entry: string, cwd: string, scratchDir: string): ResultAsync<CompiledWorkflowModule, CompileWorkerFailure> {
  return new ResultAsync(compileWorkflowResult(entry, cwd, scratchDir));
}

async function compileWorkflowResult(entry: string, cwd: string, scratchDir: string): Promise<Result<CompiledWorkflowModule, CompileWorkerFailure>> {
  const out = join(scratchDir, "compile-result.json");
  const isSourceWorker = import.meta.url.endsWith(".ts");
  const worker = fileURLToPath(new URL(isSourceWorker ? "./compile-worker.ts" : "./compile-worker.js", import.meta.url));
  const args = [worker, entry, out, cwd];
  if (isSourceWorker) {
    args.unshift("--import", await import.meta.resolve("tsx"));
    // Workspace development should compile workflows against live core source.
    // Published installs must omit this condition and resolve normal package dist.
    args.unshift("--conditions=development");
  }

  const processResult = await runProcess(process.execPath, args);
  if (!processResult.ok) {
    return err({
      type: "worker-spawn-failed",
      message: `Workflow compile worker could not be started: ${processResult.error.message}`,
      ...(processResult.error.code ? { code: processResult.error.code } : {}),
      stdoutTail: processResult.stdoutTail,
      stderrTail: processResult.stderrTail,
    });
  }

  let raw: string;
  try {
    raw = await readFile(out, "utf8");
  } catch (error) {
    return err(classifyCompileWorkerResultReadFailure(processResult, out, error));
  }

  return interpretCompileWorkerOutput(processResult, raw);
}

export function classifyCompileWorkerResultReadFailure(
  processResult: CompletedProcess,
  path: string,
  error: unknown,
): CompileWorkerFailure {
  if (processResult.exitCode !== 0 && isMissingPathError(error)) return exitFailure(processResult);
  const code = errorCode(error);
  return {
    type: "worker-result-read-failed",
    path,
    message: `Workflow compile worker result '${path}' could not be read: ${causeMessage(error)}`,
    ...(code ? { code } : {}),
    stdoutTail: processResult.stdoutTail,
    stderrTail: processResult.stderrTail,
  };
}

export function interpretCompileWorkerOutput(processResult: CompletedProcess, raw: string): Result<CompiledWorkflowModule, CompileWorkerFailure> {
  const envelope = parseCompileWorkerEnvelope(raw, processResult.stdoutTail, processResult.stderrTail);
  if (envelope.isErr()) return err(envelope.error);
  if (processResult.exitCode === 0 && !envelope.value.ok) {
    return err(invalidResult("Workflow compile worker exited successfully with an error result.", processResult));
  }
  if (processResult.exitCode !== 0 && envelope.value.ok) {
    return err(invalidResult("Workflow compile worker exited unsuccessfully with a success result.", processResult));
  }
  return envelope.value.ok ? ok(envelope.value.result) : err(envelope.value.error);
}

export function parseCompileWorkerEnvelope(raw: string, stdoutTail = "", stderrTail = ""): Result<CompileWorkerEnvelope, WorkerProtocolFailure> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return err({
      type: "worker-result-invalid-json",
      message: `Workflow compile worker result is not valid JSON: ${error.message}`,
      stdoutTail,
      stderrTail,
    });
  }

  if (!isRecord(parsed) || parsed.schemaVersion !== 1 || typeof parsed.ok !== "boolean") {
    return err(invalidEnvelope("expected schemaVersion 1 and a boolean ok field", stdoutTail, stderrTail));
  }
  if (parsed.ok) {
    if (!hasExactKeys(parsed, ["schemaVersion", "ok", "result"]) || !isCompiledWorkflowModule(parsed.result)) {
      return err(invalidEnvelope("success result has an invalid shape or digest", stdoutTail, stderrTail));
    }
    return ok(parsed as CompileWorkerEnvelope);
  }
  if (!hasExactKeys(parsed, ["schemaVersion", "ok", "error"]) || !isWorkerEnvelopeError(parsed.error)) {
    return err(invalidEnvelope("error result has an invalid shape or tag", stdoutTail, stderrTail));
  }
  return ok(parsed as CompileWorkerEnvelope);
}

function isCompiledWorkflowModule(value: unknown): value is CompiledWorkflowModule {
  return isRecord(value)
    && hasExactKeys(value, ["ir", "sourceDigest"])
    && /^sha256:[a-f0-9]{64}$/.test(asString(value.sourceDigest))
    && isWorkflowIR(value.ir);
}

function isWorkflowIR(value: unknown): value is WorkflowIR {
  return isRecord(value)
    && hasExactKeys(value, ["irVersion", "name", "agents", "root", "diagnostics"], ["description", "inputSchema"])
    && value.irVersion === 6
    && typeof value.name === "string"
    && (value.description === undefined || typeof value.description === "string")
    && isRecord(value.agents)
    && isRecord(value.root)
    && Array.isArray(value.diagnostics);
}

function isWorkerEnvelopeError(value: unknown): value is CompileWorkflowModuleError | WorkerSystemFailure {
  if (!isRecord(value) || typeof value.type !== "string" || typeof value.message !== "string") return false;
  if (value.type === "worker-system-failed") return hasExactKeys(value, ["type", "message"]);
  if ([
    "workflow-source-read-failed",
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

function exitFailure(result: CompletedProcess): CompileWorkerFailure {
  const detail = [`exit code ${result.exitCode ?? "null"}`, result.signal ? `signal ${result.signal}` : ""]
    .filter(Boolean)
    .join(", ");
  return {
    type: "worker-exit-failed",
    message: `Workflow compile worker exited without a readable result (${detail}).`,
    exitCode: result.exitCode,
    signal: result.signal,
    stdoutTail: result.stdoutTail,
    stderrTail: result.stderrTail,
  };
}

function errorCode(error: unknown): string | undefined {
  return isRecord(error) && typeof error.code === "string" ? error.code : undefined;
}

function isMissingPathError(error: unknown): boolean {
  const code = errorCode(error);
  return code === "ENOENT" || code === "ENOTDIR";
}

function causeMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function hasExactKeys(value: Record<string, unknown>, required: string[], optional: string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every(key => Object.prototype.hasOwnProperty.call(value, key))
    && Object.keys(value).every(key => allowed.has(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
