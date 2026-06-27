import type { AcpusIr, AgentOverrideWarning, AgentOverrides, IrNode } from "@acpus/core";
import { hashIrNode } from "@acpus/core";
import type { NodeExecutionState, RunCheckpoint, RunState } from "./types.js";
import { isRunTerminal } from "./types.js";
import type { RunStore } from "./store.js";
import { isNodeKeyAtOrBelow, staticNodePathFromKey } from "./keys.js";
import { validateInput } from "./validate-input.js";
import { buildWorkflowExpressionContext } from "./workflow-context.js";

/**
 * Plan describing how a Forked Run will inherit Nodes from a prior Run.
 *
 * The plan is computed from the prior Run's Run Checkpoints (in `sequence`
 * order) and the new Workflow Spec's compiled IR. The Forked Run inherits each
 * Node whose Node Key exists in the new Spec, whose prior state is `completed`,
 * and whose Node Definition Hash matches; inheritance stops at the first Node
 * that fails any of these checks (the inheritance boundary). The boundary Node
 * (and every Node after it) executes fresh.
 */
export interface ForkPlan {
  /** Run ID of the prior Run we are forking from. */
  sourceRunId: string;
  /** Inherited Node Keys, in checkpoint order (state==="completed", hash match). */
  inheritedNodeKeys: string[];
  /** The default inheritance boundary derived from checkpoint scanning. */
  defaultForkOriginNodeKey: string;
  /** The effective Fork Origin (operator override or default). */
  forkOriginNodeKey: string;
  /** Reason the boundary was placed at the default origin. */
  boundaryReason: BoundaryReason;
}

export type BoundaryReason =
  | "all-completed"        // every checkpoint was inherited; new Run starts after the last
  | "missing-in-new-spec"  // checkpoint's Node Key has no static counterpart in new IR
  | "hash-mismatch"        // matched Node but Node Definition Hash differs
  | "non-completed"        // checkpoint's prior state was not `completed`
  | "operator-override";   // operator forced an earlier origin via override

export interface PlanForkedRunOptions {
  /** Run ID of the prior terminal Run. */
  sourceRunId: string;
  /** Compiled IR of the repaired Workflow Spec. */
  ir: AcpusIr;
  /** Optional operator-selected Fork Origin. */
  overrideOriginNodeKey?: string;
}

export interface MaterializeForkedRunOptions extends PlanForkedRunOptions {
  /** Run ID to assign to the new Forked Run. */
  forkRunId: string;
  /** Explicit input override. When omitted, the source Run input is inherited. */
  input?: Record<string, unknown>;
  /** Catalog ref used to start this Forked Run, when applicable. */
  workflowRef?: string;
  /** Absolute Workflow Spec path used to compile this Forked Run. */
  workflowSourcePath?: string;
  /** Effective submit-time Agent Overrides applied before this Run's IR was frozen. */
  agentOverrides?: AgentOverrides;
  /** Non-fatal warnings produced while resolving submit-time metadata. */
  submissionWarnings?: AgentOverrideWarning[];
  /** True when the Forked Run should preserve a source Run's hook-disabled metadata. */
  skipHooks?: boolean;
  /** Reuse a dry-run Fork Plan when the caller already computed one. */
  plan?: ForkPlan;
}

export interface MaterializedFork {
  /** Initial persisted state of the new Forked Run. */
  run: RunState;
  /** Fork Plan used to materialize the Run. */
  plan: ForkPlan;
  /** Validated input snapshot written for the new Forked Run. */
  input: Record<string, unknown>;
}

interface ForkSource {
  prior: RunState;
  checkpoints: RunCheckpoint[];
  nodeStates: Map<string, NodeExecutionState>;
}

/**
 * Walk a checkpoint Node Key up its static ancestor chain until the ancestor
 * is a top-level Node (parent is the workflow root pipeline) or the workflow
 * root itself. Used so the default Fork Origin never points inside a
 * Composite's body, mirroring the constraint enforced on operator overrides
 * (see ADR-0007 / CONTEXT.md `Fork Origin`).
 *
 * Lifts ONLY when the checkpoint's static path resolves to a Node nested
 * inside a Composite body (`parallel`, `fanout`, `if`, `loop`, `switch`,
 * `subworkflow`). Top-level Nodes and Composite Nodes themselves are returned
 * as-is. Unknown Node Keys (boundary "missing-in-new-spec") fall back to the
 * checkpoint key — those will be re-resolved by the operator anyway.
 */
function liftOutOfComposite(nodeKey: string, irIndex: Map<string, IrNodeIndexEntry>): string {
  const staticPath = staticNodePathFromKey(nodeKey);
  const segments = staticPath.split("/");
  let sawGenerated = false;
  for (let i = segments.length; i >= 1; i--) {
    const candidatePath = segments.slice(0, i).join("/");
    const entry = irIndex.get(candidatePath);
    if (!entry) continue;
    if (entry.node.metadata.generated === true) {
      sawGenerated = true;
      continue;
    }
    if (!entry.parentKind) {
      return candidatePath;
    }
    if (entry.parentKind === "pipeline" && entry.parentGenerated !== true && (!sawGenerated || isCompositeKind(entry.node.kind))) {
      return candidatePath;
    }
  }
  return nodeKey;
}

function isCompositeKind(kind: IrNode["kind"]): boolean {
  return kind === "pipeline" || kind === "parallel" || kind === "fanout" || kind === "if" || kind === "switch" || kind === "loop" || kind === "subworkflow";
}

interface IrNodeIndexEntry {
  node: IrNode;
  parentKind?: IrNode["kind"];
  parentGenerated?: boolean;
}

/**
 * Walk the IR collecting one entry per static Node, keyed by its joined
 * `nodePath`. Composite container Nodes are themselves indexed (so they can
 * appear in the "valid Fork Origin" set when their parent is a pipeline);
 * Nodes nested inside Composite bodies (parallel/fanout/if/loop/switch) are also
 * indexed but flagged as not eligible for Fork Origin via parentKind.
 */
function indexIrNodes(ir: AcpusIr): Map<string, IrNodeIndexEntry> {
  const out = new Map<string, IrNodeIndexEntry>();
  const visit = (node: IrNode, parentKind?: IrNode["kind"], parentGenerated?: boolean): void => {
    out.set(node.nodePath.join("/"), { node, parentKind, parentGenerated });
    for (const child of node.children ?? []) {
      visit(child, node.kind, node.metadata.generated === true);
    }
    for (const branch of node.branches ?? []) {
      visit(branch.child, node.kind, node.metadata.generated === true);
    }
  };
  visit(ir.root);
  return out;
}

/**
 * Compute the fork plan. Pure: never mutates state and never creates Runs.
 *
 * @param prior     prior Run metadata (must be in a terminal state)
 * @param checkpoints  prior Run's ordered Run Checkpoints
 * @param priorNodeStates source Run node states, used for control-flow ancestor hashes
 * @param newIr     compiled IR of the new (possibly modified) Workflow Spec
 * @param overrideOriginNodeKey  optional operator-specified Fork Origin
 */
function computeForkPlan(
  prior: RunState,
  checkpoints: RunCheckpoint[],
  priorNodeStates: Map<string, NodeExecutionState>,
  newIr: AcpusIr,
  overrideOriginNodeKey?: string
): ForkPlan {
  if (!isRunTerminal(prior.status)) {
    throw new ForkError(`Cannot fork run ${prior.runId}: source Run is in non-terminal state '${prior.status}'`);
  }

  const irIndex = indexIrNodes(newIr);
  const inheritedNodeKeys: string[] = [];
  let defaultOrigin: string | undefined;
  let boundaryReason: BoundaryReason = "all-completed";

  for (const checkpoint of checkpoints) {
    const staticPath = staticNodePathFromKey(checkpoint.nodeKey);
    const irEntry = irIndex.get(staticPath);
    if (!irEntry) {
      defaultOrigin = liftOutOfComposite(checkpoint.nodeKey, irIndex);
      boundaryReason = "missing-in-new-spec";
      break;
    }
    const changedBranchingAncestor = changedBranchingAncestorNodeKey(checkpoint.nodeKey, irIndex, priorNodeStates, newIr);
    if (changedBranchingAncestor) {
      defaultOrigin = liftOutOfComposite(changedBranchingAncestor, irIndex);
      boundaryReason = "hash-mismatch";
      break;
    }
    if (checkpoint.state !== "completed") {
      defaultOrigin = liftOutOfComposite(checkpoint.nodeKey, irIndex);
      boundaryReason = "non-completed";
      break;
    }
    const newHash = hashIrNode(irEntry.node, { workflow: buildWorkflowExpressionContext(newIr) });
    if (newHash !== checkpoint.definitionHash) {
      defaultOrigin = liftOutOfComposite(checkpoint.nodeKey, irIndex);
      boundaryReason = "hash-mismatch";
      break;
    }
    inheritedNodeKeys.push(checkpoint.nodeKey);
  }

  if (!defaultOrigin) {
    // Every checkpoint inherited. The fork origin is the first Node not yet
    // covered by checkpoints — i.e. the next not-yet-inherited Node in the new
    // IR. We can't pinpoint that statically (the schedule depends on dynamic
    // context), so use the workflow root as the fallback origin: applyFork
    // simply does not pre-mark any further inheritance, and the interpreter
    // proceeds with normal Node-by-Node execution which short-circuits on the
    // already-inherited completed nodes.
    defaultOrigin = newIr.root.nodePath.join("/");
  }

  const defaultForkOriginNodeKey = defaultOrigin;
  const forkOriginNodeKey = overrideOriginNodeKey ?? defaultForkOriginNodeKey;
  const reason: BoundaryReason = overrideOriginNodeKey ? "operator-override" : boundaryReason;

  // Validate operator override: it MUST address a Node that exists in the new
  // IR and whose parent is a pipeline (top-level or directly under a
  // pipeline-kind container). Composite-body Nodes are forbidden.
  if (overrideOriginNodeKey) {
    const overrideStatic = staticNodePathFromKey(overrideOriginNodeKey);
    const overrideEntry = irIndex.get(overrideStatic);
    if (!overrideEntry) {
      throw new ForkError(`Fork origin override '${overrideOriginNodeKey}' has no matching Node in the new Workflow Spec`);
    }
    if (overrideEntry.parentKind && overrideEntry.parentKind !== "pipeline") {
      throw new ForkError(
        `Fork origin override '${overrideOriginNodeKey}' is inside a Composite '${overrideEntry.parentKind}' body; choose the surrounding Composite or an ancestor instead`
      );
    }
    // Drop every inherited Node from the first occurrence of the override (or
    // any descendant of it) onward. Because checkpoints are monotone in
    // completion time, anything appearing later in the inherited list may
    // have consumed state produced at or below the override and MUST be
    // re-executed. Independent siblings that happened to complete before the
    // override remain inherited.
    const overrideIndex = inheritedNodeKeys.findIndex((key) => {
      return isNodeKeyAtOrBelow(key, overrideStatic);
    });
    if (overrideIndex >= 0) {
      inheritedNodeKeys.splice(overrideIndex);
    }
  }

  return {
    sourceRunId: prior.runId,
    inheritedNodeKeys,
    defaultForkOriginNodeKey,
    forkOriginNodeKey,
    boundaryReason: reason
  };
}

export function planForkedRun(store: RunStore, options: PlanForkedRunOptions): ForkPlan {
  const source = readForkSource(store, options.sourceRunId);
  return computeForkPlan(source.prior, source.checkpoints, source.nodeStates, options.ir, options.overrideOriginNodeKey);
}

/**
 * Materialize a Forked Run on disk. The caller is expected to have already
 * computed or accepted a Fork Plan. This routine copies the inherited Node
 * states and artifacts from the source Run into the new Run, and registers
 * each as a Run Checkpoint in the new Run's index.
 */
function applyFork(
  store: RunStore,
  forkRunId: string,
  plan: ForkPlan
): void {
  for (const nodeKey of plan.inheritedNodeKeys) {
    store.inheritNodeFromRun(forkRunId, plan.sourceRunId, nodeKey);
  }
}

/**
 * Materialize a Forked Run on disk from a previously computed Fork Plan.
 *
 * This is the stateful counterpart to {@link planForkedRun}: it creates the
 * new Run, inherits the source input unless the operator supplied an override,
 * copies inherited Node states and artifacts through RunStore, and persists
 * immediate prior lineage on the new Run.
 */
export function materializeForkedRun(
  store: RunStore,
  options: MaterializeForkedRunOptions
): MaterializedFork {
  const plan = options.plan ?? planForkedRun(store, {
    sourceRunId: options.sourceRunId,
    ir: options.ir,
    overrideOriginNodeKey: options.overrideOriginNodeKey
  });
  if (plan.sourceRunId !== options.sourceRunId) {
    throw new ForkError(`Fork Plan source Run '${plan.sourceRunId}' does not match requested source Run '${options.sourceRunId}'`);
  }

  const sourceInput = store.readInput(plan.sourceRunId) ?? {};
  const input = validateInput(options.ir.input, options.input ?? sourceInput);
  const run = store.initRun(options.forkRunId, options.ir, input, {
    workflowRef: options.workflowRef,
    workflowSourcePath: options.workflowSourcePath,
    agentOverrides: options.agentOverrides,
    submissionWarnings: options.submissionWarnings,
    skipHooks: options.skipHooks
  });

  try {
    applyFork(store, options.forkRunId, plan);
  } catch (error) {
    const meta = store.readRunMeta(options.forkRunId);
    if (meta) {
      meta.status = "cancelled";
      meta.updatedAt = new Date().toISOString();
      meta.lineage = {
        sourceRunId: plan.sourceRunId,
        forkOriginNodeKey: plan.forkOriginNodeKey,
        inheritedNodeCount: 0
      };
      store.writeRunMeta(options.forkRunId, meta);
    }
    throw error;
  }

  const meta = store.readRunMeta(options.forkRunId);
  if (meta) {
    meta.lineage = {
      sourceRunId: plan.sourceRunId,
      forkOriginNodeKey: plan.forkOriginNodeKey,
      inheritedNodeCount: plan.inheritedNodeKeys.length
    };
    // Inherit the source Run's frozen hook configuration so the Forked Run
    // observes and injects under the same hooks as its origin.
    const hookSnapshot = store.readHookConfig(plan.sourceRunId);
    if (hookSnapshot) {
      store.writeHookConfig(options.forkRunId, hookSnapshot);
      meta.hookConfigHash = hookSnapshot.hash;
    }
    store.writeRunMeta(options.forkRunId, meta);
  }

  // Re-read the run meta after writing lineage so the returned object
  // includes the lineage (M5 fix).
  const updatedMeta = store.readRunMeta(options.forkRunId);
  return { run: updatedMeta ?? run, plan, input };
}

function readForkSource(store: RunStore, sourceRunId: string): ForkSource {
  const prior = store.readRunMeta(sourceRunId);
  if (!prior) {
    throw new ForkError(`Run not found: ${sourceRunId}`);
  }
  if (!isRunTerminal(prior.status)) {
    throw new ForkError(`Cannot fork run ${prior.runId}: source Run is in non-terminal state '${prior.status}'`);
  }
  if (!store.hasCheckpointIndex(sourceRunId)) {
    throw new ForkError("Run has no checkpoint index");
  }
  return {
    prior,
    checkpoints: store.readCheckpoints(sourceRunId),
    nodeStates: new Map(store.listNodeStates(sourceRunId).map((state) => [state.nodeKey, state]))
  };
}

function changedBranchingAncestorNodeKey(
  nodeKey: string,
  irIndex: Map<string, IrNodeIndexEntry>,
  priorNodeStates: Map<string, NodeExecutionState>,
  newIr: AcpusIr
): string | undefined {
  const workflow = buildWorkflowExpressionContext(newIr);
  const staticPath = staticNodePathFromKey(nodeKey);
  const segments = staticPath.split("/");
  for (let i = 1; i < segments.length; i++) {
    const ancestorStaticPath = segments.slice(0, i).join("/");
    const ancestor = irIndex.get(ancestorStaticPath)?.node;
    if (ancestor?.kind !== "if" && ancestor?.kind !== "switch") continue;
    const ancestorNodeKey = nodeKeyWithSameDynamics(nodeKey, ancestorStaticPath);
    const priorState = priorNodeStates.get(ancestorNodeKey);
    if (priorState?.definitionHash && priorState.definitionHash !== hashIrNode(ancestor, { workflow })) {
      return ancestorNodeKey;
    }
  }
  return undefined;
}

function nodeKeyWithSameDynamics(nodeKey: string, staticPath: string): string {
  const dynamicSegments = nodeKey.split("/").filter((segment) => /^(item|lane|round|branch):/u.test(segment));
  return [staticPath, ...dynamicSegments].join("/");
}

export class ForkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ForkError";
  }
}
