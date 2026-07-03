import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { WorkflowIR } from "@acpus/core/ir";
import { runProcess } from "./process.js";

export type CompileWorkerResult =
  | { ok: true; ir: WorkflowIR }
  | { ok: false; type: string; message: string; stack?: string };

export async function compileWorkflow(entry: string, cwd: string, scratchDir: string): Promise<CompileWorkerResult> {
  const out = join(scratchDir, "workflow-ir.json");
  const isSourceWorker = import.meta.url.endsWith(".ts");
  const worker = fileURLToPath(new URL(isSourceWorker ? "./compile-worker.ts" : "./compile-worker.js", import.meta.url));
  const args = [worker, entry, entry, out, cwd];
  if (isSourceWorker) {
    args.unshift("--import", await import.meta.resolve("tsx"));
    // Workspace development should compile workflows against live core source.
    // Published installs must omit this condition and resolve normal package dist.
    args.unshift("--conditions=development");
  }
  const result = await runProcess(process.execPath, args);
  if (result.exitCode !== 0) {
    const payload = await readWorkerResult(out);
    if (payload && !payload.ok) return payload;
    const message = [result.stderr, result.stdout].filter(Boolean).join("\n").trim() || "Workflow compile failed.";
    return { ok: false, type: "compile-worker-failed", message };
  }
  const raw = await readFile(out, "utf8");
  return { ok: true, ir: JSON.parse(raw) as WorkflowIR };
}

async function readWorkerResult(path: string): Promise<CompileWorkerResult | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as CompileWorkerResult;
  } catch {
    return undefined;
  }
}
