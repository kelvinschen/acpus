import { lstat, mkdir, readFile, realpath, stat, symlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { DiagnosticIR } from "@acpus/core/ir";
import { err, ok, type Result } from "neverthrow";
import { sha256Digest, stableJsonLine, type Sha256Digest } from "../digest.js";
import type { WorkflowCheckResult } from "../check/runner.js";

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

export type ResolvedPathSource =
  | {
      kind: "workspace";
      entryPath: string;
      sourceRoot: string;
      source: Extract<WorkflowSourceRef, { kind: "workspace" }>;
    }
  | {
      kind: "snapshot";
      entryPath: string;
      displayEntry: string;
    };

export type FrozenSource = {
  entryPath: string;
  displayEntry: string;
  sourceRoot: string;
  source: Extract<WorkflowSourceRef, { kind: "snapshot" }>;
  sourceBundle: WorkflowSourceBundle;
  sourceGraphDigest: Sha256Digest;
  availableModulePaths: ReadonlySet<string>;
  expectedModulePaths?: ReadonlySet<string>;
  discoveryDiagnostics?: readonly DiagnosticIR[];
};

type CapturedSource = {
  root: string;
  entry: string;
  files: WorkflowSourceFile[];
  modulePaths: ReadonlySet<string>;
  diagnostics: DiagnosticIR[];
};

const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export async function resolvePathSource(
  workspaceDir: string,
  entry: string,
): Promise<Result<ResolvedPathSource, SourcePreparationFailure>> {
  const workspace = resolve(workspaceDir);
  const entryPath = resolve(workspace, entry);
  let physicalWorkspace: string;
  try {
    physicalWorkspace = await realpath(workspace);
  } catch (cause) {
    return err(sourceInvalid(`Workflow workspace '${workspace}' could not be resolved: ${causeMessage(cause)}`));
  }

  try {
    const physicalEntry = await realpath(entryPath);
    if (isContained(physicalWorkspace, physicalEntry)) {
      const sourceEntry = portableRelative(physicalWorkspace, physicalEntry);
      if (!sourceEntry) return err(sourceInvalid(`Workflow entry '${entryPath}' must be a file inside workspace '${workspace}'.`));
      const validatedEntry = validatePortablePath(sourceEntry);
      if (validatedEntry.isErr()) return err(validatedEntry.error);
      return ok({
        kind: "workspace",
        entryPath: physicalEntry,
        sourceRoot: physicalWorkspace,
        source: { kind: "workspace", entry: validatedEntry.value },
      });
    }
    return ok({ kind: "snapshot", entryPath, displayEntry: entryPath });
  } catch (cause) {
    if (!isMissingPathError(cause)) {
      return err(sourceInvalid(`Workflow entry '${entryPath}' could not be resolved: ${causeMessage(cause)}`));
    }
    const lexicalEntry = portableRelative(workspace, entryPath);
    if (lexicalEntry) {
      const validatedEntry = validatePortablePath(lexicalEntry);
      if (validatedEntry.isErr()) return err(validatedEntry.error);
      return ok({
        kind: "workspace",
        entryPath,
        sourceRoot: physicalWorkspace,
        source: { kind: "workspace", entry: validatedEntry.value },
      });
    }
    return ok({ kind: "snapshot", entryPath, displayEntry: entryPath });
  }
}

export function validateFilesSource(
  input: Extract<WorkflowSourceInput, { kind: "files" }>,
): Result<{ entry: string; files: WorkflowSourceFile[] }, SourcePreparationFailure> {
  if (!Array.isArray(input.files)) return err(sourceInvalid("Workflow source files must be an array."));
  if (typeof input.entry !== "string") return err(sourceInvalid("Workflow source entry must be a string."));
  const entry = validatePortablePath(input.entry);
  if (entry.isErr()) return err(entry.error);

  const files: WorkflowSourceFile[] = [];
  for (const file of input.files) {
    if (!file || typeof file !== "object" || typeof file.path !== "string" || typeof file.content !== "string") {
      return err(sourceInvalid("Every workflow source file must contain string path and content fields."));
    }
    const path = validatePortablePath(file.path);
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

export async function capturePathSource(
  check: WorkflowCheckResult,
  entryPath: string,
): Promise<Result<CapturedSource, SourcePreparationFailure>> {
  if (!check.sourceFiles) return err(sourceChanged("Workflow source graph was unavailable after discovery."));
  const captured = new Map<string, string>();
  for (const sourceFile of check.sourceFiles) {
    if (!isSourceGraphTypeScript(sourceFile.path)) continue;
    const stable = await readStableText(sourceFile.path, sourceFile.content);
    if (stable.isErr()) return err(stable.error);
    captured.set(resolve(sourceFile.path), stable.value);
  }
  if (!captured.has(resolve(entryPath))) {
    return err(sourceChanged(`Workflow entry '${entryPath}' was not present in its discovered static source graph.`));
  }

  const manifests = new Map<string, string>();
  const manifestBySource = new Map<string, string>();
  for (const path of captured.keys()) {
    const manifest = await nearestPackageManifest(path);
    if (manifest.isErr()) return err(manifest.error);
    if (manifest.value) {
      manifests.set(manifest.value.path, manifest.value.content);
      manifestBySource.set(path, manifest.value.path);
    }
  }

  const packageImportReferrers = new Set(check.packageImportReferrers?.map(path => resolve(path)) ?? []);
  const packageRoots = [...captured.keys()]
    .filter(path => packageImportReferrers.has(path))
    .map(path => manifestBySource.get(path))
    .filter((path): path is string => path !== undefined)
    .map(dirname);
  const root = commonAncestor([...captured.keys()].map(dirname).concat(packageRoots));
  const files = [...captured].map(([path, content]) => ({
    path: portableRelative(root, path),
    content,
  }));
  for (const [path, content] of manifests) {
    files.push({
      path: portableRelative(root, path) || "package.json",
      content,
    });
  }
  if (files.some(file => !file.path)) {
    return err(sourceInvalid("Workflow source graph could not be projected beneath one source root."));
  }
  for (const file of files) {
    const path = validatePortablePath(file.path);
    if (path.isErr()) return err(path.error);
  }
  files.sort(compareSourceFiles);
  const collision = sourcePathCollision(files.map(file => file.path));
  if (collision) return err(sourceInvalid(collision));
  const entry = portableRelative(root, resolve(entryPath));
  if (!entry) return err(sourceInvalid(`Workflow entry '${entryPath}' could not be projected into its source bundle.`));
  const validatedEntry = validatePortablePath(entry);
  if (validatedEntry.isErr()) return err(validatedEntry.error);
  return ok({
    root,
    entry: validatedEntry.value,
    files,
    modulePaths: new Set([...captured.keys()].map(path => portableRelative(root, path))),
    diagnostics: remapDiagnostics(
      check.diagnostics.filter(diagnostic => diagnostic.code === "SC001"),
      root,
    ),
  });
}

export async function materializeFilesSource(
  scratchDir: string,
  workspaceDir: string,
  entry: string,
  files: readonly WorkflowSourceFile[],
): Promise<FrozenSource> {
  const sourceRoot = join(scratchDir, "source");
  await exposeWorkspaceDependencies(scratchDir, workspaceDir);
  await materializeFiles(sourceRoot, files);
  return frozenSource(
    sourceRoot,
    entry,
    files,
    new Set(files.filter(file => isSourceGraphTypeScript(file.path)).map(file => file.path)),
    entry,
  );
}

export async function materializeCapturedSource(
  scratchDir: string,
  workspaceDir: string,
  captured: CapturedSource,
  displayEntry: string,
): Promise<FrozenSource> {
  const sourceRoot = join(scratchDir, "source");
  await exposeWorkspaceDependencies(scratchDir, workspaceDir);
  await materializeFiles(sourceRoot, captured.files);
  return frozenSource(
    sourceRoot,
    captured.entry,
    captured.files,
    captured.modulePaths,
    displayEntry,
    captured.modulePaths,
    captured.diagnostics,
  );
}

export async function workspaceSourceGraph(
  check: WorkflowCheckResult,
  sourceRoot: string,
  entry: string,
): Promise<Result<{ sourceGraphDigest: Sha256Digest }, SourcePreparationFailure>> {
  if (!check.sourceFiles) return err(sourceChanged("Workflow source graph was unavailable after check."));
  const files = new Map<string, string>();
  for (const sourceFile of check.sourceFiles) {
    if (!isSourceGraphTypeScript(sourceFile.path)) continue;
    const path = workspaceGraphRelative(sourceRoot, sourceFile.path);
    if (path.isErr()) return err(path.error);
    files.set(path.value, sourceFile.content);
    const manifest = await nearestWorkspacePackageManifest(sourceFile.path, sourceRoot);
    if (manifest.isErr()) return err(manifest.error);
    if (manifest.value) files.set(manifest.value.path, manifest.value.content);
  }
  if (!files.has(entry)) return err(sourceChanged(`Workspace workflow entry '${entry}' was not present in its static source graph.`));
  const canonical = [...files].map(([path, content]) => ({ path, content })).sort(compareSourceFiles);
  return ok({ sourceGraphDigest: sourceGraphDigest(entry, canonical) });
}

export function validateFrozenClosure(
  check: WorkflowCheckResult,
  frozen: FrozenSource,
): Result<void, SourcePreparationFailure> {
  if (!check.sourceFiles) return err(sourceChanged("Frozen workflow source graph was unavailable."));
  const actual = new Set<string>();
  for (const sourceFile of check.sourceFiles) {
    if (!isSourceGraphTypeScript(sourceFile.path)) continue;
    const path = portableRelative(frozen.sourceRoot, resolve(sourceFile.path));
    if (!path) {
      return err(sourceChanged(`Frozen workflow discovered local source '${sourceFile.path}' outside its source bundle.`));
    }
    actual.add(path);
  }
  for (const path of actual) {
    if (!frozen.availableModulePaths.has(path)) {
      return err(sourceChanged(`Frozen workflow discovered local source '${path}' after capture.`));
    }
  }
  for (const path of frozen.expectedModulePaths ?? []) {
    if (!actual.has(path)) return err(sourceChanged(`Frozen workflow source '${path}' disappeared after capture.`));
  }
  return ok(undefined);
}

export function remapDiagnostics(
  diagnostics: readonly DiagnosticIR[],
  sourceRoot: string,
): DiagnosticIR[] {
  return diagnostics.map(diagnostic => {
    const source = diagnostic.source;
    if (!source?.file) return diagnostic;
    const path = portableRelative(sourceRoot, resolve(source.file));
    if (!path) return diagnostic;
    return {
      ...diagnostic,
      source: {
        ...source,
        file: path,
      },
    };
  });
}

export function sourceGraphDigest(entry: string, files: readonly WorkflowSourceFile[]): Sha256Digest {
  return sha256Digest(stableJsonLine({
    kind: "acpus_workflow_source_graph",
    version: 1,
    entry,
    files: files.map(file => ({ path: file.path, digest: sha256Digest(file.content) })),
  }));
}

function frozenSource(
  sourceRoot: string,
  entry: string,
  files: readonly WorkflowSourceFile[],
  availableModulePaths: ReadonlySet<string>,
  displayEntry: string,
  expectedModulePaths?: ReadonlySet<string>,
  discoveryDiagnostics?: readonly DiagnosticIR[],
): FrozenSource {
  const canonicalFiles = [...files].sort(compareSourceFiles);
  const digest = sourceGraphDigest(entry, canonicalFiles);
  return {
    entryPath: join(sourceRoot, ...entry.split("/")),
    displayEntry,
    sourceRoot,
    source: { kind: "snapshot", entry, digest },
    sourceBundle: {
      kind: "acpus_workflow_source_bundle",
      version: 1,
      files: canonicalFiles,
    },
    sourceGraphDigest: digest,
    availableModulePaths,
    ...(expectedModulePaths ? { expectedModulePaths } : {}),
    ...(discoveryDiagnostics ? { discoveryDiagnostics } : {}),
  };
}

async function nearestWorkspacePackageManifest(
  sourcePath: string,
  root: string,
): Promise<Result<WorkflowSourceFile | undefined, SourcePreparationFailure>> {
  let current = dirname(resolve(sourcePath));
  while (true) {
    const path = join(current, "package.json");
    try {
      const projected = workspaceGraphRelative(root, path);
      if (projected.isErr()) return err(projected.error);
      return ok({
        path: projected.value,
        content: await readFile(path, "utf8"),
      });
    } catch (cause) {
      if (!isMissingPathError(cause)) {
        return err(sourceInvalid(`Package manifest '${path}' could not be read: ${causeMessage(cause)}`));
      }
    }
    const parent = dirname(current);
    if (parent === current) return ok(undefined);
    current = parent;
  }
}

async function nearestPackageManifest(
  sourcePath: string,
): Promise<Result<{ path: string; content: string } | undefined, SourcePreparationFailure>> {
  let current = dirname(resolve(sourcePath));
  while (true) {
    const path = join(current, "package.json");
    try {
      await lstat(path);
      const stable = await readStableText(path);
      if (stable.isErr()) return err(stable.error);
      return ok({ path, content: stable.value });
    } catch (cause) {
      if (!isMissingPathError(cause)) {
        return err(sourceInvalid(`Package manifest '${path}' could not be inspected: ${causeMessage(cause)}`));
      }
    }
    const parent = dirname(current);
    if (parent === current) return ok(undefined);
    current = parent;
  }
}

async function readStableText(
  path: string,
  expected?: string,
): Promise<Result<string, SourcePreparationFailure>> {
  try {
    const before = await lstat(path, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n) {
      return err(sourceInvalid(`Workflow source '${path}' must be a regular, unlinked file.`));
    }
    const physical = await realpath(path);
    if (resolve(physical) !== resolve(path)) {
      return err(sourceInvalid(`Workflow source '${path}' must not pass through a symbolic link.`));
    }
    const content = UTF8.decode(await readFile(path));
    const after = await stat(path, { bigint: true });
    if (before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || before.mtimeNs !== after.mtimeNs
      || before.ctimeNs !== after.ctimeNs
      || (expected !== undefined && expected !== content)) {
      return err(sourceChanged(`Workflow source '${path}' changed while its source graph was captured.`));
    }
    return ok(content);
  } catch (cause) {
    if (isMissingPathError(cause)) return err(sourceChanged(`Workflow source '${path}' disappeared while it was captured.`));
    if (cause instanceof TypeError) return err(sourceInvalid(`Workflow source '${path}' is not valid UTF-8.`));
    return err(sourceInvalid(`Workflow source '${path}' could not be captured: ${causeMessage(cause)}`));
  }
}

export async function exposeWorkspaceDependencies(scratchDir: string, workspaceDir: string): Promise<void> {
  const dependencies = join(resolve(workspaceDir), "node_modules");
  const target = join(scratchDir, "node_modules");
  try {
    const info = await stat(dependencies);
    if (!info.isDirectory()) return;
    try {
      await lstat(target);
      return;
    } catch (cause) {
      if (!isMissingPathError(cause)) throw cause;
    }
    await symlink(dependencies, target, process.platform === "win32" ? "junction" : "dir");
  } catch (cause) {
    if (!isMissingPathError(cause)) throw cause;
  }
}

async function materializeFiles(root: string, files: readonly WorkflowSourceFile[]): Promise<void> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  for (const file of files) {
    const path = join(root, ...file.path.split("/"));
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, file.content, { encoding: "utf8", mode: 0o600, flag: "wx" });
  }
}

function validatePortablePath(path: string): Result<string, SourcePreparationFailure> {
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

function commonAncestor(paths: readonly string[]): string {
  if (paths.length === 0) throw new Error("Cannot derive a common source ancestor without files.");
  let current = resolve(paths[0]!);
  for (const path of paths.slice(1)) {
    const candidate = resolve(path);
    while (!isContained(current, candidate)) {
      const parent = dirname(current);
      if (parent === current) return current;
      current = parent;
    }
  }
  return current;
}

function portableRelative(root: string, path: string): string {
  const child = relative(resolve(root), resolve(path));
  if (child === "" || isAbsolute(child) || child.split(sep).includes("..")) return "";
  return child.split(sep).join("/");
}

function workspaceGraphRelative(
  root: string,
  path: string,
): Result<string, SourcePreparationFailure> {
  const child = relative(resolve(root), resolve(path));
  if (child === "" || isAbsolute(child)) {
    return err(sourceInvalid(
      `Workflow source graph path '${path}' cannot be represented relative to workspace '${root}'.`,
    ));
  }
  return ok(child.split(sep).join("/"));
}

function isContained(root: string, path: string): boolean {
  const child = relative(resolve(root), resolve(path));
  return child === "" || (!isAbsolute(child) && !child.split(sep).includes(".."));
}

function isSourceGraphTypeScript(path: string): boolean {
  return /\.(?:[cm]?ts|tsx)$/i.test(path);
}

function compareSourceFiles(left: WorkflowSourceFile, right: WorkflowSourceFile): number {
  return left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
}

function sourceInvalid(message: string): SourcePreparationFailure {
  return { type: "source-invalid", phase: "source", message };
}

function sourceChanged(message: string): SourcePreparationFailure {
  return { type: "source-changed", phase: "source", message };
}

function causeMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function isMissingPathError(cause: unknown): boolean {
  const code = cause && typeof cause === "object" && "code" in cause ? cause.code : undefined;
  return code === "ENOENT" || code === "ENOTDIR";
}
