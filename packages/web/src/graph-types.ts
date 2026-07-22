export type WebGraph = {
  workflow: {
    name: string;
    runId?: string;
    status?: string;
  };
  mode: "static" | "runtime";
  nodes: WebGraphNode[];
  containers: WebGraphContainer[];
  edges: WebGraphEdge[];
  fanoutOccurrences: WebGraphFanoutOccurrence[];
  selectors: WebGraphSelector[];
  runtimeStates: WebGraphRuntimeState[];
};

// Compact authored definition rendered by the Inspector.
export type NodeDetail =
  | { kind: "task"; inputs: string[]; target: "inline" | "module" }
  | { kind: "agent"; agent: string; use?: string; command?: string; model?: string; outputSchema?: string }
  | { kind: "signal"; outputSchema?: string }
  | { kind: "assert"; condition: string; message?: string }
  | { kind: "if"; condition: string }
  | { kind: "switch"; cases: string[]; hasDefault: boolean }
  | { kind: "parallel"; branches: string[]; strategy: "all" | "race"; maxConcurrency?: string }
  | { kind: "fanout"; over: string; strategy: "all" | "quorum"; count?: string; maxConcurrency?: string }
  | { kind: "loop"; state: string };

export type WebGraphNode = {
  id: string;
  nodeId: string;
  kind: string;
  label: string;
  path: string[];
  parentId?: string;
  detail?: NodeDetail;
  status: string;
};

export type WebGraphContainer = {
  id: string;
  nodeId: string;
  kind: "branch" | "scope";
  label: string;
  path: string[];
  parentId: string;
  status: string;
};

export type WebGraphEdge = {
  id: string;
  source: string;
  target: string;
  kind: "sequence" | "branch" | "loop";
};

export type WebGraphSelection =
  | { nodeId: string; kind: "fanout"; itemIndex: number }
  | { nodeId: string; kind: "loop"; iteration: number };

export type WebGraphFanoutOccurrence = {
  id: string;
  nodeId: string;
  targetId: string;
  context: WebGraphSelection[];
  status: string;
  items: WebGraphFanoutItemOccurrence[];
};

type WebGraphFanoutItemOccurrence = {
  id: string;
  itemIndex: number;
  label: string;
  status: string;
  context: WebGraphSelection[];
};

export type WebGraphSelector = {
  id: string;
  nodeId: string;
  kind: "loop";
  targetId: string;
  context: WebGraphSelection[];
  defaultOptionId?: string;
  options: WebGraphSelectorOption[];
};

export type WebGraphSelectorOption = {
  id: string;
  iteration: number;
  context: WebGraphSelection[];
};

export type WebGraphRuntimeState = {
  targetId: string;
  status: string;
  context: WebGraphSelection[];
};
