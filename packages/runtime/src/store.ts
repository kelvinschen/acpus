import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  rmSync,
  readdirSync,
  readFileSync,
  renameSync,
  lstatSync,
  writeFileSync
} from "node:fs";
import { dirname, join } from "node:path";
import { encodeNodeKeyForFs, encodeNodeKeyForDir } from "./keys.js";
import { ArtifactReferences } from "./artifacts.js";
import type { AcpusIr, AgentOverrideWarning, AgentOverrides } from "@acpus/core";
import type { AgentTelemetry, NodeExecutionState, RunCheckpoint, RunCleanItem, RunCleanResult, RunState } from "./types.js";
import { isRunTerminal } from "./types.js";

/**
 * Per-node JSON file persistence with write-to-temp-then-rename for crash safety.
 *
 * Directory layout:
 *   .acpus/state/
 *     runs/
 *       <run_id>/
 *         ir.json            # frozen IR snapshot
 *         input.json         # resolved input
 *         run-meta.json      # RunState
 *         nodes/
 *           workflow:step-a.json      # NodeExecutionState
 *           workflow:mapped:item:0:lane:0.json
 *         artifacts/
 *           workflow:step-a/
 *             transcript.json
 *             stdout.txt
 */
/**
 * Validate a runId is safe for filesystem path construction.
 * Rejects path traversal (..), path separators, and null bytes.
 * Does NOT require strict UUID format — tests may use short IDs like "run-1".
 */
const UNSAFE_RUN_ID = /(^|\/)\.\.?(\/|$)|[\\:\0]/;

function validateRunId(runId: string): void {
  if (!runId || UNSAFE_RUN_ID.test(runId)) {
    throw new Error(`Invalid runId: '${runId}' contains unsafe path characters`);
  }
}

export class RunStore {
  private readonly baseDir: string;

  constructor(baseDir?: string) {
    this.baseDir = baseDir ?? join(process.cwd(), ".acpus", "state", "runs");
  }

  // ─── Run lifecycle ─────────────────────────────────────────────

  /** Create a new run directory and write IR + input snapshots. */
  initRun(
    runId: string,
    ir: AcpusIr,
    input: Record<string, unknown>,
    source?: {
      workflowRef?: string;
      workflowSourcePath?: string;
      lineage?: import("./types.js").RunLineage;
      agentOverrides?: AgentOverrides;
      submissionWarnings?: AgentOverrideWarning[];
    }
  ): RunState {
    validateRunId(runId);
    const runDir = this.runDir(runId);
    mkdirSync(join(runDir, "nodes"), { recursive: true });
    mkdirSync(join(runDir, "artifacts"), { recursive: true });

    const irJson = JSON.stringify(ir, null, 2);
    const inputJson = JSON.stringify(input, null, 2);
    const irDigest = sha256(irJson);
    const inputDigest = sha256(inputJson);

    writeFileSync(join(runDir, "ir.json"), irJson, "utf8");
    writeFileSync(join(runDir, "input.json"), inputJson, "utf8");

    const now = new Date().toISOString();
    const meta: RunState = {
      runId,
      workflowName: ir.name,
      workflowRef: source?.workflowRef,
      workflowSourcePath: source?.workflowSourcePath ?? ir.source.path,
      status: "running",
      irDigest,
      inputDigest,
      createdAt: now,
      updatedAt: now,
      runAttempt: 1,
      lineage: source?.lineage,
      agentOverrides: source?.agentOverrides,
      submissionWarnings: source?.submissionWarnings
    };
    this.writeRunMeta(runId, meta);
    // Empty checkpoints index — appended to as Nodes reach terminal state.
    this.atomicWriteJson(this.checkpointsIndexPath(runId), [] as RunCheckpoint[]);
    return meta;
  }

  /** Read the frozen IR snapshot for a run. */
  readIr(runId: string): AcpusIr | undefined {
    validateRunId(runId);
    return this.readJson<AcpusIr>(join(this.runDir(runId), "ir.json"));
  }

  /** Read the resolved input for a run. */
  readInput(runId: string): Record<string, unknown> | undefined {
    validateRunId(runId);
    return this.readJson<Record<string, unknown>>(join(this.runDir(runId), "input.json"));
  }

  // ─── Run metadata ──────────────────────────────────────────────

  writeRunMeta(runId: string, meta: RunState): void {
    validateRunId(runId);
    this.atomicWriteJson(join(this.runDir(runId), "run-meta.json"), meta);
  }

  readRunMeta(runId: string): RunState | undefined {
    validateRunId(runId);
    return this.readJson<RunState>(join(this.runDir(runId), "run-meta.json"));
  }

  // ─── Node state ────────────────────────────────────────────────

  /** Atomically write node execution state. */
  writeNodeState(runId: string, state: NodeExecutionState): void {
    validateRunId(runId);
    const filename = encodeNodeKeyForFs(state.nodeKey);
    this.atomicWriteJson(join(this.runDir(runId), "nodes", filename), state);
    if (isTerminal(state.state) && state.definitionHash && isCheckpointableKind(state.kind)) {
      this.appendCheckpoint(runId, {
        nodeKey: state.nodeKey,
        state: state.state,
        definitionHash: state.definitionHash,
        completedAt: state.completedAt
      });
    }
  }

  /** Read node execution state. Returns undefined if not found. */
  readNodeState(runId: string, nodeKey: string): NodeExecutionState | undefined {
    validateRunId(runId);
    const filename = encodeNodeKeyForFs(nodeKey);
    return this.readJson<NodeExecutionState>(join(this.runDir(runId), "nodes", filename));
  }

  /** List all node states for a run. */
  listNodeStates(runId: string): NodeExecutionState[] {
    validateRunId(runId);
    const nodesDir = join(this.runDir(runId), "nodes");
    if (!existsSync(nodesDir)) return [];

    const files = readdirSync(nodesDir).filter((f) => f.endsWith(".json"));
    return files
      .map((f) => this.readJson<NodeExecutionState>(join(nodesDir, f)))
      .filter((s): s is NodeExecutionState => s !== undefined);
  }

  // ─── Run discovery ─────────────────────────────────────────────

  /** List all run IDs on disk. */
  listRunIds(): string[] {
    if (!existsSync(this.baseDir)) return [];
    return readdirSync(this.baseDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  }

  /** Get the artifacts directory for a node. */
  artifactsDir(runId: string, nodeKey: string): string {
    validateRunId(runId);
    const dir = join(this.runDir(runId), "artifacts", encodeNodeKeyForDir(nodeKey));
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  /** Check if a run exists on disk. */
  hasRun(runId: string): boolean {
    validateRunId(runId);
    return existsSync(this.runDir(runId));
  }

  // ─── Checkpoints ───────────────────────────────────────────────

  /**
   * Append a Run Checkpoint for a Node that has just reached a terminal state.
   * Idempotent on `nodeKey`: if a checkpoint for this Node Key already exists,
   * its entry is replaced in-place to reflect the latest terminal outcome
   * (e.g., a Node Retry that flips failed → completed). Sequence numbers
   * remain monotonic for new entries.
   */
  appendCheckpoint(runId: string, checkpoint: Omit<RunCheckpoint, "sequence">): void {
    validateRunId(runId);
    const path = this.checkpointsIndexPath(runId);
    const entries = this.readJson<RunCheckpoint[]>(path) ?? [];
    const existing = entries.findIndex((entry) => entry.nodeKey === checkpoint.nodeKey);
    if (existing >= 0) {
      entries[existing] = { ...checkpoint, sequence: entries[existing].sequence };
    } else {
      const nextSequence = entries.reduce((max, entry) => Math.max(max, entry.sequence), 0) + 1;
      entries.push({ ...checkpoint, sequence: nextSequence });
    }
    this.atomicWriteJson(path, entries);
  }

  /**
   * Read the ordered Run Checkpoints for a Run. Returns an empty array when
   * the run was created before checkpoints existed (in which case the Run is
   * not forkable — callers MUST treat absence as ineligible for fork).
   */
  readCheckpoints(runId: string): RunCheckpoint[] {
    validateRunId(runId);
    const entries = this.readJson<RunCheckpoint[]>(this.checkpointsIndexPath(runId));
    if (!entries) return [];
    return [...entries].sort((a, b) => a.sequence - b.sequence);
  }

  /** True when this Run has a checkpoint index file (regardless of size). */
  hasCheckpointIndex(runId: string): boolean {
    validateRunId(runId);
    return existsSync(this.checkpointsIndexPath(runId));
  }

  /**
   * Copy a Node's persisted state and artifact directory from a prior Run into
   * a Forked Run, used when applying a fork plan. Replaces any existing entry
   * and copies the artifact directory recursively. The caller is responsible
   * for also calling appendCheckpoint to register the inherited Node.
   */
  inheritNodeFromRun(targetRunId: string, sourceRunId: string, nodeKey: string): void {
    validateRunId(targetRunId);
    validateRunId(sourceRunId);
    const sourceState = this.readNodeState(sourceRunId, nodeKey);
    if (!sourceState) {
      throw new Error(`Cannot inherit node ${nodeKey}: no persisted state in source run ${sourceRunId}`);
    }
    // Rewrite artifact URIs from <sourceRunId> → <targetRunId>.
    const inheritedRefs = sourceState.artifactRefs?.map((uri) => ArtifactReferences.rewriteRunId(uri, sourceRunId, targetRunId));
    const targetState: NodeExecutionState = {
      ...sourceState,
      artifactRefs: inheritedRefs,
      agentTelemetry: rewriteAgentTelemetryArtifactRefs(sourceState.agentTelemetry, sourceRunId, targetRunId)
    };

    // Copy the artifact directory FIRST so a crash before the Node-state
    // write does not leave dangling artifactRefs URIs on disk. cpSync is
    // recursive and creates the destination; the source dir may legitimately
    // not exist for Nodes that produced no artifacts.
    const sourceDir = join(this.runDir(sourceRunId), "artifacts", encodeNodeKeyForDir(nodeKey));
    const targetDir = join(this.runDir(targetRunId), "artifacts", encodeNodeKeyForDir(nodeKey));
    if (existsSync(sourceDir)) {
      mkdirSync(dirname(targetDir), { recursive: true });
      cpSync(sourceDir, targetDir, { recursive: true });
    }

    // Persist Node state last; this is also what auto-appends the checkpoint,
    // so observers never see a checkpoint before its artifacts exist.
    this.writeNodeState(targetRunId, targetState);
  }

  cleanTerminalRuns(options: { dryRun?: boolean } = {}): RunCleanResult {
    const dryRun = Boolean(options.dryRun);
    const deleted: RunCleanItem[] = [];
    const skipped: RunCleanItem[] = [];

    for (const runId of this.listRunIds()) {
      const runDir = this.runDir(runId);
      const meta = this.readRunMeta(runId);
      const bytes = directorySize(runDir);

      if (!meta) {
        skipped.push({ runId, bytes, reason: "corrupt-metadata" });
        continue;
      }

      if (!isRunTerminal(meta.status)) {
        skipped.push({ runId, status: meta.status, bytes, reason: "not-terminal" });
        continue;
      }

      let deleteStatus = meta.status;
      if (!dryRun) {
        const latest = this.readRunMeta(runId);
        if (!latest) {
          skipped.push({ runId, bytes, reason: "corrupt-metadata" });
          continue;
        }
        if (!isRunTerminal(latest.status)) {
          skipped.push({ runId, status: latest.status, bytes, reason: "not-terminal" });
          continue;
        }
        deleteStatus = latest.status;
      }

      deleted.push({ runId, status: deleteStatus, bytes });
      if (!dryRun) {
        try {
          rmSync(runDir, { recursive: true });
        } catch {
          deleted.pop();
          skipped.push({ runId, status: meta.status, bytes, reason: "delete-failed" });
        }
      }
    }

    return {
      dryRun,
      deletedCount: deleted.length,
      skippedCount: skipped.length,
      bytesReclaimed: deleted.reduce((sum, item) => sum + item.bytes, 0),
      deleted,
      skipped
    };
  }

  /** Get the base directory. */
  getBaseDir(): string {
    return this.baseDir;
  }

  /**
   * Resolve an `artifact://runs/<runId>/nodes/<safeKey>/<filename>` URI to its
   * absolute filesystem path. Pure (no mkdir). Returns undefined for malformed
   * URIs. Mirrors ArtifactStore's layout: <baseDir>/<runId>/artifacts/<safeKey>/<filename>.
   */
  resolveArtifactPath(uri: string): string | undefined {
    return ArtifactReferences.resolvePath(this.baseDir, uri, (runId) => !runId || UNSAFE_RUN_ID.test(runId));
  }

  // ─── Internal helpers ──────────────────────────────────────────

  private runDir(runId: string): string {
    return join(this.baseDir, runId);
  }

  private checkpointsIndexPath(runId: string): string {
    return join(this.runDir(runId), "checkpoints.index.json");
  }

  /** Write JSON via temp file + atomic rename for crash safety. */
  private atomicWriteJson(filePath: string, data: unknown): void {
    const dir = dirname(filePath);
    mkdirSync(dir, { recursive: true });
    const tmpPath = filePath + ".tmp";
    writeFileSync(tmpPath, JSON.stringify(data, null, 2), "utf8");
    renameSync(tmpPath, filePath);
  }

  /** Read and parse a JSON file. Returns undefined if missing or invalid. */
  private readJson<T>(filePath: string): T | undefined {
    if (!existsSync(filePath)) return undefined;
    try {
      return JSON.parse(readFileSync(filePath, "utf8")) as T;
    } catch {
      return undefined;
    }
  }
}

/** SHA-256 digest of a string. */
function sha256(content: string): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

function isTerminal(state: NodeExecutionState["state"]): boolean {
  return state === "completed" || state === "failed" || state === "cancelled";
}

/**
 * Whether a Node Kind should produce a Run Checkpoint when reaching a terminal
 * state. Composite container Nodes (pipeline, parallel, fanout, switch, loop,
 * subworkflow) record an aggregate outcome whose meaning depends on their
 * children; inheriting them in a Forked Run would short-circuit the container
 * body wholesale (the interpreter treats any persisted completed as done).
 * Only leaves and the deterministic Guard / Signal nodes produce checkpoints,
 * so a Forked Run inherits leaf outputs and re-derives container control flow
 * against the new IR.
 */
function isCheckpointableKind(kind: NodeExecutionState["kind"]): boolean {
  return kind === "run.agent" || kind === "run.program" || kind === "guard" || kind === "run.signal";
}

function rewriteAgentTelemetryArtifactRefs(
  telemetry: AgentTelemetry | undefined,
  sourceRunId: string,
  targetRunId: string
): AgentTelemetry | undefined {
  if (!telemetry) return undefined;
  return {
    ...telemetry,
    attempts: telemetry.attempts.map((attempt) => ({
      ...attempt,
      input: attempt.input
        ? { ...attempt.input, artifactRef: rewriteOptionalArtifactRef(attempt.input.artifactRef, sourceRunId, targetRunId) }
        : undefined,
      output: attempt.output
        ? { ...attempt.output, artifactRef: rewriteOptionalArtifactRef(attempt.output.artifactRef, sourceRunId, targetRunId) }
        : undefined
    }))
  };
}

function rewriteOptionalArtifactRef(value: string | undefined, sourceRunId: string, targetRunId: string): string | undefined {
  return value === undefined ? undefined : ArtifactReferences.rewriteRunId(value, sourceRunId, targetRunId);
}

function directorySize(path: string): number {
  try {
    const stat = lstatSync(path);
    if (!stat.isDirectory()) return stat.size;
    let total = 0;
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      total += directorySize(join(path, entry.name));
    }
    return total;
  } catch {
    return 0;
  }
}
