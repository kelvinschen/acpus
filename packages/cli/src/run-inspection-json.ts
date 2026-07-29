import type {
  RunInspectionAction,
  RunInspectionCurrentActivity,
  WatchInspectionEmission,
  HookJournalEntry,
  RunInspectionItem,
  RunInspectionOverviewAction,
  RunInspectionSnapshot,
  RunInspectionSubject,
  RunInspectionTimelineEntry,
} from "@acpus/runtime";
import type { CliInspectionResult } from "./run-inspection-surface.js";
import {
  buildRunInspectionTree,
  type RunInspectionTreeEntry,
  type RunInspectionTreeFold,
  type RunInspectionTreeItem,
} from "./run-inspection-tree.js";

/** The JSON shape intended for people and Agents, rather than Runtime internals. */
export type PresentedInspectionJson = Record<string, unknown>;

/**
 * Removes Runtime occurrence identifiers from ordinary inspection JSON.
 *
 * `raw` is deliberately untouched: it is the explicit diagnostic escape hatch.
 */
export function presentInspectionJson(document: CliInspectionResult): PresentedInspectionJson {
  if (document.kind === "raw") return document;
  if (document.kind === "snapshot") return presentSnapshot(document);
  if (document.kind === "candidates") return { ...document };
  if (document.kind === "target") {
    return {
      ...document,
      subject: presentSubject(document.subject),
      availableActions: presentTargetActions(document.availableActions, document.subject),
    };
  }
  if (document.kind === "timeline") {
    return {
      ...document,
      subject: presentSubject(document.subject),
      current: document.current === undefined ? undefined : presentCurrent(document.current),
      recent: {
        ...document.recent,
        entries: document.recent.entries.map(presentTimelineEntry),
      },
    };
  }
  if (document.kind === "evidence") {
    return { ...document, subject: presentSubject(document.subject) };
  }
  return { ...document };
}

/** Applies the same boundary to NDJSON follow records. */
export function presentInspectionEmissionJson(emission: WatchInspectionEmission): PresentedInspectionJson {
  if (emission.kind === "view") {
    return { ...emission, document: presentInspectionJson(emission.document) };
  }
  return { ...emission, entry: presentTimelineEntry(emission.entry) };
}

function presentSnapshot(snapshot: RunInspectionSnapshot): PresentedInspectionJson {
  const { items, availableActions, ...visible } = snapshot;
  const tree = buildRunInspectionTree(items, { all: snapshot.all === true, actions: availableActions });
  const controls = presentUnscopedControls(availableActions);
  return {
    ...visible,
    run: presentRun(snapshot.run),
    tree: tree.roots.map(entry => presentTreeEntry(entry)),
    ...(controls.length === 0 ? {} : { controls }),
    ...(snapshot.hooks === undefined ? {} : { hooks: snapshot.hooks.map(presentHook) }),
  };
}

function presentTreeEntry(entry: RunInspectionTreeEntry, insideFold = false): PresentedInspectionJson {
  if (entry.type === "fold") return presentTreeFold(entry, insideFold);
  return presentTreeItem(entry, insideFold);
}

function presentTreeItem(entry: RunInspectionTreeItem, insideFold: boolean): PresentedInspectionJson {
  const { actions, controls } = insideFold ? { actions: [], controls: [] } : presentTreeActions(entry);
  return {
    type: "item",
    item: insideFold ? presentFoldItem(entry.item) : presentItem(entry.item),
    children: entry.children.map(child => presentTreeEntry(child, insideFold)),
    ...(actions.length === 0 ? {} : { actions }),
    ...(controls.length === 0 ? {} : { controls }),
  };
}

function presentTreeFold(entry: RunInspectionTreeFold, insideFold: boolean): PresentedInspectionJson {
  const owner = insideFold ? undefined : entry.owner.ref ?? (entry.owner.role === "static" ? entry.owner.nodeId : undefined);
  return {
    type: "fold",
    scope: entry.scope,
    range: entry.range,
    count: entry.count,
    item: presentFoldItem(entry.representative.item),
    children: entry.representative.children.map(child => presentTreeEntry(child, true)),
    ...(owner === undefined ? {} : { owner: { ref: owner } }),
  };
}

function presentFoldItem(item: RunInspectionItem): PresentedInspectionJson {
  const { ref: _ref, signal, ...visible } = presentItem(item);
  if (!signal || typeof signal !== "object") return visible;
  const { target: _target, ...signalVisible } = signal as PresentedInspectionJson;
  return { ...visible, signal: signalVisible };
}

function presentTreeActions(entry: RunInspectionTreeItem): {
  actions: PresentedInspectionJson[];
  controls: PresentedInspectionJson[];
} {
  const target = entry.item.ref ?? (entry.item.role === "static" ? entry.item.nodeId : undefined);
  const exactAttempt = target === undefined || entry.item.attemptNo === undefined
    ? undefined
    : `${target}#${entry.item.attemptNo}`;
  const actions: PresentedInspectionJson[] = [];
  const controls: PresentedInspectionJson[] = [];
  for (const action of entry.actions) {
    if (action.kind === "signal" && target) {
      actions.push({ kind: action.kind, target, ...(action.schemaSummary === undefined ? {} : { schemaSummary: action.schemaSummary }) });
    } else if (action.kind === "retry" && target) {
      controls.push({ kind: action.kind, target });
    } else if (action.kind === "cancel") {
      controls.push({ kind: action.kind, ...(target === undefined ? {} : { target }) });
    } else if (action.kind === "steer" && exactAttempt) {
      controls.push({ kind: action.kind, target: exactAttempt });
    }
  }
  return { actions, controls };
}

function presentUnscopedControls(actions: readonly RunInspectionOverviewAction[]): PresentedInspectionJson[] {
  return actions.flatMap(action => action.kind === "cancel" && action.itemKey === undefined
    ? [{ kind: action.kind }]
    : []);
}

function presentRun(run: RunInspectionSnapshot["run"]): PresentedInspectionJson {
  const { execution, fork, ...visible } = run;
  const { state, lastStatus, reason } = execution;
  return {
    ...visible,
    execution: { state, lastStatus, ...(reason === undefined ? {} : { reason }) },
    ...(fork === undefined ? {} : { fork: presentFork(fork) }),
  };
}

function presentFork(fork: NonNullable<RunInspectionSnapshot["run"]["fork"]>): PresentedInspectionJson {
  const { target: _target, ...visible } = fork;
  return visible;
}

function presentHook(entry: HookJournalEntry): PresentedInspectionJson {
  const { status, handlerId, event, eventSequence, durationMs, exitCode } = entry;
  return {
    status,
    handlerId,
    event,
    eventSequence,
    ...(durationMs === undefined ? {} : { durationMs }),
    ...(exitCode === undefined ? {} : { exitCode }),
  };
}

function presentItem(item: RunInspectionItem): PresentedInspectionJson {
  const {
    key: _key,
    parentKey: _parentKey,
    nodeKey: _nodeKey,
    frameKey: _frameKey,
    attemptId: _attemptId,
    signal,
    ...visible
  } = item;
  return {
    ...visible,
    ...(signal === undefined ? {} : { signal: presentSignal(signal, item.ref) }),
  };
}

function presentSignal(
  signal: NonNullable<RunInspectionItem["signal"]>,
  ref: string | undefined,
): PresentedInspectionJson {
  const { target: _target, ...visible } = signal;
  return { ...visible, ...(ref === undefined ? {} : { target: ref }) };
}

function presentTargetActions(
  actions: readonly RunInspectionAction[],
  subject: RunInspectionSubject,
): PresentedInspectionJson[] {
  const target = subject.ref ?? (subject.targetKind === "static-node" ? subject.id : undefined);
  return actions.map(action => {
    if (!("target" in action)) return { ...action };
    return target === undefined ? omitTarget(action) : { ...action, target };
  });
}

function presentSubject(subject: RunInspectionSubject): PresentedInspectionJson {
  const unsafe = subject as RunInspectionSubject & {
    nodeKey?: string;
    frameKey?: string;
    attemptId?: string;
  };
  const {
    nodeKey: _nodeKey,
    frameKey: _frameKey,
    attemptId: _attemptId,
    id,
    ref,
    ...visible
  } = unsafe;
  return { ...visible, id: ref ?? id, ...(ref === undefined ? {} : { ref }) };
}

function presentCurrent(current: RunInspectionCurrentActivity): PresentedInspectionJson {
  if (current.kind !== "agent") return { ...current };
  const { attemptId: _attemptId, ...visible } = current;
  return visible;
}

function presentTimelineEntry(entry: RunInspectionTimelineEntry): PresentedInspectionJson {
  const { id: _id, attemptId: _attemptId, ...visible } = entry as RunInspectionTimelineEntry & { attemptId?: string };
  return visible;
}

function omitTarget<T extends { target?: string }>(value: T): Omit<T, "target"> {
  const { target: _target, ...visible } = value;
  return visible;
}
