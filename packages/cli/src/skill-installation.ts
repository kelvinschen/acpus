import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export type SkillScope = "project" | "global";
export type SkillTargetKind = "agents" | "claude";

export type SkillTarget = {
  scope: SkillScope;
  kind: SkillTargetKind;
  rootPath: string;
  targetPath: string;
};

export type AcpusSkillMetadata = {
  name?: string;
  version?: string;
};

export function skillTargets(cwd: string, scope: SkillScope): SkillTarget[] {
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

export async function existingSkillRootTargets(cwd: string, scopes: readonly SkillScope[]): Promise<SkillTarget[]> {
  const candidates = scopes.flatMap(scope => skillTargets(cwd, scope));
  const existing = await Promise.all(candidates.map(async candidate => await isDirectory(candidate.rootPath) ? candidate : undefined));
  return existing.filter((candidate): candidate is SkillTarget => candidate !== undefined);
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

function target(scope: SkillScope, kind: SkillTargetKind, rootPath: string): SkillTarget {
  const absoluteRoot = resolve(rootPath);
  return { scope, kind, rootPath: absoluteRoot, targetPath: join(absoluteRoot, "acpus") };
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}
