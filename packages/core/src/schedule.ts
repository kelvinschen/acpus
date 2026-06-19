import type { AcpusIr, IrNode, ScheduleNode, ScheduleSummary } from "./types.js";

export function createSchedule(ir: AcpusIr): ScheduleSummary {
  return {
    workflow: ir.name,
    nodes: ir.root.children?.map(toScheduleNode) ?? []
  };
}

function toScheduleNode(node: IrNode): ScheduleNode {
  return {
    id: node.id,
    kind: node.kind,
    nodePath: node.nodePath.join("/"),
    outputMerge: node.outputMerge,
    children: node.children?.map(toScheduleNode),
    branches: node.branches?.map((branch) => ({
      id: branch.id,
      when: branch.when,
      children: [toScheduleNode(branch.child)]
    }))
  };
}
