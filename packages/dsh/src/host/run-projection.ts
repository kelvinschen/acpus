import { createHash } from "node:crypto";
import type { InspectionCounts, InspectionView } from "@acpus/runtime";
import type { JsonValue } from "@acpus/expression/ir";
import type { AdmittedRunLink } from "./run-links.js";

type InspectionTreeEntry = Extract<InspectionView, { kind: "run" }>["tree"][number];
type InspectionVisibleState = Extract<InspectionTreeEntry, { type: "item" }>["state"];

type StoredSignalRequirement = {
  selector: string;
  prompt?: string;
  expected?: string;
};

export type StoredActivityNode = {
  key: string;
  activityId: string;
  target?: string;
  label: string;
  kind: string;
  status: InspectionVisibleState["status"];
  startedAt?: string;
  durationMs?: number;
  progress?: { completed: number; total: number };
  agent?: {
    name?: string;
    phase?: NonNullable<Extract<InspectionTreeEntry, { type: "item" }>["pulse"]>["phase"];
    turn?: number;
    tool?: {
      name: string;
      title?: string;
      state: "running" | "completed" | "failed" | "canceled";
    };
    telemetry?: {
      inputTokens?: number;
      outputTokens?: number;
      totalTokens?: number;
      contextWindow?: {
        used: number;
        size: number;
      };
    };
  };
  children: StoredActivityNode[];
};

export type StoredRunProjection = {
  runId: string;
  workspace: string;
  admissionRequestId: string;
  generation: number;
  occurrence: number;
  forkedFromGeneration?: number;
  name: string;
  status: Extract<InspectionView, { kind: "run" }>["run"]["status"];
  counts: InspectionCounts;
  createdAt: string;
  updatedAt: string;
  activity: StoredActivityNode[];
  failure?: {
    origin: string;
    code?: string;
    message: string;
  };
  actionRequirement?: StoredSignalRequirement;
  terminal?: {
    output?: {
      text: string;
      truncated: boolean;
    };
  };
};

const STORED_OUTPUT_LIMIT = 65_536;

export function projectStoredRun(
  link: AdmittedRunLink,
  view: Extract<InspectionView, { kind: "run" }>,
): StoredRunProjection {
  const terminalStatusValue = terminalStatus(view.run.status);
  const actionRequirement = terminalStatusValue ? undefined : findSignalRequirement(view.tree);
  const terminal = terminalStatusValue
    ? {
        ...(view.output === undefined
          ? {}
          : { output: boundedJson(view.output, STORED_OUTPUT_LIMIT) }),
      }
    : undefined;
  return {
    runId: view.run.id,
    workspace: link.workspace,
    admissionRequestId: link.admissionRequestId,
    generation: link.generation,
    occurrence: link.occurrence,
    ...(link.forkedFromGeneration === undefined
      ? {}
      : { forkedFromGeneration: link.forkedFromGeneration }),
    name: view.run.name,
    status: view.run.status,
    counts: view.counts,
    createdAt: view.run.createdAt,
    updatedAt: view.run.updatedAt,
    activity: projectActivityTree(view.tree, view.run.updatedAt, view.run.id),
    ...(view.run.failure === undefined ? {} : { failure: view.run.failure }),
    ...(actionRequirement === undefined ? {} : { actionRequirement }),
    ...(terminal === undefined ? {} : { terminal }),
  };
}

export function preserveActivityStarts(
  current: StoredRunProjection,
  previous: StoredRunProjection | undefined,
): StoredRunProjection {
  if (previous === undefined) return current;
  const starts = new Map<string, string>();
  visitActivity(previous.activity, node => {
    if (node.startedAt !== undefined && activeStatus(node.status)) {
      starts.set(node.key, node.startedAt);
    }
  });
  return {
    ...current,
    activity: mapActivity(current.activity, node => {
      if (node.startedAt === undefined || !activeStatus(node.status)) {
        return node;
      }
      const startedAt = starts.get(node.key);
      return startedAt === undefined ? node : { ...node, startedAt };
    }),
  };
}

export function isTerminalProjection(projection: StoredRunProjection): boolean {
  return terminalStatus(projection.status);
}

export function isParkedProjection(projection: StoredRunProjection): boolean {
  return projection.status === "paused" || projection.actionRequirement !== undefined;
}

export function findStoredActivityNode(
  nodes: readonly StoredActivityNode[],
  activityId: string,
): StoredActivityNode | undefined {
  for (const node of nodes) {
    if (node.activityId === activityId) return node;
    const nested = findStoredActivityNode(node.children, activityId);
    if (nested !== undefined) return nested;
  }
  return undefined;
}

function findSignalRequirement(
  tree: Extract<InspectionView, { kind: "run" }>["tree"],
): StoredSignalRequirement | undefined {
  for (const entry of tree) {
    if (entry.type === "item" && entry.attention?.kind === "awaiting-input") {
      return {
        selector: entry.attention.signal,
        ...(entry.attention.prompt === undefined ? {} : { prompt: entry.attention.prompt }),
        ...(entry.attention.expected === undefined ? {} : { expected: entry.attention.expected }),
      };
    }
    const nested = findSignalRequirement(entry.children);
    if (nested !== undefined) return nested;
  }
  return undefined;
}

function projectActivityTree(
  entries: readonly InspectionTreeEntry[],
  observedAt: string,
  runId: string,
  parent = "root",
): StoredActivityNode[] {
  return entries.map((entry, index): StoredActivityNode => {
    if (entry.type === "fold") {
      throw new Error("Materialized Runtime inspection returned a folded tree entry.");
    }
    const key = entry.subject.selector
      ?? `${parent}/${entry.subject.kind}:${entry.subject.label}:${index}`;
    return {
      key,
      activityId: activityId(runId, key),
      ...(entry.subject.selector === undefined ? {} : { target: entry.subject.selector }),
      label: entry.subject.label,
      kind: entry.subject.kind,
      status: entry.state.status,
      ...(activeStatus(entry.state.status) ? { startedAt: observedAt } : {}),
      ...(entry.state.durationMs === undefined ? {} : { durationMs: entry.state.durationMs }),
      ...(entry.progress === undefined ? {} : { progress: entry.progress }),
      ...(entry.agent === undefined && entry.pulse === undefined
        ? {}
        : {
            agent: {
              ...(entry.agent === undefined ? {} : { name: entry.agent.name }),
              ...(entry.pulse === undefined ? {} : { phase: entry.pulse.phase }),
              ...(entry.pulse?.turn === undefined ? {} : { turn: entry.pulse.turn }),
              ...(entry.pulse?.tool === undefined ? {} : { tool: entry.pulse.tool }),
              ...(entry.agent?.telemetry === undefined
                ? {}
                : { telemetry: entry.agent.telemetry }),
            },
          }),
      children: projectActivityTree(entry.children, observedAt, runId, key),
    };
  });
}

function activityId(runId: string, key: string): string {
  return createHash("sha256")
    .update(runId)
    .update("\0")
    .update(key)
    .digest("hex")
    .slice(0, 32);
}

function activeStatus(status: string): boolean {
  return status === "pending"
    || status === "starting"
    || status === "ready"
    || status === "running"
    || status === "awaiting"
    || status === "mixed";
}

function visitActivity(
  nodes: readonly StoredActivityNode[],
  visit: (node: StoredActivityNode) => void,
): void {
  for (const node of nodes) {
    visit(node);
    visitActivity(node.children, visit);
  }
}

function mapActivity(
  nodes: readonly StoredActivityNode[],
  map: (node: StoredActivityNode) => StoredActivityNode,
): StoredActivityNode[] {
  return nodes.map(node => {
    const mapped = map(node);
    return { ...mapped, children: mapActivity(mapped.children, map) };
  });
}

function terminalStatus(status: string): boolean {
  return status === "completed" || status === "failed" || status === "canceled";
}

function boundedJson(value: JsonValue, limit: number): { text: string; truncated: boolean } {
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text, "utf8") <= limit) {
    return { text, truncated: false };
  }
  return {
    text: Buffer.from(text)
      .subarray(0, limit)
      .toString("utf8")
      .replace(/\uFFFD$/u, ""),
    truncated: true,
  };
}
