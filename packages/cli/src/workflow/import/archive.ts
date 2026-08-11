import { createWriteStream } from "node:fs";
import { chmod, mkdir, open, type FileHandle } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Writable } from "node:stream";
import { type Entry, Reader, ZipReader } from "@zip.js/zip.js";
import { extract as extractTar, list as listTar, type ReadEntry } from "tar";
import { abortImport, causeMessage, WorkflowImportAbort } from "./failure.js";

type PathKind = "file" | "directory";

export async function extractWorkflowImportArchive(
  kind: "zip" | "tar",
  archivePath: string,
  target: string,
): Promise<void> {
  if (kind === "zip") await unpackZip(archivePath, target);
  else await unpackTar(archivePath, target);
}

export class PathInventory {
  private readonly entries = new Map<string, PathKind>();
  private readonly parents = new Set<string>();

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
    if (error instanceof WorkflowImportAbort) throw error;
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
  let validationFailure: WorkflowImportAbort | undefined;
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
          if (error instanceof WorkflowImportAbort) validationFailure = error;
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
    if (error instanceof WorkflowImportAbort) throw error;
    abortImport("IMPORT_ARCHIVE_INVALID", `TAR archive could not be safely unpacked: ${causeMessage(error)}`);
  }
}

function tarEntryKind(entry: ReadEntry): PathKind {
  if (entry.type === "Directory") return "directory";
  if (entry.type === "File" || entry.type === "OldFile") return "file";
  abortImport("IMPORT_ARCHIVE_INVALID", `TAR entry '${entry.path}' has unsupported type ${entry.type}.`);
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
