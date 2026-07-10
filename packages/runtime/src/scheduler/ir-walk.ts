import { walkNodes, type NodeIR, type ScopeIR } from "@acpus/core/ir";

export function indexNodes(scope: ScopeIR): Map<string, NodeIR> {
  return new Map(Array.from(walkNodes(scope), ({ node }) => [node.id, node]));
}
