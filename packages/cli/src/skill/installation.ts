import { cp, lstat, mkdir, mkdtemp, readlink, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { readAcpusSkillMetadata } from "./content.js";

const ACPUS_SKILL = "acpus";

export const skillAgents = ["universal", "claude"] as const;

export type SkillScope = "project" | "global";
export type SkillAgent = typeof skillAgents[number];

export type SkillSelection = {
  scope: SkillScope;
  agents: SkillAgent[];
};

export type ScopedSkillTarget = {
  scope: SkillScope;
  agent: SkillAgent;
  rootPath: string;
  targetPath: string;
};

export type CustomSkillTarget = {
  scope: "custom";
  agent: "custom";
  rootPath: string;
  targetPath: string;
};

export type SkillTarget = ScopedSkillTarget | CustomSkillTarget;

export type SkillInstallation = {
  scope: SkillTarget["scope"];
  agent: SkillTarget["agent"];
  targetPath: string;
  status: "installed" | "updated" | "would-install" | "would-update" | "failed";
  error?: string;
};

export type SkillRemoval = {
  scope: SkillTarget["scope"];
  agent: SkillTarget["agent"];
  targetPath: string;
  status: "removed" | "would-remove" | "missing" | "skipped" | "failed";
  error?: string;
};

export type SkillReplaceFailure = {
  type: "skill-replace-failed";
  stage: "stage" | "backup" | "publish" | "restore" | "cleanup";
  message: string;
  recoveryPath: string;
  published: boolean;
};

export function skillTargets(cwd: string, home: string, selection: SkillSelection): ScopedSkillTarget[] {
  const basePath = selection.scope === "project" ? cwd : home;
  const selected = new Set(selection.agents);
  return skillAgents
    .filter(agent => selected.has(agent))
    .map(agent => target(selection.scope, agent, join(basePath, agent === "universal" ? ".agents" : ".claude", "skills")));
}

export function customSkillTarget(cwd: string, directory: string): CustomSkillTarget {
  const rootPath = resolve(cwd, directory);
  return { scope: "custom", agent: "custom", rootPath, targetPath: join(rootPath, ACPUS_SKILL) };
}

export async function existingSkillRootTargets(
  cwd: string,
  home: string,
  scopes: readonly SkillScope[],
): Promise<ScopedSkillTarget[]> {
  const candidates = scopes.flatMap(scope => skillTargets(cwd, home, { scope, agents: [...skillAgents] }));
  const existing: ScopedSkillTarget[] = [];
  for (const candidate of candidates) {
    if (await isDirectory(candidate.rootPath)) existing.push(candidate);
  }
  return existing;
}

export async function installAcpusSkill(
  sourcePath: string,
  targets: readonly SkillTarget[],
  dryRun: boolean,
): Promise<SkillInstallation[]> {
  const results: SkillInstallation[] = [];
  for (const target of targets) {
    try {
      const rootState = await classifyRoot(target.rootPath);
      if (rootState === "invalid") {
        results.push(failedInstallation(target, "skills root is not a directory"));
        continue;
      }
      if (rootState === "missing" && !dryRun) await mkdir(target.rootPath, { recursive: true });

      const existing = rootState === "missing" ? "missing" : await classifyExistingTarget(target.targetPath);
      if (existing === "unsafe") {
        results.push(failedInstallation(target, "target exists and is not the Acpus skill"));
        continue;
      }

      const status = existing === "missing"
        ? dryRun ? "would-install" : "installed"
        : dryRun ? "would-update" : "updated";
      if (!dryRun) {
        const replaced = await Effect.runPromise(Effect.result(
          replaceDirectory(sourcePath, target.targetPath, existing !== "missing"),
        ));
        if (Result.isFailure(replaced)) {
          results.push(failedInstallation(target, replaced.failure.message));
          continue;
        }
      }
      results.push({ scope: target.scope, agent: target.agent, targetPath: target.targetPath, status });
    } catch (error) {
      results.push(failedInstallation(target, causeMessage(error)));
    }
  }
  return results;
}

export async function uninstallAcpusSkill(
  targets: readonly SkillTarget[],
  dryRun: boolean,
): Promise<SkillRemoval[]> {
  const results: SkillRemoval[] = [];
  for (const target of targets) {
    try {
      const existing = await classifyExistingTarget(target.targetPath);
      if (existing === "missing") {
        results.push({ scope: target.scope, agent: target.agent, targetPath: target.targetPath, status: "missing" });
        continue;
      }
      if (existing === "unsafe") {
        results.push({
          scope: target.scope,
          agent: target.agent,
          targetPath: target.targetPath,
          status: "skipped",
          error: "target is not the Acpus skill",
        });
        continue;
      }
      if (!dryRun) await rm(target.targetPath, { recursive: true, force: true });
      results.push({
        scope: target.scope,
        agent: target.agent,
        targetPath: target.targetPath,
        status: dryRun ? "would-remove" : "removed",
      });
    } catch (error) {
      results.push({
        scope: target.scope,
        agent: target.agent,
        targetPath: target.targetPath,
        status: "failed",
        error: causeMessage(error),
      });
    }
  }
  return results;
}

export function replaceDirectory(sourcePath: string, targetPath: string, targetExists: boolean): Effect.Effect<void, SkillReplaceFailure> {
  return Effect.promise(() => replaceDirectoryTransaction(sourcePath, targetPath, targetExists)).pipe(
    Effect.flatMap(Effect.fromResult),
  );
}

async function replaceDirectoryTransaction(
  sourcePath: string,
  targetPath: string,
  targetExists: boolean,
): Promise<Result.Result<void, SkillReplaceFailure>> {
  const parent = dirname(targetPath);
  let recoveryPath: string;
  try {
    recoveryPath = await mkdtemp(join(parent, ".acpus-skill-"));
  } catch (cause) {
    return Result.fail(skillReplaceFailure("stage", parent, false, cause));
  }
  const stagedPath = join(recoveryPath, basename(targetPath));
  const backupPath = join(recoveryPath, ".previous");

  try {
    await cp(sourcePath, stagedPath, { recursive: true, verbatimSymlinks: true });
  } catch (cause) {
    return cleanupAfterFailure("stage", recoveryPath, false, cause);
  }

  if (targetExists) {
    try {
      await rename(targetPath, backupPath);
    } catch (cause) {
      return cleanupAfterFailure("backup", recoveryPath, false, cause);
    }
  }

  try {
    await rename(stagedPath, targetPath);
  } catch (publishCause) {
    if (targetExists) {
      try {
        await rename(backupPath, targetPath);
      } catch (restoreCause) {
        return Result.fail(skillReplaceFailure(
          "restore",
          recoveryPath,
          false,
          new AggregateError([publishCause, restoreCause], "Skill publication and restoration both failed."),
        ));
      }
    }
    return cleanupAfterFailure("publish", recoveryPath, false, publishCause);
  }

  try {
    await rm(recoveryPath, { recursive: true, force: true });
  } catch (cause) {
    return Result.fail(skillReplaceFailure("cleanup", recoveryPath, true, cause));
  }
  return Result.succeed(undefined);
}

async function classifyRoot(rootPath: string): Promise<"directory" | "missing" | "invalid"> {
  try {
    return (await stat(rootPath)).isDirectory() ? "directory" : "invalid";
  } catch (error) {
    if (errorCode(error) === "ENOTDIR") return "invalid";
    if (errorCode(error) !== "ENOENT") throw error;
  }
  try {
    await lstat(rootPath);
    return "invalid";
  } catch (error) {
    if (errorCode(error) === "ENOENT") return "missing";
    if (errorCode(error) === "ENOTDIR") return "invalid";
    throw error;
  }
}

async function classifyExistingTarget(targetPath: string): Promise<"missing" | "acpus" | "unsafe"> {
  try {
    const stats = await lstat(targetPath);
    if (stats.isSymbolicLink()) return await isAcpusSkillSymlink(targetPath) ? "acpus" : "unsafe";
    if (stats.isDirectory()) return await isAcpusSkillDirectory(targetPath) ? "acpus" : "unsafe";
    return "unsafe";
  } catch (error) {
    if (isMissingPathError(error)) return "missing";
    throw error;
  }
}

async function isAcpusSkillSymlink(targetPath: string): Promise<boolean> {
  return isAcpusSkillDirectory(resolve(dirname(targetPath), await readlink(targetPath)));
}

async function isAcpusSkillDirectory(targetPath: string): Promise<boolean> {
  try {
    return (await readAcpusSkillMetadata(targetPath)).name === ACPUS_SKILL;
  } catch (error) {
    if (isMissingPathError(error)) return false;
    throw error;
  }
}

async function cleanupAfterFailure(
  stage: SkillReplaceFailure["stage"],
  recoveryPath: string,
  published: boolean,
  cause: unknown,
): Promise<Result.Result<void, SkillReplaceFailure>> {
  try {
    await rm(recoveryPath, { recursive: true, force: true });
    return Result.fail(skillReplaceFailure(stage, recoveryPath, published, cause));
  } catch (cleanupCause) {
    return Result.fail(skillReplaceFailure(
      stage,
      recoveryPath,
      published,
      new AggregateError([cause, cleanupCause], `Skill replacement failed during ${stage} and cleanup.`),
    ));
  }
}

function skillReplaceFailure(
  stage: SkillReplaceFailure["stage"],
  recoveryPath: string,
  published: boolean,
  cause: unknown,
): SkillReplaceFailure {
  return {
    type: "skill-replace-failed",
    stage,
    recoveryPath,
    published,
    message: `Acpus skill replacement failed during ${stage}: ${causeMessage(cause)} Recovery path: ${recoveryPath}.`,
  };
}

function failedInstallation(target: SkillTarget, error: string): SkillInstallation {
  return { scope: target.scope, agent: target.agent, targetPath: target.targetPath, status: "failed", error };
}

function target(scope: SkillScope, agent: SkillAgent, rootPath: string): ScopedSkillTarget {
  const absoluteRoot = resolve(rootPath);
  return { scope, agent, rootPath: absoluteRoot, targetPath: join(absoluteRoot, ACPUS_SKILL) };
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
  return errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR";
}

function errorCode(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
}

function causeMessage(cause: unknown): string {
  return cause instanceof Error && cause.message.length > 0 ? cause.message : String(cause);
}
