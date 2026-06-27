import type { IrNodeKind, NodeKeyTemplate, OutputMerge } from "./types.js";

/**
 * How a Node's `steps.<id>.output` projects when resolving field paths during
 * static validation:
 * - `schema`   — leaf step: use the compiled output JSON Schema directly.
 * - `payload`  — signal Node: use the declared payload JSON Schema.
 * - `last`     — loop: last child's output (shape resolved lazily, treated dyn).
 * - `array`    — fanout: array of lane outputs (treated dyn past `.output`).
 * - `map`      — parallel: record keyed by branch id (treated dyn past `.output`).
 * - `selected` — if/switch: one selected branch output (dyn).
 * - `decision` — guard: deterministic control decision (dyn).
 * - `opaque`   — pipeline / subworkflow: shape unknown (dyn).
 */
export type OutputShapeKind =
  | "schema"
  | "payload"
  | "last"
  | "array"
  | "map"
  | "selected"
  | "decision"
  | "opaque";

type NodeKeyDimension = keyof Omit<NodeKeyTemplate, "astVersion" | "nodePath">;

/**
 * The single source of truth for each IR Node kind's structural semantics.
 * Both the compiler (IR construction) and the static expression validator read
 * this table, so a new composite is defined in exactly one place. The
 * universality test asserts every `IrNodeKind` has an entry here.
 */
export interface CompositeContract {
  /** `outputMerge` value the compiler stamps on the IR node (omitted when undefined). */
  outputMerge?: OutputMerge;
  /** Node Key template dimension flags this kind contributes. */
  keyDimensions: NodeKeyDimension[];
  /** Local scope roots introduced inside this node's body. */
  bodyLocals: string[];
  /**
   * Config field names (raw-CEL or template) on THIS node that are evaluated in
   * the node's body scope (so they can see `bodyLocals`) rather than its outer
   * scope. e.g. `loop.until` sees `loop`, `fanout.key` sees `item`.
   */
  bodyScopedConfigFields: string[];
  /** Whether `steps.<id>` is referenceable from within this node's own body. */
  selfVisibleInBody: boolean;
  /** How `steps.<id>.output` projects for field-path validation. */
  outputShape: OutputShapeKind;
}

export const COMPOSITE_CONTRACTS: Record<IrNodeKind, CompositeContract> = {
  pipeline: {
    keyDimensions: [],
    bodyLocals: [],
    bodyScopedConfigFields: [],
    selfVisibleInBody: false,
    outputShape: "opaque"
  },
  "run.agent": {
    keyDimensions: [],
    bodyLocals: [],
    bodyScopedConfigFields: [],
    selfVisibleInBody: false,
    outputShape: "schema"
  },
  "run.program": {
    keyDimensions: [],
    bodyLocals: [],
    bodyScopedConfigFields: [],
    selfVisibleInBody: false,
    outputShape: "schema"
  },
  "run.signal": {
    keyDimensions: [],
    bodyLocals: [],
    bodyScopedConfigFields: [],
    selfVisibleInBody: false,
    outputShape: "payload"
  },
  parallel: {
    outputMerge: "map",
    keyDimensions: ["parallelBranchId"],
    bodyLocals: [],
    bodyScopedConfigFields: [],
    selfVisibleInBody: false,
    outputShape: "map"
  },
  fanout: {
    outputMerge: "array",
    keyDimensions: ["fanoutItemId", "laneId"],
    bodyLocals: ["item", "item_id", "item_index"],
    bodyScopedConfigFields: ["key"],
    selfVisibleInBody: false,
    outputShape: "array"
  },
  if: {
    outputMerge: "selected",
    keyDimensions: [],
    bodyLocals: [],
    bodyScopedConfigFields: [],
    selfVisibleInBody: false,
    outputShape: "selected"
  },
  switch: {
    outputMerge: "selected",
    keyDimensions: [],
    bodyLocals: [],
    bodyScopedConfigFields: [],
    selfVisibleInBody: false,
    outputShape: "selected"
  },
  loop: {
    outputMerge: "last",
    keyDimensions: ["loopRound"],
    bodyLocals: ["loop"],
    bodyScopedConfigFields: ["until"],
    selfVisibleInBody: false,
    outputShape: "last"
  },
  guard: {
    keyDimensions: [],
    bodyLocals: [],
    bodyScopedConfigFields: [],
    selfVisibleInBody: false,
    outputShape: "decision"
  },
  subworkflow: {
    keyDimensions: [],
    bodyLocals: [],
    bodyScopedConfigFields: [],
    selfVisibleInBody: false,
    outputShape: "opaque"
  }
};

/** The `outputMerge` value the compiler stamps for a given node kind. */
export function outputMergeFor(kind: IrNodeKind): OutputMerge | undefined {
  return COMPOSITE_CONTRACTS[kind].outputMerge;
}

/** Build a Node Key template, adding the dynamic dimension flags for `kind`. */
export function keyTemplateForKind(kind: IrNodeKind, base: NodeKeyTemplate): NodeKeyTemplate {
  const template: NodeKeyTemplate = { ...base };
  for (const dimension of COMPOSITE_CONTRACTS[kind].keyDimensions) {
    template[dimension] = true;
  }
  return template;
}
