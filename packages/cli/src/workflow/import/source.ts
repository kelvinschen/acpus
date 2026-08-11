import { createWriteStream } from "node:fs";
import { chmod, copyFile, lstat, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { abortImport, abortUsage, causeMessage } from "./failure.js";

type SourceKind = "directory" | "typescript" | "zip" | "tar";

export type ClassifiedWorkflowImportSource =
  | { type: "local"; kind: SourceKind; path: string }
  | { type: "remote"; kind: Exclude<SourceKind, "directory">; url: URL };

export type AcquiredWorkflowImportSource =
  | { kind: "typescript" }
  | { kind: "directory"; path: string }
  | { kind: "zip" | "tar"; path: string };

export async function classifyWorkflowImportSource(
  cwd: string,
  source: string,
): Promise<ClassifiedWorkflowImportSource> {
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
  if (/^[a-z][a-z0-9+.-]*:/i.test(source) && !/^[a-z]:[\\/]/i.test(source)) {
    abortUsage("Workflow import URLs must use HTTP or HTTPS.");
  }
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

export async function acquireWorkflowImportSource(
  source: ClassifiedWorkflowImportSource,
  stagingRoot: string,
  stagedPackage: string,
): Promise<AcquiredWorkflowImportSource> {
  if (source.kind === "directory") return { kind: source.kind, path: source.path };
  const path = source.kind === "typescript"
    ? join(stagedPackage, "workflow.ts")
    : join(stagingRoot, source.kind === "zip" ? "source.zip" : "source.tar.gz");
  if (source.kind === "typescript") await mkdir(stagedPackage, { recursive: true });
  if (source.type === "remote") await download(source.url, path);
  else {
    await copyFile(source.path, path);
    if (source.kind === "typescript") await chmod(path, (await lstat(source.path)).mode & 0o777);
  }
  return source.kind === "typescript" ? { kind: source.kind } : { kind: source.kind, path };
}

function suffixKind(path: string): Exclude<SourceKind, "directory"> {
  const lower = path.toLocaleLowerCase("en-US");
  if (lower.endsWith(".tar.gz") || lower.endsWith(".tgz")) return "tar";
  if (lower.endsWith(".zip")) return "zip";
  if (lower.endsWith(".ts")) return "typescript";
  abortUsage("Workflow import source must be a directory or end in .ts, .zip, .tar.gz, or .tgz.");
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
