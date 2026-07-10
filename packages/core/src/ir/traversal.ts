import type {
  FanoutNodeIR,
  IfNodeIR,
  LoopNodeIR,
  LoopTransitionScopeIR,
  NodeIR,
  ParallelNodeIR,
  ScopeIR,
  SwitchNodeIR,
} from "./types.js";

export type NodeChildScope =
  | { kind: "if"; owner: IfNodeIR; branchId: "then" | "else"; scope: ScopeIR }
  | { kind: "switch"; owner: SwitchNodeIR; branchId: `case:${number}` | "default"; scope: ScopeIR }
  | { kind: "parallel"; owner: ParallelNodeIR; branchId: string; scope: ScopeIR }
  | { kind: "fanout"; owner: FanoutNodeIR; scope: ScopeIR }
  | { kind: "loop"; owner: LoopNodeIR; scope: LoopTransitionScopeIR };

export type NodeVisit = {
  node: NodeIR;
  ancestry: readonly NodeChildScope[];
};

export function childScopes(node: NodeIR): readonly NodeChildScope[] {
  switch (node.kind) {
    case "agent":
    case "task":
    case "signal":
    case "assert":
      return [];
    case "if":
      return [
        { kind: "if", owner: node, branchId: "then", scope: node.then },
        { kind: "if", owner: node, branchId: "else", scope: node.else },
      ];
    case "switch":
      return [
        ...node.cases.map((item, index) => ({
          kind: "switch" as const,
          owner: node,
          branchId: `case:${index}` as const,
          scope: item.then,
        })),
        { kind: "switch", owner: node, branchId: "default", scope: node.default },
      ];
    case "parallel":
      return Object.entries(node.branches).map(([branchId, branch]) => ({
        kind: "parallel",
        owner: node,
        branchId,
        scope: branch.scope,
      }));
    case "fanout":
      return [{ kind: "fanout", owner: node, scope: node.do }];
    case "loop":
      return [{ kind: "loop", owner: node, scope: node.do }];
    default:
      return assertNever(node);
  }
}

export function* walkNodes(scope: ScopeIR): IterableIterator<NodeVisit> {
  yield* walkScope(scope, []);
}

function* walkScope(scope: ScopeIR, ancestry: readonly NodeChildScope[]): IterableIterator<NodeVisit> {
  for (const node of scope.nodes) {
    yield { node, ancestry };
    for (const child of childScopes(node)) {
      yield* walkScope(child.scope, [...ancestry, child]);
    }
  }
}

function assertNever(value: never): never {
  throw new Error(`Unhandled WorkflowIR node: ${String(value)}`);
}
