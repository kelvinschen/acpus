import type { Writable } from "node:stream";
import { posix } from "node:path";
import { Command } from "commander";
import { loadAgentAuthoringContext } from "@acpus/runtime";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { skillError } from "../presentation/errors.js";
import { getCliPackageInfo } from "../platform/package-info.js";
import {
  bundledAcpusSkillPath,
  readAcpusSkillResource,
  type SkillResourceRead,
  type SkillResourceTreeNode,
} from "./content.js";
import { formatAgentAuthoringContext } from "../agent/presentation.js";

export type SkillCommandContext = {
  cwd: string;
  stdout: Writable;
  setExitCode(code: number): void;
};

export function createSkillCommand(ctx: SkillCommandContext): Command {
  const command = new Command("skill")
    .exitOverride()
    .description("Read the bundled Acpus agent skill.");

  command.addCommand(new Command("read")
    .exitOverride()
    .description("Read a bundled Acpus skill file or list a directory.")
    .argument("[path]", "canonical skill-root-relative file or directory path")
    .action(async (resourcePath?: string) => {
      const rootPath = await resolveBundledSkillRoot();
      const resource = await Effect.runPromise(Effect.result(readAcpusSkillResource(rootPath, resourcePath)));
      if (Result.isFailure(resource)) throw skillError(resource.failure.message);
      ctx.stdout.write(formatSkillResource(resource.success));
      if (resource.success.kind === "file") {
        if (resourcePath === undefined || resourcePath === "SKILL.md") {
          ctx.stdout.write(await formatSkillAgentAuthoringContext(ctx.cwd));
        }
        ctx.stdout.write(resource.success.content);
      } else if (resource.success.entries.length > 0) {
        ctx.stdout.write(`${resource.success.entries.map(entry => `${entry.kind}\t${entry.path}`).join("\n")}\n`);
      }
      ctx.setExitCode(0);
    }));

  return command;
}

async function formatSkillAgentAuthoringContext(workspaceDir: string): Promise<string> {
  const context = await Effect.runPromise(Effect.result(loadAgentAuthoringContext({ workspaceDir })));
  if (Result.isSuccess(context)) {
    return [
      "[acpus agent authoring context]",
      "status: available",
      formatAgentAuthoringContext(context.success).trimEnd(),
      "[/acpus agent authoring context]",
      "",
      "",
    ].join("\n");
  }
  const error = context.failure.message.replace(/\s+/gu, " ").trim().slice(0, 300);
  return [
    "[acpus agent authoring context]",
    "status: unavailable",
    `error: ${error}`,
    "action: Repair the invalid Acpus config or ACPUS_AUTHORING_AGENT_SCALE, then run `acpus skill read` again before authoring.",
    "Agent authoring must not continue until this context is available.",
    "[/acpus agent authoring context]",
    "",
    "",
  ].join("\n");
}

async function resolveBundledSkillRoot(): Promise<string> {
  const source = await Effect.runPromise(Effect.result(bundledAcpusSkillPath(getCliPackageInfo().version)));
  if (Result.isFailure(source)) throw skillError(source.failure.message);
  return source.success;
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
