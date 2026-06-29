import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { compileWorkflowDefinition, isWorkflowDefinition, validateWorkflowIR, type WorkflowIR } from "@acpus/core";
import { bundleWorkflowTasks } from "./task-bundler.js";
import { analyzeWorkflowTasks } from "./task-provenance.js";

export type CompileOptions = {
  sourcePath?: string;
  cwd?: string;
  conditions?: string[];
};

export async function compileWorkflowModule(entry: string, options: CompileOptions = {}): Promise<WorkflowIR> {
  const absolute = resolve(entry);
  const source = await readFile(absolute, "utf8");
  const mod = await import(pathToFileURL(absolute).href);
  const def = mod.default;
  if (!isWorkflowDefinition(def)) throw new Error(`Default export of ${entry} is not an Acpus workflow definition.`);
  const ir = compileWorkflowDefinition(def, { source: options.sourcePath ?? entry, validate: false });
  ir.lock.workflowSourceDigest = `sha256:${createHash("sha256").update(source).digest("hex")}`;
  const analysis = await analyzeWorkflowTasks(absolute, source);
  await bundleWorkflowTasks(ir, {
    cwd: options.cwd ?? dirname(absolute),
    analysis,
    ...(options.conditions ? { conditions: options.conditions } : {}),
  });
  ir.diagnostics.push(...validateWorkflowIR(ir));
  return ir;
}
