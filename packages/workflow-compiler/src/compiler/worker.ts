import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Sha256Digest } from "@acpus/core/content-identity";
import { err, ResultAsync, type Result } from "neverthrow";
import type { CompiledWorkflowModule, CompileWorkflowModuleError } from "./module.js";
import { runProcess, type ProcessResult } from "./process.js";
import {
  interpretCompileWorkerOutput,
  type WorkerProtocolFailure,
  type WorkerSystemFailure,
} from "./worker-protocol.js";

export type CompileWorkerFailure =
  | CompileWorkflowModuleError
  | WorkerSystemFailure
  | { type: "worker-spawn-failed"; message: string; code?: string; stdoutTail: string; stderrTail: string }
  | { type: "worker-exit-failed"; message: string; exitCode: number | null; signal: NodeJS.Signals | null; stdoutTail: string; stderrTail: string }
  | { type: "worker-result-read-failed"; message: string; path: string; code?: string; stdoutTail: string; stderrTail: string }
  | WorkerProtocolFailure;

type CompletedProcess = Extract<ProcessResult, { ok: true }>;

type CompileWorkflowOptions = {
  dependencyRoot?: string;
  expectedSourceDigest: Sha256Digest;
};

export function compileWorkflow(
  entry: string,
  sourceRoot: string,
  scratchDir: string,
  options: CompileWorkflowOptions,
): ResultAsync<CompiledWorkflowModule, CompileWorkerFailure> {
  return new ResultAsync(compileWorkflowResult(entry, sourceRoot, scratchDir, options));
}

async function compileWorkflowResult(
  entry: string,
  sourceRoot: string,
  scratchDir: string,
  options: CompileWorkflowOptions,
): Promise<Result<CompiledWorkflowModule, CompileWorkerFailure>> {
  const out = join(scratchDir, "compile-result.json");
  const isSourceWorker = import.meta.url.endsWith(".ts");
  const worker = fileURLToPath(new URL(isSourceWorker ? "./compile-worker.ts" : "./compile-worker.js", import.meta.url));
  const args = [
    worker,
    entry,
    out,
    sourceRoot,
    options.dependencyRoot ?? sourceRoot,
    options.expectedSourceDigest,
  ];
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

  return interpretCompileWorkerOutput(processResult, raw, options.expectedSourceDigest);
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
