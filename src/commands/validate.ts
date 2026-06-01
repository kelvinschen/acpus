import type { Command } from "commander";
import { loadAndLint, printIssues, printJson, resolveSpecPath } from "./common.js";

export function registerValidate(program: Command): void {
  program.command("validate")
    .option("--spec <path>", "workflow spec path")
    .option("--workflow <name>", "saved workflow name")
    .option("--global", "resolve saved workflow from global directory")
    .option("--json", "print JSON")
    .action(async (options: { spec?: string; workflow?: string; global?: boolean; json?: boolean }) => {
      const specPath = resolveSpecPath(options);
      const { result } = await loadAndLint(specPath);
      if (options.json) printJson(result);
      else printIssues(result);
      if (!result.ok) process.exitCode = 1;
    });
}
