import { Command } from "commander";
import type { Writable } from "node:stream";
import { formatHookLoadError, globalHooksPath, loadHooksConfigScope, loadHooksConfigScopes, projectHooksPath, type HookConfigScope } from "@acpus/runtime";
import { validationError, usageError } from "../errors.js";
import { writeResult, type HookListResult, type OutputFormat } from "../output.js";

export type HooksCommandContext = {
  cwd: string;
  stdout: Writable;
  stderr: Writable;
  wantsJson: boolean;
  setExitCode(code: number): void;
};

type ScopeOptions = {
  project?: boolean;
  global?: boolean;
};

export function createHooksCommand(ctx: HooksCommandContext): Command {
  const command = new Command("hooks")
    .exitOverride()
    .configureOutput({
      writeOut: text => ctx.stdout.write(text),
      writeErr: text => {
        if (!ctx.wantsJson) ctx.stderr.write(text);
      },
      outputError: (text, write) => write(text),
    })
    .description("Inspect runtime hook configuration.");

  command.addCommand(new Command("validate")
    .exitOverride()
    .option("--project", "validate project hooks")
    .option("--global", "validate global hooks")
    .action(async (options: ScopeOptions) => {
      const scopes = await loadSelectedScopes(ctx, options);
      const count = scopes.reduce((sum, scope) => sum + scope.hooks.length, 0);
      ctx.setExitCode(writeResult({
        ok: true,
        phase: "validate",
        message: `OK (${count} hooks)`,
        hookValidation: { count },
      }, outputFormat(ctx), ctx, 0));
    }));

  command.addCommand(new Command("list")
    .exitOverride()
    .option("--project", "list project hooks")
    .option("--global", "list global hooks")
    .action(async (options: ScopeOptions) => {
      const scopes = await loadSelectedScopes(ctx, options);
      ctx.setExitCode(writeResult({
        ok: true,
        phase: "inspect",
        message: "Hooks listed.",
        hooks: groupedHooks(scopes),
      }, outputFormat(ctx), ctx, 0));
    }));

  return command;
}

async function loadSelectedScopes(ctx: HooksCommandContext, options: ScopeOptions): Promise<HookConfigScope[]> {
  if (options.project && options.global) throw usageError("--project and --global are mutually exclusive.");
  const result = options.project
    ? await loadHooksConfigScope("project", projectHooksPath(ctx.cwd))
    : options.global
      ? await loadHooksConfigScope("global", globalHooksPath())
      : await loadHooksConfigScopes(ctx.cwd);
  if (result.isErr()) throw validationError(formatHookLoadError(result.error));
  return Array.isArray(result.value) ? result.value : [result.value];
}

function groupedHooks(scopes: readonly HookConfigScope[]): HookListResult {
  return Object.fromEntries(scopes.map(scope => [scope.source, { path: scope.path, hooks: scope.hooks }]));
}

function outputFormat(ctx: HooksCommandContext): OutputFormat {
  return ctx.wantsJson ? "json" : "text";
}
