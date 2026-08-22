import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, posix, relative, sep, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { TextDecoder } from "node:util";
import * as Effect from "effect/Effect";

const ACPUS_SKILL = "acpus";
const SKILL_ENTRY = "SKILL.md";

export type AcpusSkillMetadata = {
  name?: string;
  version?: string;
};

export type BundledSkillFailure = {
  type: "bundled-skill-invalid";
  message: string;
};

export type SkillResourceFailure = {
  type: "skill-resource-failed";
  reason:
    | "invalid-path"
    | "not-found"
    | "not-directory"
    | "not-file"
    | "symlink"
    | "special-file"
    | "outside-root"
    | "invalid-utf8"
    | "unreadable";
  message: string;
};

type SkillResourceEntry = {
  kind: "file" | "directory";
  path: string;
};

export type SkillResourceTreeNode = SkillResourceEntry & {
  kind: "directory";
  children: SkillResourceEntry[];
};

export type SkillResourceRead =
  | {
      kind: "file";
      absolutePath: string;
      content: Buffer;
      tree?: SkillResourceTreeNode[];
    }
  | {
      kind: "directory";
      absolutePath: string;
      entries: SkillResourceEntry[];
    };

function bundledAcpusSkillLocation(): string {
  return fileURLToPath(new URL("../../skills/acpus", import.meta.url));
}

export function bundledAcpusSkillPath(expectedVersion: string): Effect.Effect<string, BundledSkillFailure> {
  return Effect.tryPromise({
    try: async () => {
      const rootPath = await canonicalSkillRoot(bundledAcpusSkillLocation());
      const entry = await resolveSkillResource(rootPath, SKILL_ENTRY);
      requireFile(entry, SKILL_ENTRY);
      const content = await readUtf8File(entry.absolutePath, SKILL_ENTRY);
      const metadata = parseAcpusSkillMetadata(content.toString("utf8"));
      if (metadata.name !== ACPUS_SKILL || metadata.version !== expectedVersion) {
        throw new Error("bundled skill identity mismatch");
      }
      return rootPath;
    },
    catch: () => ({
      type: "bundled-skill-invalid" as const,
      message: "Bundled Acpus skill is missing or does not match this acpus package version.",
    }),
  });
}

export function readAcpusSkillResource(
  rootPath: string,
  resourcePath?: string,
): Effect.Effect<SkillResourceRead, SkillResourceFailure> {
  return Effect.tryPromise({
    try: async () => {
      const canonicalRoot = await canonicalSkillRoot(rootPath);
      const path = resourcePath ?? SKILL_ENTRY;
      validateSkillResourcePath(path);
      const resource = await resolveSkillResource(canonicalRoot, path);
      if (resource.kind === "directory" && resourcePath !== undefined) {
        return {
          kind: "directory" as const,
          absolutePath: resource.absolutePath,
          entries: await readDirectoryEntries(canonicalRoot, path),
        };
      }
      requireFile(resource, path);
      const content = await readUtf8File(resource.absolutePath, path);
      return {
        kind: "file" as const,
        absolutePath: resource.absolutePath,
        content,
        ...(resourcePath === undefined ? { tree: await readSkillResourceTree(canonicalRoot) } : {}),
      };
    },
    catch: skillResourceFailure,
  });
}

export async function readAcpusSkillMetadata(path: string): Promise<AcpusSkillMetadata> {
  return parseAcpusSkillMetadata(await readFile(join(path, SKILL_ENTRY), "utf8"));
}

export function parseAcpusSkillMetadata(source: string): AcpusSkillMetadata {
  const frontmatter = source.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
  if (frontmatter === undefined) return {};
  const lines = frontmatter.split(/\r?\n/);
  const name = lines.find(line => /^name:\s*/.test(line))?.replace(/^name:\s*/, "").trim();
  const metadataIndex = lines.findIndex(line => /^metadata:\s*$/.test(line));
  let version: string | undefined;
  if (metadataIndex >= 0) {
    for (const line of lines.slice(metadataIndex + 1)) {
      if (/^\S/.test(line)) break;
      const match = line.match(/^\s+acpus-version:\s*([^\s#]+)\s*(?:#.*)?$/);
      if (match) {
        version = match[1];
        break;
      }
    }
  }
  return {
    ...(name ? { name } : {}),
    ...(version ? { version } : {}),
  };
}

type ResolvedSkillResource = {
  absolutePath: string;
  kind: "file" | "directory" | "special";
};

class SkillResourceError extends Error {
  constructor(readonly failure: SkillResourceFailure) {
    super(failure.message);
  }
}

async function canonicalSkillRoot(rootPath: string): Promise<string> {
  let canonical: string;
  try {
    canonical = await realpath(rootPath);
  } catch (cause) {
    fail(isMissingPathError(cause) ? "not-found" : "unreadable", `Bundled skill root could not be read: ${causeMessage(cause)}`);
  }
  const stats = await safeLstat(canonical, "");
  if (!stats.isDirectory()) fail("not-directory", "Bundled skill root is not a directory.");
  return canonical;
}

async function resolveSkillResource(rootPath: string, resourcePath: string): Promise<ResolvedSkillResource> {
  let absolutePath = rootPath;
  const segments = resourcePath.split("/");
  for (const [index, segment] of segments.entries()) {
    absolutePath = join(absolutePath, segment);
    const stats = await safeLstat(absolutePath, resourcePath);
    if (stats.isSymbolicLink()) fail("symlink", `Skill resource '${resourcePath}' cannot be a symbolic link.`);
    if (index < segments.length - 1 && !stats.isDirectory()) {
      fail("not-directory", `Skill resource '${segments.slice(0, index + 1).join("/")}' is not a directory.`);
    }
  }

  let canonical: string;
  try {
    canonical = await realpath(absolutePath);
  } catch (cause) {
    fail(isMissingPathError(cause) ? "not-found" : "unreadable", `Skill resource '${resourcePath}' could not be resolved: ${causeMessage(cause)}`);
  }
  requireContained(rootPath, canonical, resourcePath);
  const stats = await safeLstat(canonical, resourcePath);
  return {
    absolutePath: canonical,
    kind: stats.isFile() ? "file" : stats.isDirectory() ? "directory" : "special",
  };
}

async function readDirectoryEntries(
  rootPath: string,
  resourcePath?: string,
): Promise<SkillResourceEntry[]> {
  const directory = resourcePath === undefined
    ? { absolutePath: rootPath, kind: "directory" as const }
    : await resolveSkillResource(rootPath, resourcePath);
  if (directory.kind !== "directory") {
    fail("not-directory", `Skill resource '${resourcePath}' is not a directory.`);
  }

  let names: string[];
  try {
    names = await readdir(directory.absolutePath);
  } catch (cause) {
    fail("unreadable", `Skill resource directory '${resourcePath ?? "."}' could not be read: ${causeMessage(cause)}`);
  }
  names.sort(comparePaths);

  const entries: SkillResourceEntry[] = [];
  for (const name of names) {
    const path = resourcePath === undefined ? name : posix.join(resourcePath, name);
    try {
      validateSkillResourcePath(path);
    } catch {
      fail("invalid-path", `Bundled skill contains non-canonical resource path ${JSON.stringify(path)}.`);
    }
    const resource = await resolveSkillResource(rootPath, path);
    if (resource.kind === "special") {
      fail("special-file", `Skill resource '${path}' is not a regular file or directory.`);
    }
    entries.push({ kind: resource.kind, path });
  }
  return entries;
}

async function readSkillResourceTree(rootPath: string): Promise<SkillResourceTreeNode[]> {
  const directories = (await readDirectoryEntries(rootPath))
    .filter((entry): entry is SkillResourceEntry & { kind: "directory" } => entry.kind === "directory");
  const tree: SkillResourceTreeNode[] = [];
  for (const directory of directories) {
    tree.push({ ...directory, children: await readDirectoryEntries(rootPath, directory.path) });
  }
  return tree;
}

async function readUtf8File(absolutePath: string, resourcePath: string): Promise<Buffer> {
  let content: Buffer;
  try {
    content = await readFile(absolutePath);
  } catch (cause) {
    fail("unreadable", `Skill resource '${resourcePath}' could not be read: ${causeMessage(cause)}`);
  }
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(content);
  } catch {
    fail("invalid-utf8", `Skill resource '${resourcePath}' is not valid UTF-8.`);
  }
  return content;
}

function validateSkillResourcePath(path: string): void {
  const segments = path.split("/");
  if (
    path.length === 0
    || path.includes("\\")
    || path.includes("\0")
    || isAbsolute(path)
    || win32.isAbsolute(path)
    || segments.some(segment => segment.length === 0 || segment === "." || segment === "..")
  ) {
    fail("invalid-path", `Invalid skill resource path ${JSON.stringify(path)}; use a canonical skill-root-relative path.`);
  }
}

function requireFile(resource: ResolvedSkillResource, resourcePath: string): void {
  if (resource.kind === "directory") fail("not-file", `Skill resource '${resourcePath}' is a directory, not a file.`);
  if (resource.kind === "special") fail("special-file", `Skill resource '${resourcePath}' is not a regular file.`);
}

function requireContained(rootPath: string, absolutePath: string, resourcePath: string): void {
  const local = relative(rootPath, absolutePath);
  if (local === ".." || local.startsWith(`..${sep}`) || isAbsolute(local)) {
    fail("outside-root", `Skill resource '${resourcePath}' resolves outside the bundled skill.`);
  }
}

async function safeLstat(path: string, resourcePath: string): Promise<Awaited<ReturnType<typeof lstat>>> {
  try {
    return await lstat(path);
  } catch (cause) {
    const display = resourcePath.length > 0 ? `Skill resource '${resourcePath}'` : "Bundled skill root";
    fail(isMissingPathError(cause) ? "not-found" : "unreadable", `${display} could not be read: ${causeMessage(cause)}`);
  }
}

function fail(reason: SkillResourceFailure["reason"], message: string): never {
  throw new SkillResourceError({ type: "skill-resource-failed", reason, message });
}

function skillResourceFailure(cause: unknown): SkillResourceFailure {
  return cause instanceof SkillResourceError
    ? cause.failure
    : {
        type: "skill-resource-failed",
        reason: "unreadable",
        message: `Bundled skill resource access failed: ${causeMessage(cause)}`,
      };
}

function comparePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isMissingPathError(error: unknown): boolean {
  const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
  return code === "ENOENT" || code === "ENOTDIR";
}

function causeMessage(cause: unknown): string {
  return cause instanceof Error && cause.message.length > 0 ? cause.message : String(cause);
}
