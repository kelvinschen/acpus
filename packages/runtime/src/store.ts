import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { encodeNodeKeyForFs, encodeNodeKeyForDir } from "./keys.js";
import type { AcpusIr } from "@acpus/core";
import type { NodeExecutionState, RunState } from "./types.js";

/**
 * Per-node JSON file persistence with write-to-temp-then-rename for crash safety.
 *
 * Directory layout:
 *   .acpus/
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
export class RunStore {
  private readonly baseDir: string;

  constructor(baseDir?: string) {
    this.baseDir = baseDir ?? join(process.cwd(), ".acpus", "runs");
  }

  // ─── Run lifecycle ─────────────────────────────────────────────

  /** Create a new run directory and write IR + input snapshots. */
  initRun(runId: string, ir: AcpusIr, input: Record<string, unknown>): RunState {
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
      status: "running",
      irDigest,
      inputDigest,
      createdAt: now,
      updatedAt: now
    };
    this.writeRunMeta(runId, meta);
    return meta;
  }

  /** Read the frozen IR snapshot for a run. */
  readIr(runId: string): AcpusIr | undefined {
    return this.readJson<AcpusIr>(join(this.runDir(runId), "ir.json"));
  }

  /** Read the resolved input for a run. */
  readInput(runId: string): Record<string, unknown> | undefined {
    return this.readJson<Record<string, unknown>>(join(this.runDir(runId), "input.json"));
  }

  // ─── Run metadata ──────────────────────────────────────────────

  writeRunMeta(runId: string, meta: RunState): void {
    this.atomicWriteJson(join(this.runDir(runId), "run-meta.json"), meta);
  }

  readRunMeta(runId: string): RunState | undefined {
    return this.readJson<RunState>(join(this.runDir(runId), "run-meta.json"));
  }

  // ─── Node state ────────────────────────────────────────────────

  /** Atomically write node execution state. */
  writeNodeState(runId: string, state: NodeExecutionState): void {
    const filename = encodeNodeKeyForFs(state.nodeKey);
    this.atomicWriteJson(join(this.runDir(runId), "nodes", filename), state);
  }

  /** Read node execution state. Returns undefined if not found. */
  readNodeState(runId: string, nodeKey: string): NodeExecutionState | undefined {
    const filename = encodeNodeKeyForFs(nodeKey);
    return this.readJson<NodeExecutionState>(join(this.runDir(runId), "nodes", filename));
  }

  /** List all node states for a run. */
  listNodeStates(runId: string): NodeExecutionState[] {
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
    const dir = join(this.runDir(runId), "artifacts", encodeNodeKeyForDir(nodeKey));
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  /** Check if a run exists on disk. */
  hasRun(runId: string): boolean {
    return existsSync(this.runDir(runId));
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
    const prefix = "artifact://runs/";
    if (!uri.startsWith(prefix)) return undefined;
    const parts = uri.slice(prefix.length).split("/");
    // Format: <runId>/nodes/<safeKey>/<filename>
    if (parts.length < 4 || parts[1] !== "nodes") return undefined;
    const runId = parts[0];
    const filename = parts[parts.length - 1];
    const safeKey = parts.slice(2, parts.length - 1).join("/");
    if (!runId || !filename || !safeKey) return undefined;
    // safeKey is already the encoded form (slashes → colons) used on disk.
    return resolve(join(this.runDir(runId), "artifacts", safeKey, filename));
  }

  // ─── Internal helpers ──────────────────────────────────────────

  private runDir(runId: string): string {
    return join(this.baseDir, runId);
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
