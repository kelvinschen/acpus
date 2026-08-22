import { lstat, mkdir, readFile, realpath, stat, symlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import type { Sha256Digest } from "@acpus/core/content-identity";
import type { DiagnosticIR, WorkflowIR } from "@acpus/core/ir";
import * as Result from "effect/Result";
import { checkWorkflow, type WorkflowCheckResult } from "../check/runner.js";
import {
  canonicalizeFilesSource,
  canonicalizeSourcePath,
  mergeSourceDiagnostics,
  portableSourcePath,
  remapSourceDiagnostics,
  sourceGraphDigest,
  type SourcePreparationFailure,
  type WorkflowSourceBundle,
  type WorkflowSourceFile,
  type WorkflowSourceInput,
  type WorkflowSourceRef,
} from "./source-model.js";

type ResolvedPathSource =
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

type FrozenSource = {
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

type PreparedWorkflowSourceBase = {
  check: WorkflowCheckResult;
  entryPath: string;
  sourceRoot: string;
  sourceGraphDigest: Sha256Digest;
  displayEntry: string;
  diagnosticSourceRoot?: string;
};

type PreparedWorkflowSource =
  | PreparedWorkflowSourceBase & {
      source: Extract<WorkflowSourceRef, { kind: "workspace" }>;
      sourceBundle?: never;
    }
  | PreparedWorkflowSourceBase & {
      source: Extract<WorkflowSourceRef, { kind: "snapshot" }>;
      sourceBundle: WorkflowSourceBundle;
      diagnosticSourceRoot: string;
    };

export type WorkflowSourcePreparationFailure =
  | SourcePreparationFailure
  | {
      type: "check-failed";
      phase: "check";
      message: string;
      diagnostics: WorkflowIR["diagnostics"];
    };

const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export async function prepareWorkflowSource(input: {
  workspaceDir: string;
  scratchDir: string;
  source: WorkflowSourceInput;
}): Promise<Result.Result<PreparedWorkflowSource, WorkflowSourcePreparationFailure>> {
  if (input.source.kind === "files") {
    const validated = canonicalizeFilesSource(input.source);
    if (Result.isFailure(validated)) return Result.fail(validated.failure);
    const modulePaths = new Set(
      validated.success.files
        .filter(file => isSourceGraphTypeScript(file.path))
        .map(file => file.path),
    );
    const frozen = await materializeSource(
      input.scratchDir,
      input.workspaceDir,
      {
        entry: validated.success.entry,
        files: validated.success.files,
        modulePaths,
        displayEntry: validated.success.entry,
      },
    );
    return prepareFrozenSource(input.workspaceDir, input.scratchDir, frozen);
  }

  const resolved = await resolvePathSource(input.workspaceDir, input.source.entry);
  if (Result.isFailure(resolved)) return Result.fail(resolved.failure);
  if (resolved.success.kind === "workspace") {
    const checkedWorkflow = await checkWorkflow(
      resolved.success.entryPath,
      input.workspaceDir,
      input.scratchDir,
    );
    const check = {
      ...checkedWorkflow,
      diagnostics: sanitizeDiagnostics(checkedWorkflow.diagnostics, input.scratchDir),
    };
    const checked = checkFailure(check);
    if (checked) return Result.fail(checked);
    const graph = await workspaceSourceGraph(
      check,
      resolved.success.sourceRoot,
      resolved.success.source.entry,
    );
    if (Result.isFailure(graph)) return Result.fail(graph.failure);
    return Result.succeed({
      check,
      entryPath: resolved.success.entryPath,
      sourceRoot: resolved.success.sourceRoot,
      source: resolved.success.source,
      sourceGraphDigest: graph.success.sourceGraphDigest,
      displayEntry: resolved.success.entryPath,
    });
  }

  await exposeWorkspaceDependencies(input.scratchDir, input.workspaceDir);
  const discoveredWorkflow = await checkWorkflow(
    resolved.success.entryPath,
    input.workspaceDir,
    input.scratchDir,
    { dependencyFallback: true },
  );
  const discovery = {
    ...discoveredWorkflow,
    diagnostics: sanitizeDiagnostics(discoveredWorkflow.diagnostics, input.scratchDir),
  };
  const discoveryFailure = checkFailure(discovery);
  if (discoveryFailure) return Result.fail(discoveryFailure);
  const captured = await capturePathSource(discovery, resolved.success.entryPath);
  if (Result.isFailure(captured)) return Result.fail(captured.failure);
  const frozen = await materializeSource(
    input.scratchDir,
    input.workspaceDir,
    {
      entry: captured.success.entry,
      files: captured.success.files,
      modulePaths: captured.success.modulePaths,
      expectedModulePaths: captured.success.modulePaths,
      diagnostics: captured.success.diagnostics,
      displayEntry: resolved.success.displayEntry,
    },
  );
  return prepareFrozenSource(input.workspaceDir, input.scratchDir, frozen);
}

async function prepareFrozenSource(
  workspaceDir: string,
  scratchDir: string,
  frozen: FrozenSource,
): Promise<Result.Result<PreparedWorkflowSource, WorkflowSourcePreparationFailure>> {
  const checkedWorkflow = await checkWorkflow(frozen.entryPath, workspaceDir, scratchDir);
  const authoritativeDiagnostics = sanitizeDiagnostics(
    remapSourceDiagnostics(checkedWorkflow.diagnostics, frozen.sourceRoot),
    scratchDir,
  );
  const diagnostics = mergeSourceDiagnostics(
    frozen.discoveryDiagnostics ?? [],
    authoritativeDiagnostics,
  );
  const check = { ...checkedWorkflow, diagnostics };
  const checked = checkFailure(check);
  if (checked) return Result.fail(checked);
  const closure = validateFrozenClosure(check, frozen);
  if (Result.isFailure(closure)) return Result.fail(closure.failure);
  return Result.succeed({
    check,
    entryPath: frozen.entryPath,
    sourceRoot: frozen.sourceRoot,
    source: frozen.source,
    sourceBundle: frozen.sourceBundle,
    sourceGraphDigest: frozen.sourceGraphDigest,
    diagnosticSourceRoot: frozen.sourceRoot,
    displayEntry: frozen.displayEntry,
  });
}

function checkFailure(
  check: WorkflowCheckResult,
): Extract<WorkflowSourcePreparationFailure, { type: "check-failed" }> | undefined {
  return check.diagnostics.some(diagnostic => diagnostic.severity === "error")
    ? {
        type: "check-failed",
        phase: "check",
        message: "Workflow check failed.",
        diagnostics: check.diagnostics,
      }
    : undefined;
}

async function resolvePathSource(
  workspaceDir: string,
  entry: string,
): Promise<Result.Result<ResolvedPathSource, SourcePreparationFailure>> {
  const workspace = resolve(workspaceDir);
  const entryPath = resolve(workspace, entry);
  let physicalWorkspace: string;
  try {
    physicalWorkspace = await realpath(workspace);
  } catch (cause) {
    return Result.fail(sourceInvalid(`Workflow workspace '${workspace}' could not be resolved: ${causeMessage(cause)}`));
  }

  try {
    const physicalEntry = await realpath(entryPath);
    if (isContained(physicalWorkspace, physicalEntry)) {
      const sourceEntry = portableSourcePath(physicalWorkspace, physicalEntry);
      if (!sourceEntry) return Result.fail(sourceInvalid(`Workflow entry '${entryPath}' must be a file inside workspace '${workspace}'.`));
      const validatedEntry = canonicalizeSourcePath(sourceEntry);
      if (Result.isFailure(validatedEntry)) return Result.fail(validatedEntry.failure);
      return Result.succeed({
        kind: "workspace",
        entryPath: physicalEntry,
        sourceRoot: physicalWorkspace,
        source: { kind: "workspace", entry: validatedEntry.success },
      });
    }
    return Result.succeed({ kind: "snapshot", entryPath, displayEntry: entryPath });
  } catch (cause) {
    if (!isMissingPathError(cause)) {
      return Result.fail(sourceInvalid(`Workflow entry '${entryPath}' could not be resolved: ${causeMessage(cause)}`));
    }
    const lexicalEntry = portableSourcePath(workspace, entryPath);
    if (lexicalEntry) {
      const validatedEntry = canonicalizeSourcePath(lexicalEntry);
      if (Result.isFailure(validatedEntry)) return Result.fail(validatedEntry.failure);
      return Result.succeed({
        kind: "workspace",
        entryPath,
        sourceRoot: physicalWorkspace,
        source: { kind: "workspace", entry: validatedEntry.success },
      });
    }
    return Result.succeed({ kind: "snapshot", entryPath, displayEntry: entryPath });
  }
}

async function capturePathSource(
  check: WorkflowCheckResult,
  entryPath: string,
): Promise<Result.Result<CapturedSource, SourcePreparationFailure>> {
  if (!check.sourceFiles) return Result.fail(sourceChanged("Workflow source graph was unavailable after discovery."));
  const captured = new Map<string, string>();
  for (const sourceFile of check.sourceFiles) {
    if (!isSourceGraphTypeScript(sourceFile.path)) continue;
    const stable = await readStableText(sourceFile.path, sourceFile.content);
    if (Result.isFailure(stable)) return Result.fail(stable.failure);
    captured.set(resolve(sourceFile.path), stable.success);
  }
  if (!captured.has(resolve(entryPath))) {
    return Result.fail(sourceChanged(`Workflow entry '${entryPath}' was not present in its discovered static source graph.`));
  }

  const manifests = new Map<string, string>();
  const manifestBySource = new Map<string, string>();
  for (const path of captured.keys()) {
    const manifest = await nearestPackageManifest(path);
    if (Result.isFailure(manifest)) return Result.fail(manifest.failure);
    if (manifest.success) {
      manifests.set(manifest.success.path, manifest.success.content);
      manifestBySource.set(path, manifest.success.path);
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
    path: portableSourcePath(root, path) ?? "",
    content,
  }));
  for (const [path, content] of manifests) {
    files.push({
      path: portableSourcePath(root, path) ?? "package.json",
      content,
    });
  }
  if (files.some(file => !file.path)) {
    return Result.fail(sourceInvalid("Workflow source graph could not be projected beneath one source root."));
  }
  const entry = portableSourcePath(root, entryPath);
  if (!entry) {
    return Result.fail(sourceInvalid(`Workflow entry '${entryPath}' could not be projected into its source bundle.`));
  }
  const canonical = canonicalizeFilesSource({ kind: "files", entry, files });
  if (Result.isFailure(canonical)) return Result.fail(canonical.failure);
  return Result.succeed({
    root,
    entry: canonical.success.entry,
    files: canonical.success.files,
    modulePaths: new Set(
      [...captured.keys()]
        .map(path => portableSourcePath(root, path))
        .filter((path): path is string => path !== undefined),
    ),
    diagnostics: remapSourceDiagnostics(
      check.diagnostics.filter(diagnostic => diagnostic.code === "SC001"),
      root,
    ),
  });
}

async function materializeSource(
  scratchDir: string,
  workspaceDir: string,
  source: {
    entry: string;
    files: readonly WorkflowSourceFile[];
    modulePaths: ReadonlySet<string>;
    displayEntry: string;
    expectedModulePaths?: ReadonlySet<string>;
    diagnostics?: readonly DiagnosticIR[];
  },
): Promise<FrozenSource> {
  const sourceRoot = join(scratchDir, "source");
  await exposeWorkspaceDependencies(scratchDir, workspaceDir);
  await materializeFiles(sourceRoot, source.files);
  const files = [...source.files];
  const digest = sourceGraphDigest(source.entry, files);
  return {
    entryPath: join(sourceRoot, ...source.entry.split("/")),
    displayEntry: source.displayEntry,
    sourceRoot,
    source: { kind: "snapshot", entry: source.entry, digest },
    sourceBundle: {
      kind: "acpus_workflow_source_bundle",
      version: 1,
      files,
    },
    sourceGraphDigest: digest,
    availableModulePaths: source.modulePaths,
    ...(source.expectedModulePaths ? { expectedModulePaths: source.expectedModulePaths } : {}),
    ...(source.diagnostics ? { discoveryDiagnostics: source.diagnostics } : {}),
  };
}

async function workspaceSourceGraph(
  check: WorkflowCheckResult,
  sourceRoot: string,
  entry: string,
): Promise<Result.Result<{ sourceGraphDigest: Sha256Digest }, SourcePreparationFailure>> {
  if (!check.sourceFiles) return Result.fail(sourceChanged("Workflow source graph was unavailable after check."));
  const files = new Map<string, string>();
  for (const sourceFile of check.sourceFiles) {
    if (!isSourceGraphTypeScript(sourceFile.path)) continue;
    const path = workspaceGraphRelative(sourceRoot, sourceFile.path);
    if (Result.isFailure(path)) return Result.fail(path.failure);
    files.set(path.success, sourceFile.content);
    const manifest = await nearestWorkspacePackageManifest(sourceFile.path, sourceRoot);
    if (Result.isFailure(manifest)) return Result.fail(manifest.failure);
    if (manifest.success) files.set(manifest.success.path, manifest.success.content);
  }
  if (!files.has(entry)) return Result.fail(sourceChanged(`Workspace workflow entry '${entry}' was not present in its static source graph.`));
  return Result.succeed({
    sourceGraphDigest: sourceGraphDigest(
      entry,
      [...files].map(([path, content]) => ({ path, content })),
    ),
  });
}

function validateFrozenClosure(
  check: WorkflowCheckResult,
  frozen: FrozenSource,
): Result.Result<void, SourcePreparationFailure> {
  if (!check.sourceFiles) return Result.fail(sourceChanged("Frozen workflow source graph was unavailable."));
  const actual = new Set<string>();
  for (const sourceFile of check.sourceFiles) {
    if (!isSourceGraphTypeScript(sourceFile.path)) continue;
    const path = portableSourcePath(frozen.sourceRoot, resolve(sourceFile.path));
    if (!path) {
      return Result.fail(sourceChanged(`Frozen workflow discovered local source '${sourceFile.path}' outside its source bundle.`));
    }
    actual.add(path);
  }
  for (const path of actual) {
    if (!frozen.availableModulePaths.has(path)) {
      return Result.fail(sourceChanged(`Frozen workflow discovered local source '${path}' after capture.`));
    }
  }
  for (const path of frozen.expectedModulePaths ?? []) {
    if (!actual.has(path)) return Result.fail(sourceChanged(`Frozen workflow source '${path}' disappeared after capture.`));
  }
  return Result.succeed(undefined);
}

async function nearestWorkspacePackageManifest(
  sourcePath: string,
  root: string,
): Promise<Result.Result<WorkflowSourceFile | undefined, SourcePreparationFailure>> {
  let current = dirname(resolve(sourcePath));
  while (true) {
    const path = join(current, "package.json");
    try {
      const projected = workspaceGraphRelative(root, path);
      if (Result.isFailure(projected)) return Result.fail(projected.failure);
      return Result.succeed({
        path: projected.success,
        content: await readFile(path, "utf8"),
      });
    } catch (cause) {
      if (!isMissingPathError(cause)) {
        return Result.fail(sourceInvalid(`Package manifest '${path}' could not be read: ${causeMessage(cause)}`));
      }
    }
    const parent = dirname(current);
    if (parent === current) return Result.succeed(undefined);
    current = parent;
  }
}

async function nearestPackageManifest(
  sourcePath: string,
): Promise<Result.Result<{ path: string; content: string } | undefined, SourcePreparationFailure>> {
  let current = dirname(resolve(sourcePath));
  while (true) {
    const path = join(current, "package.json");
    try {
      await lstat(path);
      const stable = await readStableText(path);
      if (Result.isFailure(stable)) return Result.fail(stable.failure);
      return Result.succeed({ path, content: stable.success });
    } catch (cause) {
      if (!isMissingPathError(cause)) {
        return Result.fail(sourceInvalid(`Package manifest '${path}' could not be inspected: ${causeMessage(cause)}`));
      }
    }
    const parent = dirname(current);
    if (parent === current) return Result.succeed(undefined);
    current = parent;
  }
}

async function readStableText(
  path: string,
  expected?: string,
): Promise<Result.Result<string, SourcePreparationFailure>> {
  try {
    const before = await lstat(path, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n) {
      return Result.fail(sourceInvalid(`Workflow source '${path}' must be a regular, unlinked file.`));
    }
    const physical = await realpath(path);
    if (resolve(physical) !== resolve(path)) {
      return Result.fail(sourceInvalid(`Workflow source '${path}' must not pass through a symbolic link.`));
    }
    const content = UTF8.decode(await readFile(path));
    const after = await stat(path, { bigint: true });
    if (before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || before.mtimeNs !== after.mtimeNs
      || before.ctimeNs !== after.ctimeNs
      || (expected !== undefined && expected !== content)) {
      return Result.fail(sourceChanged(`Workflow source '${path}' changed while its source graph was captured.`));
    }
    return Result.succeed(content);
  } catch (cause) {
    if (isMissingPathError(cause)) return Result.fail(sourceChanged(`Workflow source '${path}' disappeared while it was captured.`));
    if (cause instanceof TypeError) return Result.fail(sourceInvalid(`Workflow source '${path}' is not valid UTF-8.`));
    return Result.fail(sourceInvalid(`Workflow source '${path}' could not be captured: ${causeMessage(cause)}`));
  }
}

async function exposeWorkspaceDependencies(scratchDir: string, workspaceDir: string): Promise<void> {
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

function workspaceGraphRelative(
  root: string,
  path: string,
): Result.Result<string, SourcePreparationFailure> {
  const child = relative(resolve(root), resolve(path));
  if (child === "" || isAbsolute(child)) {
    return Result.fail(sourceInvalid(
      `Workflow source graph path '${path}' cannot be represented relative to workspace '${root}'.`,
    ));
  }
  return Result.succeed(child.split(sep).join("/"));
}

function isContained(root: string, path: string): boolean {
  const child = relative(resolve(root), resolve(path));
  return child === "" || (!isAbsolute(child) && !child.split(sep).includes(".."));
}

function isSourceGraphTypeScript(path: string): boolean {
  return /\.(?:[cm]?ts|tsx)$/i.test(path);
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

function sanitizeDiagnostics(
  diagnostics: readonly DiagnosticIR[],
  scratchDir: string,
): DiagnosticIR[] {
  const absolute = resolve(scratchDir);
  const references = [pathToFileURL(absolute).href, absolute];
  return replaceStrings(
    diagnostics,
    value => references.reduce(
      (current, reference) => current.replaceAll(reference, "<workflow-scratch>"),
      value,
    ),
  ) as DiagnosticIR[];
}

function replaceStrings(value: unknown, replace: (value: string) => string): unknown {
  if (typeof value === "string") return replace(value);
  if (Array.isArray(value)) return value.map(item => replaceStrings(item, replace));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replaceStrings(item, replace)]));
}
