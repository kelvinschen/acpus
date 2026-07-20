import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export type SkillScope = "project" | "global";
export type SkillTargetKind = "agents" | "claude";

export type StandardSkillTarget = {
  scope: SkillScope;
  kind: SkillTargetKind;
  rootPath: string;
  targetPath: string;
};

export type CustomSkillTarget = {
  scope: "custom";
  kind: "custom";
  rootPath: string;
  targetPath: string;
};

export type SkillTarget = StandardSkillTarget | CustomSkillTarget;

export type AcpusSkillMetadata = {
  name?: string;
  version?: string;
};

export function skillTargets(cwd: string, scope: SkillScope): StandardSkillTarget[] {
  if (scope === "project") {
    return [
      target(scope, "agents", join(cwd, ".agents", "skills")),
      target(scope, "claude", join(cwd, ".claude", "skills")),
    ];
  }
  const codexHome = process.env.CODEX_HOME?.trim() || join(homedir(), ".codex");
  const claudeHome = process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), ".claude");
  return [
    target(scope, "agents", join(codexHome, "skills")),
    target(scope, "claude", join(claudeHome, "skills")),
  ];
}

export function customSkillTarget(cwd: string, rootPath: string): CustomSkillTarget {
  const absoluteRoot = resolve(cwd, rootPath);
  return { scope: "custom", kind: "custom", rootPath: absoluteRoot, targetPath: join(absoluteRoot, "acpus") };
}

export async function existingSkillTargets<T extends SkillTarget>(candidates: readonly T[]): Promise<T[]> {
  const existing: T[] = [];
  for (const candidate of candidates) {
    if (await isDirectory(candidate.rootPath)) existing.push(candidate);
  }
  return existing;
}

export async function existingSkillRootTargets(cwd: string, scopes: readonly SkillScope[]): Promise<StandardSkillTarget[]> {
  const candidates = scopes.flatMap(scope => skillTargets(cwd, scope));
  return existingSkillTargets(candidates);
}

export async function readAcpusSkillMetadata(path: string): Promise<AcpusSkillMetadata> {
  return parseAcpusSkillMetadata(await readFile(join(path, "SKILL.md"), "utf8"));
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

function target(scope: SkillScope, kind: SkillTargetKind, rootPath: string): StandardSkillTarget {
  const absoluteRoot = resolve(rootPath);
  return { scope, kind, rootPath: absoluteRoot, targetPath: join(absoluteRoot, "acpus") };
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch (error) {
    if (isMissingPathError(error)) return false;
    throw error;
  }
}

function isMissingPathError(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && (error.code === "ENOENT" || error.code === "ENOTDIR");
}
