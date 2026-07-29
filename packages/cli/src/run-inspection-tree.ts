import type { RunInspectionItem, RunInspectionOverviewAction } from "@acpus/runtime";

/** CLI-private compact topology used by text and ordinary inspection JSON. */
export type RunInspectionTree = {
  roots: readonly RunInspectionTreeEntry[];
  itemsByKey: ReadonlyMap<string, RunInspectionItem>;
};

export type RunInspectionTreeEntry = RunInspectionTreeItem | RunInspectionTreeFold;

export type RunInspectionTreeItem = {
  type: "item";
  item: RunInspectionItem;
  actions: readonly RunInspectionOverviewAction[];
  children: readonly RunInspectionTreeEntry[];
};

export type RunInspectionTreeFold = {
  type: "fold";
  scope: "fanout_item" | "loop_iteration";
  range: { start: number; end: number };
  count: number;
  owner: RunInspectionItem;
  representative: RunInspectionTreeItem;
};

export type RunInspectionTreeAttention = {
  item: RunInspectionTreeItem;
  fold?: RunInspectionTreeFold;
};

export type RunInspectionTreeOptions = {
  all?: boolean;
  actions?: readonly RunInspectionOverviewAction[];
};

/**
 * Builds one nested, presentation-owned view of Runtime's lossless items.
 *
 * The interface intentionally takes the lossless flat list and returns the
 * only topology consumers need: all equivalent dynamic siblings are folded at
 * this seam, while `all` keeps every occurrence expanded.
 */
export function buildRunInspectionTree(
  items: readonly RunInspectionItem[],
  options: RunInspectionTreeOptions = {},
): RunInspectionTree {
  const itemsByKey = new Map(items.map(item => [item.key, item]));
  const childrenByKey = new Map<string, RunInspectionItem[]>();
  const roots: RunInspectionItem[] = [];
  for (const item of items) {
    if (item.parentKey && item.parentKey !== item.key && itemsByKey.has(item.parentKey)) {
      const children = childrenByKey.get(item.parentKey);
      if (children) children.push(item);
      else childrenByKey.set(item.parentKey, [item]);
    } else {
      roots.push(item);
    }
  }

  const actionsByItemKey = indexActions(options.actions ?? []);
  const emitted = new Set<string>();
  const build = (item: RunInspectionItem, ancestors: ReadonlySet<string>): RunInspectionTreeItem => {
    emitted.add(item.key);
    const nextAncestors = new Set(ancestors);
    nextAncestors.add(item.key);
    const children = (childrenByKey.get(item.key) ?? [])
      .filter(child => !nextAncestors.has(child.key))
      .map(child => build(child, nextAncestors));
    return {
      type: "item",
      item,
      actions: actionsByItemKey.get(item.key) ?? [],
      children: options.all ? children : foldSiblingContexts(children, item),
    };
  };

  const treeRoots = roots.map(item => build(item, new Set<string>()));
  // Runtime projects a tree. Retaining this defensive fallback means a malformed
  // parent relation remains observable instead of silently disappearing.
  for (const item of items) if (!emitted.has(item.key)) treeRoots.push(build(item, new Set<string>()));
  return { roots: options.all ? treeRoots : foldSiblingContexts(treeRoots), itemsByKey };
}

/** Returns every visible hard state; it deliberately performs no causal suppression. */
export function inspectionTreeAttention(tree: RunInspectionTree): readonly RunInspectionTreeAttention[] {
  const attention: RunInspectionTreeAttention[] = [];
  const visit = (entries: readonly RunInspectionTreeEntry[], enclosingFold?: RunInspectionTreeFold): void => {
    for (const entry of entries) {
      if (entry.type === "fold") {
        visit([entry.representative], enclosingFold ?? entry);
        continue;
      }
      if (attentionStatus(entry.item.status)) attention.push({ item: entry, ...(enclosingFold ? { fold: enclosingFold } : {}) });
      visit(entry.children, enclosingFold);
    }
  };
  visit(tree.roots);
  return attention;
}

function indexActions(actions: readonly RunInspectionOverviewAction[]): Map<string, RunInspectionOverviewAction[]> {
  const byItemKey = new Map<string, RunInspectionOverviewAction[]>();
  for (const action of actions) {
    if (!("itemKey" in action) || action.itemKey === undefined) continue;
    const itemActions = byItemKey.get(action.itemKey);
    if (itemActions) itemActions.push(action);
    else byItemKey.set(action.itemKey, [action]);
  }
  return byItemKey;
}

function foldSiblingContexts(
  siblings: readonly RunInspectionTreeItem[],
  owner?: RunInspectionItem,
): RunInspectionTreeEntry[] {
  if (!owner) return [...siblings];
  const result: RunInspectionTreeEntry[] = [];
  const signatures = new WeakMap<RunInspectionTreeItem, string>();
  let index = 0;
  while (index < siblings.length) {
    const first = siblings[index]!;
    const scope = repeatedScope(first.item);
    if (!scope) {
      result.push(first);
      index += 1;
      continue;
    }
    const signature = visibleSignature(first, signatures);
    let end = index + 1;
    let previous = scope.sequence;
    while (end < siblings.length) {
      const candidate = siblings[end]!;
      const candidateScope = repeatedScope(candidate.item);
      if (!candidateScope
        || candidateScope.kind !== scope.kind
        || candidateScope.sequence !== previous + 1
        || visibleSignature(candidate, signatures) !== signature) break;
      previous = candidateScope.sequence;
      end += 1;
    }
    const count = end - index;
    if (count >= 4) {
      result.push({
        type: "fold",
        scope: scope.kind,
        range: { start: scope.display, end: repeatedScope(siblings[end - 1]!.item)!.display },
        count,
        owner,
        representative: first,
      });
    } else {
      result.push(...siblings.slice(index, end));
    }
    index = end;
  }
  return result;
}

function repeatedScope(item: RunInspectionItem): { kind: "fanout_item" | "loop_iteration"; sequence: number; display: number } | undefined {
  if (item.role !== "context" || !item.scope) return undefined;
  if (item.scope.kind === "fanout_item") {
    return { kind: item.scope.kind, sequence: item.scope.itemIndex, display: item.scope.itemIndex };
  }
  if (item.scope.kind === "loop_iteration") {
    return { kind: item.scope.kind, sequence: item.scope.iteration, display: item.scope.round };
  }
  return undefined;
}

function visibleSignature(
  entry: RunInspectionTreeItem,
  cache: WeakMap<RunInspectionTreeItem, string>,
): string {
  const cached = cache.get(entry);
  if (cached !== undefined) return cached;
  const signature = JSON.stringify({
    item: visibleItem(entry.item),
    actions: entry.actions.map(visibleAction).sort(compareJson),
    children: entry.children.map(child => child.type === "item"
      ? visibleSignature(child, cache)
      : {
        fold: child.scope,
        count: child.count,
        item: visibleSignature(child.representative, cache),
      }),
  });
  cache.set(entry, signature);
  return signature;
}

function visibleItem(item: RunInspectionItem): unknown {
  return {
    role: item.role,
    label: repeatedScope(item) ? undefined : item.label,
    kind: item.kind,
    nodeId: item.nodeId,
    status: item.status,
    statusReason: item.statusReason,
    attemptNo: item.attemptNo,
    failure: stableValue(item.failure),
    agent: item.agent === undefined ? undefined : {
      key: item.agent.key,
      turn: item.agent.turn,
      activeTool: item.agent.activeTool === undefined ? undefined : {
        command: item.agent.activeTool.command,
        status: item.agent.activeTool.status,
      },
    },
    task: stableValue(item.task),
    signal: item.signal === undefined ? undefined : {
      promptPreview: item.signal.promptPreview,
      schemaSummary: item.signal.schemaSummary,
      outputSchema: stableValue(item.signal.outputSchema),
    },
    composite: stableValue(item.composite),
    scope: visibleScope(item.scope),
  };
}

function visibleScope(scope: RunInspectionItem["scope"]): unknown {
  if (!scope) return undefined;
  if (scope.kind === "fanout_item" || scope.kind === "loop_iteration") {
    return { kind: scope.kind, empty: scope.empty };
  }
  return {
    kind: scope.kind,
    ownerKind: scope.ownerKind,
    branchId: scope.branchId,
    ...(scope.ownerKind === "parallel" ? {} : { selection: scope.selection }),
    empty: scope.empty,
  };
}

function visibleAction(action: RunInspectionOverviewAction): unknown {
  if (action.kind === "signal") return { kind: action.kind, schemaSummary: action.schemaSummary };
  return { kind: action.kind };
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, stableValue(entry)]));
  }
  return value;
}

function compareJson(left: unknown, right: unknown): number {
  return JSON.stringify(left).localeCompare(JSON.stringify(right));
}

function attentionStatus(status: RunInspectionItem["status"]): boolean {
  return status === "awaiting" || status === "failed" || status === "timed_out";
}
