import type { NodeIR, ScopeIR, SignalNodeIR } from "@acpus/core/ir";

export function findSignalNode(scope: ScopeIR, nodeId: string): SignalNodeIR | undefined {
  const node = findNode(scope, nodeId);
  return node?.kind === "signal" ? node : undefined;
}

function findNode(scope: ScopeIR, nodeId: string): NodeIR | undefined {
  for (const node of scope.nodes) {
    if (node.id === nodeId) return node;
    if (node.kind === "if") {
      const found = findNode(node.then, nodeId) ?? (node.else ? findNode(node.else, nodeId) : undefined);
      if (found) return found;
    } else if (node.kind === "switch") {
      for (const c of node.cases) {
        const found = findNode(c.then, nodeId);
        if (found) return found;
      }
      if (node.default) {
        const found = findNode(node.default, nodeId);
        if (found) return found;
      }
    } else if (node.kind === "parallel") {
      for (const branch of Object.values(node.branches)) {
        const found = findNode(branch.scope, nodeId);
        if (found) return found;
      }
    } else if (node.kind === "fanout") {
      const found = findNode(node.do, nodeId);
      if (found) return found;
    } else if (node.kind === "loop") {
      const found = findNode(node.do, nodeId);
      if (found) return found;
    }
  }
  return undefined;
}
