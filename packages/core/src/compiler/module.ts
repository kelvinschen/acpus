import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { compileWorkflowDefinition, isWorkflowDefinition } from "../graph/builder.js";
import type { WorkflowIR } from "../ir/types.js";

export type CompileOptions = {
  sourcePath?: string;
  trusted?: boolean;
};

export async function compileWorkflowModule(entry: string, options: CompileOptions = {}): Promise<WorkflowIR> {
  const absolute = resolve(entry);
  const source = await readFile(absolute, "utf8");
  const cacheBuster = encodeURIComponent(`${Date.now()}-${Math.random()}`);
  const mod = await import(`${pathToFileURL(absolute).href}?acpus=${cacheBuster}`);
  const def = mod.default;
  if (!isWorkflowDefinition(def)) throw new Error(`Default export of ${entry} is not an Acpus workflow definition.`);
  const ir = compileWorkflowDefinition(def, { source: options.sourcePath ?? entry });
  ir.lock.workflowSourceDigest = `sha256:${createHash("sha256").update(source).digest("hex")}`;
  if (!options.trusted) {
    ir.diagnostics.push({
      code: "C001",
      severity: "warning",
      message: "Core-alpha compileWorkflowModule uses trusted dynamic import. Production must use deterministic sandbox/bundling.",
      path: "compiler",
    });
  }
  return ir;
}
