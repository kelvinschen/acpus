import type { ScopeIR, TaskNodeIR } from "../ir/types.js";

export function forEachTaskNode(scope: ScopeIR, visit: (node: TaskNodeIR) => void): void {
  for (const node of scope.nodes) {
    switch (node.kind) {
      case "task":
        visit(node);
        break;
      case "if":
        forEachTaskNode(node.then, visit);
        if (node.else) forEachTaskNode(node.else, visit);
        break;
      case "switch":
        for (const c of node.cases) forEachTaskNode(c.then, visit);
        if (node.default) forEachTaskNode(node.default, visit);
        break;
      case "parallel":
        for (const branch of Object.values(node.branches)) forEachTaskNode(branch.scope, visit);
        break;
      case "fanout":
      case "loop":
        forEachTaskNode(node.do, visit);
        break;
    }
  }
}
