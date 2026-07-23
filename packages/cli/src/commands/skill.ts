import type { Readable, Writable } from "node:stream";
import { homedir } from "node:os";
import { posix } from "node:path";
import { isCancel, multiselect, select } from "@clack/prompts";
import { Command } from "commander";
import { skillError, usageError } from "../errors.js";
import { writeResult, type SkillCommandResult } from "../output.js";
import { getCliPackageInfo } from "../package-info.js";
import {
  bundledAcpusSkillPath,
  readAcpusSkillResource,
  type SkillResourceRead,
  type SkillResourceTreeNode,
} from "../skill-content.js";
import {
  installAcpusSkill,
  skillAgents,
  skillTargets,
  uninstallAcpusSkill,
  type SkillAgent,
  type SkillInstallation,
  type SkillRemoval,
  type SkillScope,
  type SkillSelection,
  type SkillTarget,
} from "../skill-installation.js";
import { canPrompt } from "./prompt-io.js";

const ACPUS_PACKAGE = "acpus";
const ACPUS_SKILL = "acpus";

export type SkillCommandContext = {
  cwd: string;
  stdin: Readable;
  stdout: Writable;
  stderr: Writable;
  setExitCode(code: number): void;
};

type SkillOptions = {
  project?: boolean;
  global?: boolean;
  agent?: string;
  dryRun?: boolean;
};

export function createSkillCommand(ctx: SkillCommandContext): Command {
  const command = new Command("skill")
    .exitOverride()
    .description("Read, install, or uninstall the bundled Acpus agent skill.");

  command.addCommand(new Command("read")
    .exitOverride()
    .description("Read a bundled Acpus skill file or list a directory.")
    .argument("[path]", "canonical skill-root-relative file or directory path")
    .action(async (resourcePath?: string) => {
      const rootPath = await resolveBundledSkillRoot();
      const resource = await readAcpusSkillResource(rootPath, resourcePath);
      if (resource.isErr()) throw skillError(resource.error.message);
      ctx.stdout.write(formatSkillResource(resource.value));
      if (resource.value.kind === "file") {
        ctx.stdout.write(resource.value.content);
      } else if (resource.value.entries.length > 0) {
        ctx.stdout.write(`${resource.value.entries.map(entry => `${entry.kind}\t${entry.path}`).join("\n")}\n`);
      }
      ctx.setExitCode(0);
    }));

  command.addCommand(skillLeaf("install")
    .description("Install or update the bundled Acpus skill.")
    .action(async (options: SkillOptions) => {
      const selection = await resolveSelection(options, "install", ctx);
      const source = await resolveBundledSkillRoot();
      const targets = skillTargets(ctx.cwd, homedir(), selection);
      const installations = await installAcpusSkill(source, targets, options.dryRun === true);
      const ok = installations.every(result => result.status !== "failed");
      ctx.setExitCode(writeResult({
        ok,
        phase: "skill",
        message: ok ? "Acpus skill installed." : "Acpus skill installation completed with failures.",
        skill: skillResult("install", selection, options.dryRun === true, targets, { installations }),
      }, "text", ctx, ok ? 0 : 1));
    }));

  command.addCommand(skillLeaf("uninstall")
    .description("Remove installed copies of the bundled Acpus skill.")
    .action(async (options: SkillOptions) => {
      const selection = await resolveSelection(options, "uninstall", ctx);
      const targets = skillTargets(ctx.cwd, homedir(), selection);
      const removals = await uninstallAcpusSkill(targets, options.dryRun === true);
      const ok = removals.every(result => result.status !== "failed" && result.status !== "skipped");
      ctx.setExitCode(writeResult({
        ok,
        phase: "skill",
        message: ok ? "Acpus skill uninstalled." : "Acpus skill uninstall completed with failures.",
        skill: skillResult("uninstall", selection, options.dryRun === true, targets, { removals }),
      }, "text", ctx, ok ? 0 : 1));
    }));

  return command;
}

async function resolveBundledSkillRoot(): Promise<string> {
  const source = await bundledAcpusSkillPath(getCliPackageInfo().version);
  if (source.isErr()) throw skillError(source.error.message);
  return source.value;
}

function formatSkillResource(resource: SkillResourceRead): string {
  const lines = [
    "[acpus skill resource]",
    `path: ${resource.absolutePath}`,
    `kind: ${resource.kind}`,
    ...(resource.kind !== "file" || resource.tree === undefined
      ? []
      : ["tree (relative to skill root):", ...formatSkillResourceTree(resource.tree)]),
    "[/acpus skill resource]",
  ];
  return `${lines.join("\n")}\n\n`;
}

function formatSkillResourceTree(tree: readonly SkillResourceTreeNode[]): string[] {
  const lines: string[] = [];
  for (const [index, node] of tree.entries()) {
    const last = index === tree.length - 1;
    lines.push(`${last ? "└──" : "├──"} ${posix.basename(node.path)}`);
    for (const [childIndex, child] of node.children.entries()) {
      const childLast = childIndex === node.children.length - 1;
      lines.push(`${last ? "    " : "│   "}${childLast ? "└──" : "├──"} ${posix.basename(child.path)}`);
    }
  }
  return lines;
}

function skillLeaf(name: "install" | "uninstall"): Command {
  return new Command(name)
    .exitOverride()
    .option("--project", `${name} in project skills directories`)
    .option("--global", `${name} in global skills directories`)
    .option("--agent <agents>", "target universal and/or claude agents (comma-separated)")
    .option("--dry-run", `show what would be ${name === "install" ? "installed" : "removed"} without changing files`);
}

async function resolveSelection(
  options: Pick<SkillOptions, "project" | "global" | "agent">,
  action: "install" | "uninstall",
  ctx: SkillCommandContext,
): Promise<SkillSelection> {
  let scope = explicitScope(options);
  let agents = options.agent === undefined ? undefined : parseAgents(options.agent);
  if (scope !== undefined && agents !== undefined) return { scope, agents };
  if (!canPrompt(ctx)) {
    throw usageError(`Non-interactive skill ${action} requires one of --project or --global and --agent <universal[,claude]>.`);
  }

  if (scope === undefined) {
    const picked = await select<SkillScope>({
      message: `Select where to ${action} the Acpus skill:`,
      options: [
        { value: "project", label: "Project", hint: ".agents and .claude in the current project" },
        { value: "global", label: "Global", hint: ".agents and .claude in your home directory" },
      ],
      initialValue: "project",
      input: ctx.stdin,
      output: ctx.stderr,
    });
    if (isCancel(picked)) throw usageError("Skill selection cancelled.");
    scope = picked;
  }

  if (agents === undefined) {
    const picked = await multiselect<SkillAgent>({
      message: `Select agents to ${action}:`,
      options: [
        { value: "universal", label: "Universal", hint: ".agents" },
        { value: "claude", label: "Claude", hint: ".claude" },
      ],
      initialValues: [...skillAgents],
      required: true,
      input: ctx.stdin,
      output: ctx.stderr,
    });
    if (isCancel(picked)) throw usageError("Skill selection cancelled.");
    agents = canonicalAgents(picked);
  }
  return { scope, agents };
}

function explicitScope(options: Pick<SkillOptions, "project" | "global">): SkillScope | undefined {
  if (options.project === true && options.global === true) throw usageError("Pass only one of --project or --global.");
  if (options.project === true) return "project";
  if (options.global === true) return "global";
  return undefined;
}

function parseAgents(value: string): SkillAgent[] {
  const agents = value.split(",").map(agent => agent.trim());
  if (agents.some(agent => agent.length === 0)) {
    throw usageError("--agent must contain only universal and/or claude without empty values.");
  }
  if (agents.some(agent => !skillAgents.includes(agent as SkillAgent))) {
    throw usageError("--agent must contain only universal and/or claude.");
  }
  return canonicalAgents(agents as SkillAgent[]);
}

function canonicalAgents(agents: readonly SkillAgent[]): SkillAgent[] {
  const selected = new Set(agents);
  return skillAgents.filter(agent => selected.has(agent));
}

function skillResult(
  action: "install" | "uninstall",
  selection: SkillSelection,
  dryRun: boolean,
  targets: SkillTarget[],
  details: { installations: SkillInstallation[] } | { removals: SkillRemoval[] },
): SkillCommandResult {
  return {
    action,
    packageName: ACPUS_PACKAGE,
    skillName: ACPUS_SKILL,
    targetName: ACPUS_SKILL,
    version: getCliPackageInfo().version,
    scope: selection.scope,
    dryRun,
    targets,
    ...details,
  };
}
