#!/usr/bin/env node
import { resolve } from "node:path";
import { compileWorkflow, lintWorkflow } from "@acpus/core";
import { Command } from "commander";
import { createIncludeResolver, parseInput, readTextFile } from "./io.js";
import { printCompile, printError, printLint } from "./output.js";

const EXIT_DSL_STATIC_ERROR = 10;
const EXIT_RUNTIME_NOT_IMPLEMENTED = 20;
const EXIT_BACKEND_OR_CLI_ERROR = 40;

const program = new Command();

program
  .name("acpus")
  .description("Temporal-backed ACP Agent YAML orchestrator")
  .version("0.1.0");

program
  .command("lint")
  .argument("<spec>", "workflow YAML spec")
  .option("--strict", "treat warnings as errors")
  .option("--json", "write JSONL output")
  .option("--quiet", "only write final output")
  .action((spec: string, options: { strict?: boolean; json?: boolean; quiet?: boolean }) => {
    try {
      const sourcePath = resolve(process.cwd(), spec);
      const result = lintWorkflow(readTextFile(sourcePath), {
        sourcePath,
        strict: options.strict,
        includeResolver: createIncludeResolver()
      });
      printLint(result, options);
      process.exitCode = result.ok ? 0 : EXIT_DSL_STATIC_ERROR;
    } catch (error) {
      printError(errorMessage(error), options);
      process.exitCode = EXIT_BACKEND_OR_CLI_ERROR;
    }
  });

program
  .command("run")
  .argument("<spec>", "workflow YAML spec")
  .option("--dry-run", "compile to IR and print schedule without execution")
  .option("--input <value>", "inline JSON or path to YAML/JSON input object")
  .option("--json", "write JSONL output")
  .option("--quiet", "only write final output")
  .action((spec: string, options: { dryRun?: boolean; input?: string; json?: boolean; quiet?: boolean }) => {
    try {
      if (!options.dryRun) {
        printError("Runtime execution is not implemented in M1. Re-run with --dry-run to compile and inspect the workflow.", options);
        process.exitCode = EXIT_RUNTIME_NOT_IMPLEMENTED;
        return;
      }

      const sourcePath = resolve(process.cwd(), spec);
      const inputs = parseInput(options.input);
      const result = compileWorkflow(readTextFile(sourcePath), {
        sourcePath,
        includeResolver: createIncludeResolver()
      });
      const output = inputs === undefined || !result.ir ? result : { ...result, ir: { ...result.ir, runtimeInputs: inputs } };
      printCompile(output, options);
      process.exitCode = result.ok ? 0 : EXIT_DSL_STATIC_ERROR;
    } catch (error) {
      printError(errorMessage(error), options);
      process.exitCode = EXIT_BACKEND_OR_CLI_ERROR;
    }
  });

program.parse();

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
