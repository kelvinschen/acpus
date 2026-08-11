import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { validateWorkflowIR, walkNodes, type WorkflowIR } from "@acpus/core/ir";
import { err, ok, type Result } from "neverthrow";
import { sha256Digest, type Sha256Digest } from "../content-digest.js";
import { isContainedPath } from "../path-containment.js";
import { stableJsonLine } from "../stable-json.js";

export type PreparedRunValidationFailure = {
  type: "prepared-workflow-invalid";
  reason:
    | "invalid-ir-json"
    | "invalid-ir"
    | "ir-mismatch"
    | "ir-digest-mismatch"
    | "source-graph-mismatch"
    | "source-bundle-mismatch"
    | "package-lock-mismatch"
    | "entry-mismatch";
  message: string;
};

export type RunWorkflowLockArtifact = {
  kind: "acpus_workflow_preparation_lock";
  version: 2;
  workflow: {
    source: WorkflowSourceRef;
    entryDigest: Sha256Digest;
  };
  ir: {
    path: "workflow.ir.json";
    digest: Sha256Digest;
  };
  packageLockDigest?: Sha256Digest;
  sourceGraphDigest: Sha256Digest;
};

export type WorkflowSourceRef =
  | { kind: "workspace"; entry: string }
  | { kind: "snapshot"; entry: string; digest: Sha256Digest };

export type WorkflowSourceFile = {
  path: string;
  content: string;
};

export type WorkflowSourceBundle = {
  kind: "acpus_workflow_source_bundle";
  version: 1;
  files: readonly WorkflowSourceFile[];
};

type PreparedRunWorkflowBase = {
  ir: WorkflowIR;
  irJson: string;
  sourceGraphDigest: Sha256Digest;
  packageLockDigest?: Sha256Digest;
  lock: RunWorkflowLockArtifact;
};

export type PreparedRunWorkflow =
  | PreparedRunWorkflowBase & {
    source: Extract<WorkflowSourceRef, { kind: "workspace" }>;
    sourceBundle?: never;
  }
  | PreparedRunWorkflowBase & {
    source: Extract<WorkflowSourceRef, { kind: "snapshot" }>;
    sourceBundle: WorkflowSourceBundle;
  };

export type WorkflowSourceSnapshotManifest = {
  kind: "acpus_workflow_source_snapshot";
  version: 1;
  entry: string;
  digest: Sha256Digest;
  files: Array<{ path: string; digest: Sha256Digest }>;
};

export function tryValidatePreparedRunWorkflow(
  cwd: string,
  prepared: PreparedRunWorkflow,
): Result<PreparedRunWorkflow, PreparedRunValidationFailure> {
  if (!isPreparedRunWorkflow(prepared)) {
    return preparedInvalid("source-bundle-mismatch", "Prepared workflow does not match the current closed format.");
  }
  const candidate = prepared;
  let ir: unknown;
  try {
    ir = JSON.parse(candidate.irJson);
  } catch {
    return preparedInvalid("invalid-ir-json", "Prepared workflow IR JSON is invalid.");
  }
  if (stableJsonLine(ir) !== stableJsonLine(candidate.ir)) {
    return preparedInvalid("ir-mismatch", "Prepared workflow IR JSON does not match prepared IR.");
  }
  const parsedIr = ir as WorkflowIR;
  const invalid = validateWorkflowIR(parsedIr).find(diagnostic => diagnostic.severity === "error");
  if (invalid) {
    return preparedInvalid("invalid-ir", `Prepared workflow IR is invalid: ${invalid.code}: ${invalid.message}`);
  }
  const existingError = parsedIr.diagnostics.find(diagnostic => diagnostic.severity === "error");
  if (existingError) {
    return preparedInvalid("invalid-ir", `Prepared workflow IR contains an error diagnostic: ${existingError.code}: ${existingError.message}`);
  }
  if (sha256Digest(Buffer.from(candidate.irJson)) !== candidate.lock.ir.digest) {
    return preparedInvalid("ir-digest-mismatch", "Prepared workflow lock IR digest does not match IR JSON.");
  }
  if (candidate.lock.sourceGraphDigest !== candidate.sourceGraphDigest) {
    return preparedInvalid("source-graph-mismatch", "Prepared workflow lock source graph digest does not match prepared source graph digest.");
  }
  const hasPackageLockDigest = Object.hasOwn(candidate, "packageLockDigest");
  const lockHasPackageLockDigest = Object.hasOwn(candidate.lock, "packageLockDigest");
  if (hasPackageLockDigest !== lockHasPackageLockDigest || candidate.packageLockDigest !== candidate.lock.packageLockDigest) {
    return preparedInvalid("package-lock-mismatch", "Prepared workflow lock package lock digest does not match prepared package lock digest.");
  }
  if (stableJsonLine(candidate.lock.workflow.source) !== stableJsonLine(candidate.source)) {
    return preparedInvalid("entry-mismatch", "Prepared workflow lock source does not match prepared workflow source.");
  }
  if (candidate.source.kind === "snapshot") {
    const files = candidate.sourceBundle!.files;
    const entry = files.find(file => file.path === candidate.source.entry);
    if (!entry) {
      return preparedInvalid("entry-mismatch", "Prepared workflow source entry is missing from its source bundle.");
    }
    if (sha256Digest(Buffer.from(entry.content)) !== candidate.lock.workflow.entryDigest) {
      return preparedInvalid("entry-mismatch", "Prepared workflow entry digest does not match its source bundle.");
    }
    const graphDigest = workflowSourceGraphDigest(candidate.source.entry, files);
    if (candidate.source.digest !== graphDigest || candidate.sourceGraphDigest !== graphDigest) {
      return preparedInvalid("source-graph-mismatch", "Prepared workflow source graph digest does not match its source bundle.");
    }
  } else {
    const entryMismatch = () => preparedInvalid("entry-mismatch", "Prepared workspace entry does not match its preparation lock.");
    const root = realpathSync(resolve(cwd));
    if (!lstatSync(root).isDirectory()) {
      throw new Error("Runtime workspace must be a directory.");
    }
    try {
      const entry = resolve(root, candidate.source.entry);
      const info = lstatSync(entry);
      if (!isContainedPath(root, entry)
        || info.isSymbolicLink()
        || !info.isFile()
        || !isContainedPath(root, realpathSync(entry))
        || sha256Digest(readFileSync(entry)) !== candidate.lock.workflow.entryDigest) {
        return entryMismatch();
      }
      for (const referrerPath of reusableTaskReferrerPaths(parsedIr)) {
        const referrer = resolve(root, referrerPath);
        if (!isContainedPath(root, referrer)) return entryMismatch();
        const physicalReferrer = realpathSync(referrer);
        if (!isContainedPath(root, physicalReferrer) || !lstatSync(physicalReferrer).isFile()) {
          return entryMismatch();
        }
      }
    } catch (error) {
      if (isMissingPathError(error)) return entryMismatch();
      throw error;
    }
  }
  return ok({ ...structuredClone(candidate), ir: parsedIr });
}

function reusableTaskReferrerPaths(ir: WorkflowIR): string[] {
  return [...new Set(Array.from(walkNodes(ir.root), ({ node }) => node.kind === "task"
    && node.run.target.kind === "module"
    ? node.run.target.referrer.path
    : undefined)
    .filter((path): path is string => path !== undefined))];
}

export function isPreparedRunWorkflow(value: unknown): value is PreparedRunWorkflow {
  if (!isPlainObject(value)
    || !isPlainObject(value.source)
    || !isWorkflowSourceRef(value.source)
    || !isPlainObject(value.ir)
    || typeof value.ir.name !== "string"
    || !isPlainObject(value.ir.root)
    || typeof value.irJson !== "string"
    || !isSha256Digest(value.sourceGraphDigest)
    || (Object.hasOwn(value, "packageLockDigest") && !isSha256Digest(value.packageLockDigest))
    || !isRunWorkflowLockArtifact(value.lock)) {
    return false;
  }
  if (value.source.kind === "workspace") {
    return hasExactObjectKeys(value, ["source", "ir", "irJson", "sourceGraphDigest", "lock"], ["packageLockDigest"]);
  }
  return hasExactObjectKeys(value, ["source", "sourceBundle", "ir", "irJson", "sourceGraphDigest", "lock"], ["packageLockDigest"])
    && isWorkflowSourceBundle(value.sourceBundle);
}

export function isRunWorkflowLockArtifact(value: unknown): value is RunWorkflowLockArtifact {
  return isPlainObject(value)
    && hasExactObjectKeys(value, ["kind", "version", "workflow", "ir", "sourceGraphDigest"], ["packageLockDigest"])
    && value.kind === "acpus_workflow_preparation_lock"
    && value.version === 2
    && isSha256Digest(value.sourceGraphDigest)
    && (!Object.hasOwn(value, "packageLockDigest") || isSha256Digest(value.packageLockDigest))
    && isPlainObject(value.workflow)
    && hasExactObjectKeys(value.workflow, ["source", "entryDigest"])
    && isWorkflowSourceRef(value.workflow.source)
    && isSha256Digest(value.workflow.entryDigest)
    && isPlainObject(value.ir)
    && hasExactObjectKeys(value.ir, ["path", "digest"])
    && value.ir.path === "workflow.ir.json"
    && isSha256Digest(value.ir.digest);
}

export function parseWorkflowSource(json: string): WorkflowSourceRef {
  const value = JSON.parse(json) as unknown;
  if (!isWorkflowSourceRef(value)) throw new Error("Persisted workflow source reference is invalid.");
  return value;
}

export function createWorkflowSourceSnapshotManifest(
  source: Extract<WorkflowSourceRef, { kind: "snapshot" }>,
  files: readonly WorkflowSourceFile[],
): WorkflowSourceSnapshotManifest {
  return {
    kind: "acpus_workflow_source_snapshot",
    version: 1,
    entry: source.entry,
    digest: source.digest,
    files: files.map(file => ({ path: file.path, digest: sha256Digest(Buffer.from(file.content)) })),
  };
}

export function isWorkflowSourceSnapshotManifest(value: unknown): value is WorkflowSourceSnapshotManifest {
  if (!isPlainObject(value)
    || !hasExactObjectKeys(value, ["kind", "version", "entry", "digest", "files"])
    || value.kind !== "acpus_workflow_source_snapshot"
    || value.version !== 1
    || !isPortableSourcePath(value.entry)
    || !isSha256Digest(value.digest)
    || !Array.isArray(value.files)) {
    return false;
  }
  let previous: string | undefined;
  const paths: string[] = [];
  for (const file of value.files) {
    if (!isPlainObject(file)
      || !hasExactObjectKeys(file, ["path", "digest"])
      || !isPortableSourcePath(file.path)
      || !isSha256Digest(file.digest)
      || previous !== undefined && previous >= file.path) {
      return false;
    }
    previous = file.path;
    paths.push(file.path);
  }
  return !hasSourcePathInventoryCollision(paths)
    && value.files.some(file => file.path === value.entry);
}

export function workflowSourceGraphDigestFromManifest(
  manifest: WorkflowSourceSnapshotManifest,
): Sha256Digest {
  return workflowSourceGraphDigestFromDigests(manifest.entry, manifest.files);
}

function isWorkflowSourceRef(value: unknown): value is WorkflowSourceRef {
  if (!isPlainObject(value) || !isPortableSourcePath(value.entry)) return false;
  if (value.kind === "workspace") return hasExactObjectKeys(value, ["kind", "entry"]);
  return value.kind === "snapshot"
    && hasExactObjectKeys(value, ["kind", "entry", "digest"])
    && isSha256Digest(value.digest);
}

function isWorkflowSourceBundle(value: unknown): value is WorkflowSourceBundle {
  if (!isPlainObject(value)
    || !hasExactObjectKeys(value, ["kind", "version", "files"])
    || value.kind !== "acpus_workflow_source_bundle"
    || value.version !== 1
    || !Array.isArray(value.files)) {
    return false;
  }
  let previous: string | undefined;
  const paths: string[] = [];
  for (const file of value.files) {
    if (!isPlainObject(file)
      || !hasExactObjectKeys(file, ["path", "content"])
      || !isPortableSourcePath(file.path)
      || typeof file.content !== "string"
      || previous !== undefined && previous >= file.path) {
      return false;
    }
    previous = file.path;
    paths.push(file.path);
  }
  return !hasSourcePathInventoryCollision(paths);
}

function workflowSourceGraphDigest(entry: string, files: readonly WorkflowSourceFile[]): Sha256Digest {
  return workflowSourceGraphDigestFromDigests(
    entry,
    files.map(file => ({ path: file.path, digest: sha256Digest(Buffer.from(file.content)) })),
  );
}

function workflowSourceGraphDigestFromDigests(
  entry: string,
  files: readonly { path: string; digest: Sha256Digest }[],
): Sha256Digest {
  return sha256Digest(Buffer.from(stableJsonLine({
    kind: "acpus_workflow_source_graph",
    version: 1,
    entry,
    files,
  })));
}

function isPortableSourcePath(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && !value.startsWith("/")
    && !/^[A-Za-z]:/.test(value)
    && !value.includes("\\")
    && !value.includes("\0")
    && value.split("/").every(segment => segment.length > 0 && segment !== "." && segment !== "..");
}

function isSha256Digest(value: unknown): value is Sha256Digest {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);
}

function hasSourcePathInventoryCollision(paths: readonly string[]): boolean {
  const inventory = new Map<string, { spelling: string; kind: "directory" | "file" }>();
  for (const path of paths) {
    const segments = path.split("/");
    for (let index = 0; index < segments.length; index += 1) {
      const spelling = segments.slice(0, index + 1).join("/");
      const key = spelling.normalize("NFC").toUpperCase().toLowerCase().normalize("NFC");
      const kind = index === segments.length - 1 ? "file" : "directory";
      const existing = inventory.get(key);
      if (existing) {
        if (existing.spelling !== spelling || existing.kind !== kind || kind === "file") return true;
      } else {
        inventory.set(key, { spelling, kind });
      }
    }
  }
  return false;
}

function hasExactObjectKeys(value: Record<string, unknown>, required: string[], optional: string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every(key => Object.hasOwn(value, key))
    && Object.keys(value).every(key => allowed.has(key));
}

function preparedInvalid(
  reason: PreparedRunValidationFailure["reason"],
  message: string,
): Result<never, PreparedRunValidationFailure> {
  return err({ type: "prepared-workflow-invalid", reason, message });
}

function isMissingPathError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error
    && ((error as { code?: unknown }).code === "ENOENT" || (error as { code?: unknown }).code === "ENOTDIR");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
