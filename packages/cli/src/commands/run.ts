import type { Writable } from "node:stream";
import { Command } from "commander";
import type { JsonValue } from "@acpus/core/ir";
import { admitWorkflowRun, normalizeWorkflowInput } from "@acpus/runtime";
import { writePreflightArtifact } from "@acpus/workflow-compiler";
import { usageError, validationError } from "../errors.js";
import { summarizeWorkflow, writeResult, type OutputFormat } from "../output.js";
import { prepareWorkflowForCli } from "../workflow-preparation.js";

export type RunCommandContext = {
  cwd: string;
  stdout: Writable;
  stderr: Writable;
  wantsJson: boolean;
  setExitCode(code: number): void;
};

type RunCommandOptions = {
  dryRun?: boolean;
  json?: boolean;
  input?: string;
};

export function createRunCommand(ctx: RunCommandContext): Command {
  return new Command("run")
    .exitOverride()
    .configureOutput({
      writeOut: text => ctx.stdout.write(text),
      writeErr: text => {
        if (!ctx.wantsJson) ctx.stderr.write(text);
      },
      outputError: (text, write) => write(text),
    })
    .description("Typecheck, compile, and validate a TypeScript workflow module.")
    .argument("<workflow-module>", "workflow module path")
    .option("--dry-run", "run the pre-run gate without executing the workflow")
    .option("--input <json>", "freeze this JSON value as the workflow input")
    .option("--json", "print a structured JSON result")
    .action(async (workflow: string, options: RunCommandOptions) => {
      const format: OutputFormat = options.json ? "json" : "text";
      const input = parseInput(options.input);
      if (options.dryRun) {
        const prepared = await prepareWorkflowForCli(workflow, ctx.cwd);
        const artifact = await writePreflightArtifact(prepared, ctx.cwd);
        const result = {
          ok: true,
          phase: "dry-run" as const,
          message: "Workflow dry-run passed.",
          workflow: summarizeWorkflow(prepared.ir),
          diagnostics: prepared.ir.diagnostics,
          preflightDir: artifact.dir,
          irDigest: prepared.irDigest,
          taskBundleCount: Object.keys(prepared.ir.assets.taskBundles).length,
          sourceGraphDigest: prepared.sourceGraphDigest,
        };
        ctx.setExitCode(writeResult(result, format, ctx, 0));
        return;
      }

      const prepared = await prepareWorkflowForCli(workflow, ctx.cwd);
      let admittedInput: JsonValue;
      try {
        admittedInput = normalizeWorkflowInput(prepared.ir, input);
      } catch (error) {
        throw validationError(error instanceof Error ? error.message : String(error));
      }
      const advanced = await admitWorkflowRun(ctx.cwd, prepared, admittedInput);
      if (advanced.status === "failed") {
        ctx.setExitCode(writeResult({
          ok: false,
          phase: "admit",
          message: advanced.message,
          workflow: summarizeWorkflow(prepared.ir),
          diagnostics: prepared.ir.diagnostics,
          irDigest: prepared.irDigest,
          taskBundleCount: Object.keys(prepared.ir.assets.taskBundles).length,
          sourceGraphDigest: prepared.sourceGraphDigest,
          run: advanced.run,
        }, format, ctx, 1));
        return;
      }
      ctx.setExitCode(writeResult({
        ok: true,
        phase: "admit",
        message: advanced.status === "completed" ? "Run completed." : advanced.status === "awaiting" ? `Run awaiting signal '${advanced.nodeKey}'.` : "Run admitted.",
        workflow: summarizeWorkflow(prepared.ir),
        diagnostics: prepared.ir.diagnostics,
        irDigest: prepared.irDigest,
        taskBundleCount: Object.keys(prepared.ir.assets.taskBundles).length,
        sourceGraphDigest: prepared.sourceGraphDigest,
        run: advanced.run,
      }, format, ctx, 0));
    });
}

function parseInput(raw: string | undefined): JsonValue {
  if (!raw) return {};
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch (error) {
    throw usageError(`--input must be valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isJsonValue(value)) throw usageError("--input must be a JSON object, array, string, number, boolean, or null.");
  return value;
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null) return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "string" || typeof value === "boolean") return true;
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isJsonObject(value) && Object.values(value).every(isJsonValue);
}

function isJsonObject(value: unknown): value is { [key: string]: JsonValue } {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
