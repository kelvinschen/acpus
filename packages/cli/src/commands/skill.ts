import type { Writable } from "node:stream";
import { constants } from "node:fs";
import { access, cp, lstat, mkdtemp, readlink, rename, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { err, ok, ResultAsync, type Result } from "neverthrow";
import { skillError, usageError } from "../errors.js";
import { writeResult, type SkillCommandResult } from "../output.js";
import { existingSkillRootTargets, readAcpusSkillMetadata, skillTargets, type SkillScope, type SkillTarget } from "../skill-installation.js";
import { getCliPackageInfo } from "./version.js";

const ACPUS_PACKAGE = "acpus";
const ACPUS_SKILL = "acpus";
const ACPUS_TARGET = "acpus";

export type SkillCommandContext = {
  cwd: string;
  stdout: Writable;
  stderr: Writable;
  wantsJson: boolean;
  setExitCode(code: number): void;
};

type SkillOptions = {
  project?: boolean;
  global?: boolean;
  dryRun?: boolean;
};

type InstallationResult = NonNullable<SkillCommandResult["installations"]>[number];
type RemovalResult = NonNullable<SkillCommandResult["removals"]>[number];

export type SkillReplaceFailure = {
  type: "skill-replace-failed";
  stage: "stage" | "backup" | "publish" | "restore" | "cleanup";
  message: string;
  recoveryPath: string;
  published: boolean;
};

export function createSkillCommand(ctx: SkillCommandContext): Command {
  const command = new Command("skill")
    .exitOverride()
    .configureOutput({
      writeOut: text => ctx.stdout.write(text),
      writeErr: text => {
        if (!ctx.wantsJson) ctx.stderr.write(text);
      },
      outputError: (text, write) => write(text),
    })
    .description("Install or uninstall the bundled Acpus agent skill.");

  command.addCommand(new Command("install")
    .exitOverride()
    .option("--project", "install into project skills directories")
    .option("--global", "install into global skills directories")
    .option("--dry-run", "show what would be installed without changing files")
    .action(async (options: SkillOptions) => {
      const scope = parseScope(options);
      const sourcePath = await bundledSkillPath();
      const targets = await resolveExistingTargets(ctx.cwd, scope, "install");
      const installations = await installAcpusSkill(sourcePath, targets, options.dryRun === true);
      const ok = installOk(installations);
      ctx.setExitCode(writeResult({
        ok,
        phase: "skill",
        message: ok ? "Acpus skill installed." : "Acpus skill installation skipped unsafe entries.",
        skill: skillResult("install", scope, options.dryRun === true, targets, { installations }),
      }, ctx.wantsJson ? "json" : "text", ctx, ok ? 0 : 1));
    }));

  command.addCommand(new Command("uninstall")
    .exitOverride()
    .option("--project", "uninstall from project skills directories")
    .option("--global", "uninstall from global skills directories")
    .option("--dry-run", "show what would be removed without changing files")
    .action(async (options: SkillOptions) => {
      const scope = parseScope(options);
      const targets = await resolveExistingTargets(ctx.cwd, scope, "uninstall");
      const removals = await uninstallAcpusSkill(targets, options.dryRun === true);
      const ok = uninstallOk(removals);
      ctx.setExitCode(writeResult({
        ok,
        phase: "skill",
        message: ok ? "Acpus skill uninstalled." : "Acpus skill uninstall skipped unsafe entries.",
        skill: skillResult("uninstall", scope, options.dryRun === true, targets, { removals }),
      }, ctx.wantsJson ? "json" : "text", ctx, ok ? 0 : 1));
    }));

  return command;
}

function parseScope(options: Pick<SkillOptions, "project" | "global">): SkillScope {
  if (options.project === true && options.global === true) throw usageError("Pass only one of --project or --global.");
  return options.global === true ? "global" : "project";
}

async function bundledSkillPath(): Promise<string> {
  const sourcePath = fileURLToPath(new URL("../../skills/acpus", import.meta.url));
  try {
    await access(join(sourcePath, "SKILL.md"), constants.R_OK);
    const metadata = await readAcpusSkillMetadata(sourcePath);
    if (metadata.name !== ACPUS_SKILL || metadata.version !== getCliPackageInfo().version) {
      throw new Error("bundled skill identity mismatch");
    }
    return sourcePath;
  } catch {
    throw skillError("Bundled Acpus skill is missing or does not match this acpus package version.");
  }
}

async function resolveExistingTargets(cwd: string, scope: SkillScope, action: "install" | "uninstall"): Promise<SkillTarget[]> {
  const candidates = skillTargets(cwd, scope);
  const targets = await existingSkillRootTargets(cwd, [scope]);
  if (targets.length === 0) {
    const missing = candidates.map(candidate => ({
      scope,
      kind: candidate.kind,
      targetPath: candidate.targetPath,
      status: "skipped" as const,
      error: "skills root does not exist",
    }));
    throw skillError(`No ${scope} skills directories found: ${candidates.map(candidate => candidate.rootPath).join(", ")}`, {
      skill: skillResult(action, scope, false, candidates, action === "install" ? { installations: missing } : { removals: missing }),
    });
  }
  return targets;
}

async function installAcpusSkill(sourcePath: string, targets: SkillTarget[], dryRun: boolean): Promise<InstallationResult[]> {
  const results: InstallationResult[] = [];
  for (const target of targets) {
    const existing = await classifyExistingTarget(target.targetPath);
    if (existing === "unsafe") {
      results.push({ scope: target.scope, kind: target.kind, targetPath: target.targetPath, status: "failed", error: "target exists and is not the Acpus skill" });
      continue;
    }

    const status = existing === "missing" ? dryRun ? "would-install" : "installed" : dryRun ? "would-update" : "updated";
    if (!dryRun) {
      const replaced = await replaceDirectory(sourcePath, target.targetPath, existing !== "missing");
      if (replaced.isErr()) {
        results.push({ scope: target.scope, kind: target.kind, targetPath: target.targetPath, status: "failed", error: replaced.error.message });
        continue;
      }
    }
    results.push({ scope: target.scope, kind: target.kind, targetPath: target.targetPath, status });
  }
  return results;
}

async function uninstallAcpusSkill(targets: SkillTarget[], dryRun: boolean): Promise<RemovalResult[]> {
  const results: RemovalResult[] = [];
  for (const target of targets) {
    const existing = await classifyExistingTarget(target.targetPath);
    if (existing === "missing") {
      results.push({ scope: target.scope, kind: target.kind, targetPath: target.targetPath, status: "missing" });
      continue;
    }
    if (existing === "unsafe") {
      results.push({ scope: target.scope, kind: target.kind, targetPath: target.targetPath, status: "skipped", error: "target is not the Acpus skill" });
      continue;
    }
    if (!dryRun) await rm(target.targetPath, { recursive: true, force: true });
    results.push({ scope: target.scope, kind: target.kind, targetPath: target.targetPath, status: dryRun ? "would-remove" : "removed" });
  }
  return results;
}

async function classifyExistingTarget(targetPath: string): Promise<"missing" | "acpus" | "unsafe"> {
  try {
    const stats = await lstat(targetPath);
    if (stats.isSymbolicLink()) return await isAcpusSkillSymlink(targetPath) ? "acpus" : "unsafe";
    if (stats.isDirectory()) return await isAcpusSkillDirectory(targetPath) ? "acpus" : "unsafe";
    return "unsafe";
  } catch (error) {
    if (isNotFound(error)) return "missing";
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
    if (isNotFound(error)) return false;
    throw error;
  }
}

export function replaceDirectory(sourcePath: string, targetPath: string, targetExists: boolean): ResultAsync<void, SkillReplaceFailure> {
  return new ResultAsync(replaceDirectoryTransaction(sourcePath, targetPath, targetExists));
}

async function replaceDirectoryTransaction(sourcePath: string, targetPath: string, targetExists: boolean): Promise<Result<void, SkillReplaceFailure>> {
  const parent = dirname(targetPath);
  let recoveryPath: string;
  try {
    recoveryPath = await mkdtemp(join(parent, ".acpus-skill-"));
  } catch (cause) {
    return err(skillReplaceFailure("stage", parent, false, cause));
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
        return err(skillReplaceFailure(
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
    return err(skillReplaceFailure("cleanup", recoveryPath, true, cause));
  }
  return ok(undefined);
}

async function cleanupAfterFailure(
  stage: SkillReplaceFailure["stage"],
  recoveryPath: string,
  published: boolean,
  cause: unknown,
): Promise<Result<void, SkillReplaceFailure>> {
  try {
    await rm(recoveryPath, { recursive: true, force: true });
    return err(skillReplaceFailure(stage, recoveryPath, published, cause));
  } catch (cleanupCause) {
    return err(skillReplaceFailure(
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
  const detail = cause instanceof Error && cause.message.length > 0 ? cause.message : String(cause);
  return {
    type: "skill-replace-failed",
    stage,
    recoveryPath,
    published,
    message: `Acpus skill replacement failed during ${stage}: ${detail} Recovery path: ${recoveryPath}.`,
  };
}

function installOk(results: InstallationResult[]): boolean {
  return results.some(result => result.status === "installed" || result.status === "updated" || result.status === "would-install" || result.status === "would-update")
    && results.every(result => result.status !== "failed" && result.status !== "skipped");
}

function uninstallOk(results: RemovalResult[]): boolean {
  return results.every(result => result.status !== "failed" && result.status !== "skipped");
}

function skillResult(
  action: "install" | "uninstall",
  scope: SkillScope,
  dryRun: boolean,
  targets: SkillTarget[],
  details: Pick<SkillCommandResult, "installations" | "removals">,
): SkillCommandResult {
  return {
    action,
    packageName: ACPUS_PACKAGE,
    skillName: ACPUS_SKILL,
    targetName: ACPUS_TARGET,
    version: getCliPackageInfo().version,
    scope,
    dryRun,
    targets: targets.map(target => ({ scope: target.scope, kind: target.kind, rootPath: target.rootPath, targetPath: target.targetPath })),
    ...details,
  };
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && (error.code === "ENOENT" || error.code === "ENOTDIR");
}
