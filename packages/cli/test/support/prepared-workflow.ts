import type { WorkflowIR } from "@acpus/core/ir";
import type { PreparedWorkflow } from "@acpus/workflow-compiler";

export function preparedWorkflow(ir: WorkflowIR): PreparedWorkflow {
  const source = { kind: "workspace", entry: "workflow.ts" } as const;
  const digest = `sha256:${"0".repeat(64)}` as const;
  return {
    source,
    ir,
    irJson: JSON.stringify(ir),
    sourceGraphDigest: digest,
    lock: {
      kind: "acpus_workflow_preparation_lock",
      version: 2,
      workflow: { source, entryDigest: digest },
      ir: { path: "workflow.ir.json", digest },
      sourceGraphDigest: digest,
    },
  };
}
