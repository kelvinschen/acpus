import { Command } from "commander";
import type { Writable } from "node:stream";
import { formatHookLoadError, loadHooksConfigScope, loadHooksConfigScopes, type HookConfigScope } from "@acpus/runtime";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { validationError, usageError } from "../presentation/errors.js";
import { writeResult, type HookListResult } from "../presentation/output.js";

export type HooksCommandContext = {
  cwd: string;
  stdout: Writable;
  stderr: Writable;
  setExitCode(code: number): void;
};

type ScopeOptions = {
  project?: boolean;
  global?: boolean;
};

export function createHooksCommand(ctx: HooksCommandContext): Command {
  const command = new Command("hooks")
    .exitOverride()
    .description("Inspect runtime hook configuration.");

  command.addCommand(new Command("validate")
    .exitOverride()
    .description("Validate selected hook configuration files.")
    .option("--project", "validate project hooks")
    .option("--global", "validate global hooks")
    .action(async (options: ScopeOptions) => {
      const scopes = await loadSelectedScopes(ctx, options);
      const count = scopes.reduce((sum, scope) => sum + scope.hooks.length, 0);
      const paths = scopes.map(scope => `${scope.source === "project" ? "Project" : "Global"}: ${scope.path}`).join("\n");
      ctx.setExitCode(writeResult({
        ok: true,
        phase: "validate",
        message: `OK (${count} hooks)\n${paths}`,
      }, ctx, 0));
    }));

  command.addCommand(new Command("list")
    .exitOverride()
    .description("List selected hook configurations.")
    .option("--project", "list project hooks")
    .option("--global", "list global hooks")
    .action(async (options: ScopeOptions) => {
      const scopes = await loadSelectedScopes(ctx, options);
      ctx.setExitCode(writeResult({
        ok: true,
        phase: "inspect",
        message: "Hooks listed.",
        hooks: groupedHooks(scopes),
      }, ctx, 0));
    }));

  return command;
}

async function loadSelectedScopes(ctx: HooksCommandContext, options: ScopeOptions): Promise<HookConfigScope[]> {
  if (options.project && options.global) throw usageError("--project and --global are mutually exclusive.");
  if (options.project || options.global) {
    const result = await Effect.runPromise(Effect.result(options.project
      ? loadHooksConfigScope("project", { workspaceDir: ctx.cwd })
      : loadHooksConfigScope("global", {})));
    if (Result.isFailure(result)) throw validationError(formatHookLoadError(result.failure));
    return [result.success];
  }
  const result = await Effect.runPromise(Effect.result(loadHooksConfigScopes(ctx.cwd)));
  if (Result.isFailure(result)) throw validationError(formatHookLoadError(result.failure));
  return result.success;
}

function groupedHooks(scopes: readonly HookConfigScope[]): HookListResult {
  return Object.fromEntries(scopes.map(scope => [scope.source, { path: scope.path, hooks: scope.hooks }]));
}
