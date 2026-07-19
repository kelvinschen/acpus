import { constants, createWriteStream } from "node:fs";
import { chmod, copyFile, lstat, mkdir, mkdtemp, open, readFile, readdir, rm, type FileHandle } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { extractWorkflowMetadata, tryPrepareWorkflow, type WorkflowPreparationFailure } from "@acpus/workflow-compiler";
import { type Entry, Reader, ZipReader } from "@zip.js/zip.js";
import { ResultAsync } from "neverthrow";
import { extract as extractTar, list as listTar, type ReadEntry } from "tar";
import {
  prepareWorkflowCatalogCommit,
  type AvailableWorkflowCatalogEntry,
  type WorkflowCatalogScope,
} from "./catalog.js";

export type WorkflowImportFailure =
  | { type: "usage"; message: string }
  | { type: "import"; errorCode: string; message: string }
  | { type: "preparation"; failure: WorkflowPreparationFailure };

export type WorkflowImportResult = {
  catalog: AvailableWorkflowCatalogEntry;
  checked: boolean;
};

type ImportOptions = {
  cwd: string;
  source: string;
  scope: WorkflowCatalogScope;
  check: boolean;
};

type SourceKind = "directory" | "typescript" | "zip" | "tar";
type ClassifiedSource =
  | { type: "local"; kind: SourceKind; path: string }
  | { type: "remote"; kind: Exclude<SourceKind, "directory">; url: URL };

type PathKind = "file" | "directory";

class ImportAbort extends Error {
  constructor(readonly failure: WorkflowImportFailure) {
    super(failure.type === "preparation" ? failure.failure.message : failure.message);
  }
}

export function importWorkflowPackage(options: ImportOptions): ResultAsync<WorkflowImportResult, WorkflowImportFailure> {
  return ResultAsync.fromPromise(runImport(options), cause => cause instanceof ImportAbort
    ? cause.failure
    : { type: "import", errorCode: "IMPORT_FAILED", message: `Workflow import failed: ${causeMessage(cause)}` });
}

async function runImport(options: ImportOptions): Promise<WorkflowImportResult> {
  const source = await classifySource(options.cwd, options.source);
  const importRoot = workflowImportRoot(options.cwd, options.scope);
  await mkdir(importRoot, { recursive: true });
  const stagingRoot = await mkdtemp(join(importRoot, "import-"));
  const stagedPackage = join(stagingRoot, "package");
  try {
    await stageSource(source, stagingRoot, stagedPackage);
    const entryPath = join(stagedPackage, "workflow.ts");
    const metadata = await extractWorkflowMetadata(await readFile(entryPath, "utf8"), entryPath);
    if (metadata.isErr()) abortImport("IMPORT_METADATA_INVALID", metadata.error.message);
    const name = metadata.value.name;
    const commit = await prepareWorkflowCatalogCommit(options.cwd, options.scope, name);
    if (commit.isErr()) abortImport(catalogImportErrorCode(commit.error.type), commit.error.message);

    if (options.check) await checkStagedWorkflow(options.cwd, options.scope, stagedPackage, name);
    const committed = await commit.value.commit(stagedPackage);
    if (committed.isErr()) abortImport(catalogImportErrorCode(committed.error.type), committed.error.message);
    return { checked: options.check, catalog: committed.value };
  } catch (error) {
    if (error instanceof ImportAbort) throw error;
    abortImport("IMPORT_FAILED", `Workflow import failed: ${causeMessage(error)}`);
  } finally {
    await removePrivateTree(stagingRoot).catch(() => undefined);
  }
}

async function classifySource(cwd: string, source: string): Promise<ClassifiedSource> {
  if (/^https?:\/\//i.test(source)) {
    let url: URL;
    try {
      url = new URL(source);
    } catch {
      abortUsage("Workflow import URL is invalid.");
    }
    assertHttpUrl(url);
    return { type: "remote", kind: suffixKind(url.pathname), url };
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(source) && !/^[a-z]:[\\/]/i.test(source)) abortUsage("Workflow import URLs must use HTTP or HTTPS.");
  const path = resolve(cwd, source);
  let item;
  try {
    item = await lstat(path);
  } catch (error) {
    abortImport("IMPORT_SOURCE_UNAVAILABLE", `Workflow import source could not be read: ${causeMessage(error)}`);
  }
  if (item.isSymbolicLink()) abortImport("IMPORT_SOURCE_INVALID", "Workflow import source cannot be a symbolic link.");
  if (item.isDirectory()) return { type: "local", kind: "directory", path };
  if (!item.isFile()) abortImport("IMPORT_SOURCE_INVALID", "Workflow import source must be a regular file or directory.");
  if (item.nlink !== 1) abortImport("IMPORT_SOURCE_INVALID", "Workflow import source cannot be a hard link.");
  return { type: "local", kind: suffixKind(path), path };
}

function suffixKind(path: string): Exclude<SourceKind, "directory"> {
  const lower = path.toLocaleLowerCase("en-US");
  if (lower.endsWith(".tar.gz") || lower.endsWith(".tgz")) return "tar";
  if (lower.endsWith(".zip")) return "zip";
  if (lower.endsWith(".ts")) return "typescript";
  abortUsage("Workflow import source must be a directory or end in .ts, .zip, .tar.gz, or .tgz.");
}

async function stageSource(source: ClassifiedSource, stagingRoot: string, stagedPackage: string): Promise<void> {
  if (source.kind === "typescript") {
    await mkdir(stagedPackage, { recursive: true });
    if (source.type === "local") {
      await copyFile(source.path, join(stagedPackage, "workflow.ts"));
      await chmod(join(stagedPackage, "workflow.ts"), (await lstat(source.path)).mode & 0o777);
    } else {
      await download(source.url, join(stagedPackage, "workflow.ts"));
    }
    return;
  }

  if (source.kind === "directory" && source.type === "local") {
    const packageRoot = await resolvePackageRoot(source.path);
    await copyValidatedTree(packageRoot, stagedPackage);
    return;
  }

  const archivePath = join(stagingRoot, source.kind === "zip" ? "source.zip" : "source.tar.gz");
  if (source.type === "remote") await download(source.url, archivePath);
  else await copyFile(source.path, archivePath);
  const unpacked = join(stagingRoot, "unpacked");
  await mkdir(unpacked, { recursive: true });
  if (source.kind === "zip") await unpackZip(archivePath, unpacked);
  else await unpackTar(archivePath, unpacked);
  const packageRoot = await resolvePackageRoot(unpacked);
  await copyValidatedTree(packageRoot, stagedPackage);
}

async function download(initialUrl: URL, destination: string): Promise<void> {
  let url = initialUrl;
  for (let redirects = 0; ; redirects += 1) {
    let response: Response;
    try {
      response = await fetch(url, { redirect: "manual" });
    } catch (error) {
      abortImport("IMPORT_DOWNLOAD_FAILED", `Workflow download failed: ${causeMessage(error)}`);
    }
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      if (redirects >= 5) abortImport("IMPORT_DOWNLOAD_FAILED", "Workflow download exceeded 5 redirects.");
      const location = response.headers.get("location");
      if (!location) abortImport("IMPORT_DOWNLOAD_FAILED", "Workflow download redirect did not include a Location header.");
      try {
        url = new URL(location, url);
      } catch {
        abortImport("IMPORT_DOWNLOAD_FAILED", "Workflow download redirect target is invalid.");
      }
      assertHttpUrl(url, "IMPORT_DOWNLOAD_FAILED");
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      abortImport("IMPORT_DOWNLOAD_FAILED", `Workflow download returned HTTP ${response.status}.`);
    }
    if (!response.body) abortImport("IMPORT_DOWNLOAD_FAILED", "Workflow download returned an empty response body.");
    try {
      await pipeline(Readable.from(response.body), createWriteStream(destination, { flags: "wx" }));
    } catch (error) {
      abortImport("IMPORT_DOWNLOAD_FAILED", `Workflow download could not be written: ${causeMessage(error)}`);
    }
    return;
  }
}

function assertHttpUrl(url: URL, errorCode?: string): void {
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
    if (errorCode) abortImport(errorCode, "Workflow download redirects must remain anonymous HTTP or HTTPS URLs.");
    abortUsage("Workflow import URL must be an anonymous HTTP or HTTPS URL.");
  }
}

async function unpackZip(archivePath: string, target: string): Promise<void> {
  const fileReader = new NodeFileReader(archivePath);
  let reader: ZipReader<string> | undefined;
  try {
    reader = new ZipReader(fileReader);
    const entries = await reader.getEntries();
    const inventory = new PathInventory();
    const validated = entries.map(entry => validateZipEntry(entry, inventory));
    const directories: Array<{ path: string; mode: number }> = [];
    for (const { entry, relativePath, mode, kind } of validated) {
      const outputPath = join(target, ...relativePath.split("/"));
      if (kind === "directory") {
        await mkdir(outputPath, { recursive: true });
        directories.push({ path: outputPath, mode });
      } else {
        await mkdir(dirname(outputPath), { recursive: true });
        await entry.getData(Writable.toWeb(createWriteStream(outputPath, { flags: "wx" })), { checkOverlappingEntry: true });
        await chmod(outputPath, mode);
      }
    }
    directories.sort((left, right) => right.path.length - left.path.length);
    for (const directory of directories) await chmod(directory.path, directory.mode);
  } catch (error) {
    if (error instanceof ImportAbort) throw error;
    abortImport("IMPORT_ARCHIVE_INVALID", `ZIP archive could not be safely unpacked: ${causeMessage(error)}`);
  } finally {
    await reader?.close().catch(() => undefined);
    await fileReader.close().catch(() => undefined);
  }
}

class NodeFileReader extends Reader<string> {
  private file: FileHandle | undefined;

  constructor(private readonly path: string) {
    super(path);
  }

  async init(): Promise<void> {
    await super.init?.();
    this.file = await open(this.path, "r");
    this.size = (await this.file.stat()).size;
  }

  async readUint8Array(index: number, length: number): Promise<Uint8Array> {
    if (!this.file) throw new Error("ZIP file reader was not initialized.");
    const buffer = Buffer.allocUnsafe(length);
    const { bytesRead } = await this.file.read(buffer, 0, length, index);
    return new Uint8Array(buffer.subarray(0, bytesRead));
  }

  async close(): Promise<void> {
    await this.file?.close();
    this.file = undefined;
  }
}

function validateZipEntry(entry: Entry, inventory: PathInventory): { entry: Exclude<Entry, { directory: true }>; relativePath: string; mode: number; kind: "file" }
  | { entry: Entry; relativePath: string; mode: number; kind: "directory" } {
  if (entry.encrypted) abortImport("IMPORT_ARCHIVE_INVALID", "Encrypted ZIP entries are not supported.");
  const unixType = entry.unixMode === undefined ? 0 : entry.unixMode & 0o170000;
  const kind: PathKind = entry.directory ? "directory" : "file";
  if (unixType !== 0 && unixType !== (entry.directory ? 0o040000 : 0o100000)) {
    abortImport("IMPORT_ARCHIVE_INVALID", `ZIP entry '${entry.filename}' is not a regular file or directory.`);
  }
  const relativePath = inventory.add(entry.filename, kind);
  const mode = (entry.unixMode ?? (entry.directory ? 0o755 : entry.executable ? 0o755 : 0o644)) & 0o777;
  if (entry.directory) return { entry, relativePath, mode, kind: "directory" };
  return { entry, relativePath, mode, kind: "file" };
}

async function unpackTar(archivePath: string, target: string): Promise<void> {
  const inventory = new PathInventory();
  const modes = new Map<string, number>();
  let validationFailure: ImportAbort | undefined;
  try {
    await listTar({
      file: archivePath,
      strict: true,
      maxDepth: Infinity,
      maxDecompressionRatio: Infinity,
      onReadEntry: entry => {
        if (validationFailure) return;
        try {
          const kind = tarEntryKind(entry);
          inventory.add(entry.path, kind);
          const mode = (entry.mode ?? (kind === "directory" ? 0o755 : 0o644)) & 0o777;
          modes.set(entry.path, mode);
        } catch (error) {
          if (error instanceof ImportAbort) validationFailure = error;
          else throw error;
        }
      },
    });
    if (validationFailure) throw validationFailure;
    await extractTar({
      file: archivePath,
      cwd: target,
      strict: true,
      preservePaths: false,
      preserveOwner: false,
      maxDepth: Infinity,
      maxDecompressionRatio: Infinity,
      chmod: true,
      processUmask: 0,
      filter: (_path, rawEntry) => {
        const entry = rawEntry as ReadEntry;
        const mode = modes.get(entry.path);
        if (mode === undefined) return false;
        entry.mode = mode;
        return true;
      },
    });
  } catch (error) {
    if (error instanceof ImportAbort) throw error;
    abortImport("IMPORT_ARCHIVE_INVALID", `TAR archive could not be safely unpacked: ${causeMessage(error)}`);
  }
}

function tarEntryKind(entry: ReadEntry): PathKind {
  if (entry.type === "Directory") return "directory";
  if (entry.type === "File" || entry.type === "OldFile") return "file";
  abortImport("IMPORT_ARCHIVE_INVALID", `TAR entry '${entry.path}' has unsupported type ${entry.type}.`);
}

class PathInventory {
  readonly entries = new Map<string, PathKind>();
  readonly parents = new Set<string>();

  constructor(
    private readonly errorCode = "IMPORT_ARCHIVE_INVALID",
    private readonly subject = "Archive",
  ) {}

  add(rawPath: string, kind: PathKind): string {
    const path = safeRelativePath(rawPath, this.errorCode, this.subject);
    const key = collisionKey(path);
    if (this.entries.has(key)) abortImport(this.errorCode, `${this.subject} contains duplicate or cross-platform-colliding path '${rawPath}'.`);
    const parts = key.split("/");
    for (let index = 1; index < parts.length; index += 1) {
      const parent = parts.slice(0, index).join("/");
      if (this.entries.get(parent) === "file") {
        abortImport(this.errorCode, `${this.subject} path '${rawPath}' descends through a file.`);
      }
      this.parents.add(parent);
    }
    if (kind === "file" && this.parents.has(key)) {
      abortImport(this.errorCode, `${this.subject} file '${rawPath}' conflicts with a directory path.`);
    }
    this.entries.set(key, kind);
    return path;
  }
}

function safeRelativePath(rawPath: string, errorCode: string, subject: string): string {
  if (rawPath.includes("\0") || rawPath.includes("\\") || rawPath.startsWith("/") || /^[a-z]:/i.test(rawPath)) {
    abortImport(errorCode, `${subject} path '${rawPath}' is not a safe relative POSIX path.`);
  }
  const path = rawPath.endsWith("/") ? rawPath.slice(0, -1) : rawPath;
  const parts = path.split("/");
  if (parts.length === 0 || parts.some(part => part === "" || part === "." || part === "..")) {
    abortImport(errorCode, `${subject} path '${rawPath}' is not a safe relative POSIX path.`);
  }
  return parts.join("/");
}

function collisionKey(path: string): string {
  return path.normalize("NFC").toLocaleLowerCase("en-US");
}

async function resolvePackageRoot(root: string): Promise<string> {
  if (await isRegularFile(join(root, "workflow.ts"))) return root;
  const entries = await readdir(root, { withFileTypes: true });
  if (entries.length !== 1 || !entries[0]!.isDirectory()) {
    abortImport("IMPORT_PACKAGE_INVALID", "Workflow package must contain workflow.ts at its root or inside one wrapper directory.");
  }
  const wrapper = join(root, entries[0]!.name);
  if (!await isRegularFile(join(wrapper, "workflow.ts"))) {
    abortImport("IMPORT_PACKAGE_INVALID", "Workflow package wrapper must contain workflow.ts.");
  }
  return wrapper;
}

async function copyValidatedTree(sourceRoot: string, targetRoot: string): Promise<void> {
  const inventory = new PathInventory("IMPORT_PACKAGE_INVALID", "Workflow package");
  await copyDirectory(sourceRoot, targetRoot, "", inventory);
}

async function copyDirectory(source: string, target: string, relativePath: string, inventory: PathInventory): Promise<void> {
  const item = await lstat(source);
  if (!item.isDirectory()) abortImport("IMPORT_PACKAGE_INVALID", "Workflow package root must be a regular directory.");
  if (relativePath) inventory.add(relativePath.split(sep).join("/"), "directory");
  await mkdir(target, { recursive: true });
  const entries = await readdir(source, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const sourcePath = join(source, entry.name);
    const targetPath = join(target, entry.name);
    const childRelative = relativePath ? join(relativePath, entry.name) : entry.name;
    const child = await lstat(sourcePath);
    if (child.isSymbolicLink()) abortImport("IMPORT_PACKAGE_INVALID", `Workflow package path '${childRelative}' cannot be a symbolic link.`);
    if (child.isDirectory()) {
      await copyDirectory(sourcePath, targetPath, childRelative, inventory);
      continue;
    }
    if (!child.isFile()) abortImport("IMPORT_PACKAGE_INVALID", `Workflow package path '${childRelative}' must be a regular file or directory.`);
    if (child.nlink !== 1) abortImport("IMPORT_PACKAGE_INVALID", `Workflow package path '${childRelative}' cannot be a hard link.`);
    inventory.add(childRelative.split(sep).join("/"), "file");
    await copyFile(sourcePath, targetPath, constants.COPYFILE_EXCL);
    await chmod(targetPath, child.mode & 0o777);
  }
  await chmod(target, item.mode & 0o777);
}

async function checkStagedWorkflow(cwd: string, scope: WorkflowCatalogScope, stagedPackage: string, expectedName: string): Promise<void> {
  let checkRoot: string | undefined;
  let entryPath = join(stagedPackage, "workflow.ts");
  try {
    if (scope === "global") {
      const localRoot = resolve(cwd, ".acpus", ".local");
      await mkdir(localRoot, { recursive: true });
      checkRoot = await mkdtemp(join(localRoot, "workflow-import-check-"));
      const localPackage = join(checkRoot, "package");
      await copyValidatedTree(stagedPackage, localPackage);
      entryPath = join(localPackage, "workflow.ts");
    }
    const prepared = await tryPrepareWorkflow({ workflow: entryPath, cwd });
    if (prepared.isErr()) throw new ImportAbort({ type: "preparation", failure: prepared.error });
    if (prepared.value.ir.name !== expectedName) {
      abortImport("IMPORT_CHECK_NAME_MISMATCH", `Prepared workflow name '${prepared.value.ir.name}' does not match static authored name '${expectedName}'.`);
    }
  } finally {
    if (checkRoot) await removePrivateTree(checkRoot).catch(() => undefined);
  }
}

async function isRegularFile(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isFile();
  } catch (error) {
    if (isMissingPath(error)) return false;
    throw error;
  }
}

async function removePrivateTree(root: string): Promise<void> {
  try {
    await rm(root, { recursive: true, force: true });
    return;
  } catch {
    await makeRemovable(root);
    await rm(root, { recursive: true, force: true });
  }
}

async function makeRemovable(path: string): Promise<void> {
  let item;
  try {
    item = await lstat(path);
  } catch (error) {
    if (isMissingPath(error)) return;
    throw error;
  }
  if (!item.isDirectory()) {
    if (!item.isSymbolicLink()) await chmod(path, 0o600);
    return;
  }
  await chmod(path, 0o700);
  for (const name of await readdir(path)) await makeRemovable(join(path, name));
}

function abortUsage(message: string): never {
  throw new ImportAbort({ type: "usage", message });
}

function abortImport(errorCode: string, message: string): never {
  throw new ImportAbort({ type: "import", errorCode, message });
}

function isMissingPath(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR"));
}

function causeMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function workflowImportRoot(cwd: string, scope: WorkflowCatalogScope): string {
  return scope === "project"
    ? resolve(cwd, ".acpus", ".local", "workflow-imports")
    : resolve(process.env.HOME || homedir(), ".acpus", ".local", "workflow-imports");
}

function catalogImportErrorCode(type: "invalid-name" | "collision" | "commit-failed"): string {
  if (type === "invalid-name") return "IMPORT_NAME_INVALID";
  if (type === "collision") return "IMPORT_COLLISION";
  return "IMPORT_COMMIT_FAILED";
}
