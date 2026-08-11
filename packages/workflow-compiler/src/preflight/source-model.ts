import { isAbsolute, relative, resolve, sep } from "node:path";
import type { DiagnosticIR } from "@acpus/core/ir";
import { err, ok, type Result } from "neverthrow";
import { sha256Digest, stableJsonLine, type Sha256Digest } from "../digest.js";

export type WorkflowSourceFile = {
  path: string;
  content: string;
};

export type WorkflowSourceInput =
  | { kind: "path"; entry: string }
  | { kind: "files"; entry: string; files: readonly WorkflowSourceFile[] };

export type WorkflowSourceRef =
  | { kind: "workspace"; entry: string }
  | { kind: "snapshot"; entry: string; digest: Sha256Digest };

export type WorkflowSourceBundle = {
  kind: "acpus_workflow_source_bundle";
  version: 1;
  files: readonly WorkflowSourceFile[];
};

export type SourcePreparationFailure =
  | { type: "source-invalid"; phase: "source"; message: string }
  | { type: "source-changed"; phase: "source"; message: string };

export function canonicalizeFilesSource(
  input: Extract<WorkflowSourceInput, { kind: "files" }>,
): Result<{ entry: string; files: WorkflowSourceFile[] }, SourcePreparationFailure> {
  if (!Array.isArray(input.files)) return err(sourceInvalid("Workflow source files must be an array."));
  if (typeof input.entry !== "string") return err(sourceInvalid("Workflow source entry must be a string."));
  const entry = canonicalizeSourcePath(input.entry);
  if (entry.isErr()) return err(entry.error);

  const files: WorkflowSourceFile[] = [];
  for (const file of input.files) {
    if (!file || typeof file !== "object" || typeof file.path !== "string" || typeof file.content !== "string") {
      return err(sourceInvalid("Every workflow source file must contain string path and content fields."));
    }
    const path = canonicalizeSourcePath(file.path);
    if (path.isErr()) return err(path.error);
    files.push({ path: path.value, content: file.content });
  }
  files.sort(compareSourceFiles);
  const collision = sourcePathCollision(files.map(file => file.path));
  if (collision) return err(sourceInvalid(collision));
  if (!files.some(file => file.path === entry.value)) {
    return err(sourceInvalid(`Workflow source entry '${entry.value}' is not present in files.`));
  }
  return ok({ entry: entry.value, files });
}

export function canonicalizeSourcePath(path: string): Result<string, SourcePreparationFailure> {
  if (path.length === 0
    || path.includes("\0")
    || path.includes("\\")
    || path.startsWith("/")
    || /^[A-Za-z]:/.test(path)
    || path.split("/").some(segment => segment === "" || segment === "." || segment === "..")) {
    return err(sourceInvalid(`Workflow source path '${path}' must be a portable POSIX relative path.`));
  }
  return ok(path);
}

export function portableSourcePath(root: string, path: string): string | undefined {
  const child = relative(resolve(root), resolve(path));
  if (child === "" || isAbsolute(child) || child.split(sep).includes("..")) return undefined;
  return child.split(sep).join("/");
}

export function remapSourceDiagnostics(
  diagnostics: readonly DiagnosticIR[],
  sourceRoot: string,
): DiagnosticIR[] {
  return diagnostics.map(diagnostic => {
    const source = diagnostic.source;
    if (!source?.file) return diagnostic;
    const path = portableSourcePath(sourceRoot, source.file);
    if (!path) return diagnostic;
    return { ...diagnostic, source: { ...source, file: path } };
  });
}

export function mergeSourceDiagnostics(
  first: readonly DiagnosticIR[],
  second: readonly DiagnosticIR[],
): DiagnosticIR[] {
  const seen = new Set<string>();
  return [...first, ...second].filter(diagnostic => {
    const key = JSON.stringify([
      diagnostic.code,
      diagnostic.severity,
      diagnostic.message,
      diagnostic.path,
      diagnostic.source?.file,
      diagnostic.source?.line,
      diagnostic.source?.column,
      diagnostic.hint,
    ]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function sourceGraphDigest(
  entry: string,
  files: readonly WorkflowSourceFile[],
): Sha256Digest {
  return sha256Digest(stableJsonLine({
    kind: "acpus_workflow_source_graph",
    version: 1,
    entry,
    files: [...files]
      .sort(compareSourceFiles)
      .map(file => ({ path: file.path, digest: sha256Digest(file.content) })),
  }));
}

function sourcePathCollision(paths: readonly string[]): string | undefined {
  const exact = new Set<string>();
  const folded = new Map<string, string>();
  for (const path of paths) {
    if (exact.has(path)) return `Workflow source path '${path}' is duplicated.`;
    exact.add(path);
    const segments = path.split("/");
    for (let length = 1; length <= segments.length; length += 1) {
      const prefix = segments.slice(0, length).join("/");
      const key = portableCaseFold(prefix);
      const existing = folded.get(key);
      if (existing && existing !== prefix) {
        return `Workflow source paths '${existing}' and '${prefix}' collide after portable normalization.`;
      }
      folded.set(key, prefix);
      if (length < segments.length && exact.has(prefix)) {
        return `Workflow source path '${prefix}' collides with descendant '${path}'.`;
      }
    }
  }
  return undefined;
}

function portableCaseFold(value: string): string {
  return value.normalize("NFC").toUpperCase().toLowerCase().normalize("NFC");
}

function compareSourceFiles(left: WorkflowSourceFile, right: WorkflowSourceFile): number {
  return left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
}

function sourceInvalid(message: string): SourcePreparationFailure {
  return { type: "source-invalid", phase: "source", message };
}
