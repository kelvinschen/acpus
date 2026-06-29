import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { WorkflowIR } from "@acpus/core";
import { runProcess } from "./process.js";

export type CompileWorkerResult =
  | { ok: true; ir: WorkflowIR }
  | { ok: false; message: string; stack?: string };

export async function compileWorkflow(entry: string, cwd: string, scratchDir: string): Promise<CompileWorkerResult> {
  const out = join(scratchDir, "workflow-ir.json");
  const worker = fileURLToPath(new URL(import.meta.url.endsWith(".ts") ? "./compile-worker.ts" : "./compile-worker.js", import.meta.url));
  const tsxImport = await import.meta.resolve("tsx");
  const conditions = await hasWorkspaceCoreSource(cwd) ? ["development"] : [];
  const args = [
    "--import",
    tsxImport,
    worker,
    entry,
    entry,
    out,
    cwd,
    JSON.stringify(conditions),
  ];
  if (conditions.length > 0) {
    // Workspace development should compile workflows against live core source.
    // Published installs must omit this condition and resolve normal package dist.
    args.unshift("--conditions=development");
  }
  const result = await runProcess(process.execPath, args);
  if (result.exitCode !== 0) {
    const payload = await readWorkerResult(out);
    if (payload && !payload.ok) return payload;
    const message = [result.stderr, result.stdout].filter(Boolean).join("\n").trim() || "Workflow compile failed.";
    return { ok: false, message };
  }
  const raw = await readFile(out, "utf8");
  return { ok: true, ir: JSON.parse(raw) as WorkflowIR };
}

async function hasWorkspaceCoreSource(cwd: string): Promise<boolean> {
  try {
    await access(join(cwd, "packages/core/src/index.ts"));
    return true;
  } catch {
    return false;
  }
}

async function readWorkerResult(path: string): Promise<CompileWorkerResult | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as CompileWorkerResult;
  } catch {
    return undefined;
  }
}
