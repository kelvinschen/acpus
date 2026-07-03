import type { NodeIR, ScopeIR } from "@acpus/core/ir";

export function indexNodes(scope: ScopeIR, nodes = new Map<string, NodeIR>()): Map<string, NodeIR> {
  for (const node of scope.nodes) {
    nodes.set(node.id, node);
    if (node.kind === "if") {
      indexNodes(node.then, nodes);
      if (node.else) indexNodes(node.else, nodes);
    } else if (node.kind === "switch") {
      for (const c of node.cases) indexNodes(c.then, nodes);
      if (node.default) indexNodes(node.default, nodes);
    } else if (node.kind === "parallel") {
      for (const branch of Object.values(node.branches)) indexNodes(branch.scope, nodes);
    } else if (node.kind === "fanout" || node.kind === "loop") {
      indexNodes(node.do, nodes);
    }
  }
  return nodes;
}
