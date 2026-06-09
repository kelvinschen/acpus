import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync
} from "node:fs";
import { dirname, join } from "node:path";
import { resolveNodeKey, encodeNodeKeyForDir } from "./keys.js";
import type { ArtifactRef } from "./types.js";

/**
 * Local filesystem artifact store under .acpus/runs/<run_id>/artifacts/.
 * Artifact URIs follow the format: artifact://runs/<runId>/nodes/<nodeKey>/<filename>
 */
export class ArtifactStore {
  private readonly baseDir: string;

  constructor(baseDir?: string) {
    this.baseDir = baseDir ?? join(process.cwd(), ".acpus", "runs");
  }

  /**
   * Write an artifact file. Uses atomic write (temp + rename) for crash safety.
   * Returns the ArtifactRef for the written file.
   */
  write(runId: string, nodeKey: string, filename: string, content: string | Buffer): ArtifactRef {
    validateArtifactFilename(filename);
    const dir = this.nodeDir(runId, nodeKey);
    mkdirSync(dir, { recursive: true });

    const filePath = join(dir, filename);
    const tmpPath = filePath + ".tmp";
    writeFileSync(tmpPath, content);
    renameSync(tmpPath, filePath);

    return this.makeRef(runId, nodeKey, filename);
  }

  /**
   * Create or truncate an artifact file and return its reference.
   * Used for artifacts that will be appended while an execution is still live.
   */
  create(runId: string, nodeKey: string, filename: string): ArtifactRef {
    validateArtifactFilename(filename);
    const dir = this.nodeDir(runId, nodeKey);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, filename), "");
    return this.makeRef(runId, nodeKey, filename);
  }

  /** Append content to an existing artifact, creating it if needed. */
  append(runId: string, nodeKey: string, filename: string, content: string | Buffer): ArtifactRef {
    validateArtifactFilename(filename);
    const dir = this.nodeDir(runId, nodeKey);
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, filename), content);
    return this.makeRef(runId, nodeKey, filename);
  }

  /** Read an artifact file content. */
  read(runId: string, nodeKey: string, filename: string): Buffer {
    validateArtifactFilename(filename);
    const filePath = join(this.nodeDir(runId, nodeKey), filename);
    return readFileSync(filePath);
  }

  /** List all artifact refs for a node. */
  list(runId: string, nodeKey: string): ArtifactRef[] {
    const dir = this.nodeDir(runId, nodeKey);
    if (!existsSync(dir)) return [];

    return readdirSync(dir)
      .filter((f) => !f.endsWith(".tmp"))
      .map((filename) => this.makeRef(runId, nodeKey, filename));
  }

  /** Parse an artifact URI into its components. */
  parseArtifactRef(uri: string): ArtifactRef {
    const prefix = "artifact://runs/";
    if (!uri.startsWith(prefix)) {
      throw new Error(`Invalid artifact URI: ${uri}`);
    }
    const rest = uri.slice(prefix.length);
    // Format: <runId>/nodes/<nodeKey>/<filename>
    // nodeKey may contain : but not /
    const parts = rest.split("/");
    if (parts.length < 4 || parts[1] !== "nodes") {
      throw new Error(`Invalid artifact URI format: ${uri}`);
    }
    const runId = parts[0];
    // Everything between "nodes/" and the last segment is the nodeKey
    const filename = parts[parts.length - 1];
    const nodeKey = parts.slice(2, parts.length - 1).join("/");
    return { uri, runId, nodeKey, filename };
  }

  // ─── Internal helpers ──────────────────────────────────────────

  private nodeDir(runId: string, nodeKey: string): string {
    const safeKey = encodeNodeKeyForDir(nodeKey);
    return join(this.baseDir, runId, "artifacts", safeKey);
  }

  private makeRef(runId: string, nodeKey: string, filename: string): ArtifactRef {
    const safeKey = encodeNodeKeyForDir(nodeKey);
    const uri = `artifact://runs/${runId}/nodes/${safeKey}/${filename}`;
    return { uri, runId, nodeKey, filename };
  }
}

/** Validate that an artifact filename has no path traversal or separator characters. */
function validateArtifactFilename(filename: string): void {
  if (filename.includes("/") || filename.includes("\\") || filename.includes("..")) {
    throw new Error(`Invalid artifact filename: ${filename}`);
  }
}
