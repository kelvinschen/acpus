import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync
} from "node:fs";
import { join, resolve } from "node:path";
import { encodeNodeKeyForDir } from "./keys.js";
import type { ArtifactRef } from "./types.js";

const ARTIFACT_URI_PREFIX = "artifact://runs/";

export interface ParsedArtifactReference {
  uri: string;
  runId: string;
  encodedNodeKey: string;
  nodeKey: string;
  filename: string;
}

export const ArtifactReferences = {
  make(runId: string, nodeKey: string, filename: string): ArtifactRef {
    validateArtifactFilename(filename);
    const encodedNodeKey = encodeNodeKeyForDir(nodeKey);
    const uri = `${ARTIFACT_URI_PREFIX}${runId}/nodes/${encodedNodeKey}/${filename}`;
    return { uri, runId, nodeKey, filename };
  },

  parse(uri: string): ParsedArtifactReference {
    if (!uri.startsWith(ARTIFACT_URI_PREFIX)) {
      throw new Error(`Invalid artifact URI: ${uri}`);
    }

    const parts = uri.slice(ARTIFACT_URI_PREFIX.length).split("/");
    if (parts.length < 4 || parts[1] !== "nodes") {
      throw new Error(`Invalid artifact URI format: ${uri}`);
    }

    const runId = parts[0];
    const filename = parts[parts.length - 1];
    const encodedNodeKey = parts.slice(2, parts.length - 1).join("/");
    if (!runId || !encodedNodeKey || !filename) {
      throw new Error(`Invalid artifact URI format: ${uri}`);
    }

    return { uri, runId, encodedNodeKey, nodeKey: encodedNodeKey, filename };
  },

  tryParse(uri: string): ParsedArtifactReference | undefined {
    try {
      return this.parse(uri);
    } catch {
      return undefined;
    }
  },

  rewriteRunId(uri: string, fromRunId: string, toRunId: string): string {
    const ref = this.tryParse(uri);
    if (!ref || ref.runId !== fromRunId) return uri;
    return `${ARTIFACT_URI_PREFIX}${toRunId}/nodes/${ref.encodedNodeKey}/${ref.filename}`;
  },

  resolvePath(baseDir: string, uri: string, isUnsafeRunId: (runId: string) => boolean): string | undefined {
    const ref = this.tryParse(uri);
    if (!ref || isUnsafeRunId(ref.runId)) return undefined;
    if (!isSafeUriPathSegment(ref.encodedNodeKey) || !isSafeUriPathSegment(ref.filename)) return undefined;

    try {
      validateArtifactFilename(ref.filename);
    } catch {
      return undefined;
    }

    const runDir = join(baseDir, ref.runId);
    const resolved = resolve(join(runDir, "artifacts", ref.encodedNodeKey, ref.filename));
    if (!isPathAtOrBelow(resolved, runDir)) return undefined;
    return resolved;
  }
};

/**
 * Local filesystem artifact store under .acpus/state/runs/<run_id>/artifacts/.
 * Artifact URIs follow the format: artifact://runs/<runId>/nodes/<nodeKey>/<filename>
 */
export class ArtifactStore {
  private readonly baseDir: string;

  constructor(baseDir?: string) {
    this.baseDir = baseDir ?? join(process.cwd(), ".acpus", "state", "runs");
  }

  /**
   * Write an artifact file. Uses atomic write (temp + rename) for crash safety.
   * Returns the ArtifactRef for the written file.
   */
  write(runId: string, nodeKey: string, filename: string, content: string | Buffer): ArtifactRef {
    const ref = ArtifactReferences.make(runId, nodeKey, filename);
    const dir = this.nodeDir(runId, nodeKey);
    mkdirSync(dir, { recursive: true });

    const filePath = join(dir, filename);
    const tmpPath = filePath + ".tmp";
    writeFileSync(tmpPath, content);
    renameSync(tmpPath, filePath);

    return ref;
  }

  /**
   * Create or truncate an artifact file and return its reference.
   * Used for artifacts that will be appended while an execution is still live.
   */
  create(runId: string, nodeKey: string, filename: string): ArtifactRef {
    const ref = ArtifactReferences.make(runId, nodeKey, filename);
    const dir = this.nodeDir(runId, nodeKey);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, filename), "");
    return ref;
  }

  /** Append content to an existing artifact, creating it if needed. */
  append(runId: string, nodeKey: string, filename: string, content: string | Buffer): ArtifactRef {
    const ref = ArtifactReferences.make(runId, nodeKey, filename);
    const dir = this.nodeDir(runId, nodeKey);
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, filename), content);
    return ref;
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
      .map((filename) => ArtifactReferences.make(runId, nodeKey, filename));
  }

  /** Parse an artifact URI into its components. */
  parseArtifactRef(uri: string): ArtifactRef {
    const ref = ArtifactReferences.parse(uri);
    return { uri: ref.uri, runId: ref.runId, nodeKey: ref.nodeKey, filename: ref.filename };
  }

  // ─── Internal helpers ──────────────────────────────────────────

  private nodeDir(runId: string, nodeKey: string): string {
    const safeKey = encodeNodeKeyForDir(nodeKey);
    return join(this.baseDir, runId, "artifacts", safeKey);
  }
}

/** Validate that an artifact filename has no path traversal or separator characters. */
function validateArtifactFilename(filename: string): void {
  if (filename.includes("/") || filename.includes("\\") || filename.includes("..")) {
    throw new Error(`Invalid artifact filename: ${filename}`);
  }
}

function isSafeUriPathSegment(segment: string): boolean {
  return Boolean(segment) && !segment.split("/").some((part) => part === "" || part === "." || part === "..");
}

function isPathAtOrBelow(path: string, basePath: string): boolean {
  const normalizedBase = resolve(basePath);
  return path === normalizedBase || path.startsWith(`${normalizedBase}/`);
}
