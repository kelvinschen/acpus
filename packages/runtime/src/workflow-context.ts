import type { AcpusIr } from "@acpus/core";
import { dirname } from "node:path";
import type { WorkflowExpressionContext } from "./types.js";

export function buildWorkflowExpressionContext(ir: AcpusIr): WorkflowExpressionContext {
  const sourcePath = ir.source.path ?? "";
  return {
    name: ir.name,
    description: ir.description ?? "",
    source_path: sourcePath,
    source_dir: sourcePath ? dirname(sourcePath) : ""
  };
}
