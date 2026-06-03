import fs from "node:fs/promises";
import path from "node:path";
import type { Command } from "commander";
import { resolveRunLocator } from "../run-index/locator.js";
import { globalWorkflowsDir, projectWorkflowsDir, runDir } from "../run-index/paths.js";
import { printJson } from "./common.js";

export function registerShow(program: Command): void {
  const show = program.command("show");

  show.command("workflow")
    .argument("<name>", "workflow name")
    .option("--global", "show global workflow")
    .option("--json", "print JSON")
    .action(async (name: string, options: { global?: boolean; json?: boolean }) => {
      const file = path.join(
        options.global ? globalWorkflowsDir() : projectWorkflowsDir(),
        name,
        "workflow.spec.json"
      );
      const text = await fs.readFile(file, "utf8");
      if (options.json) printJson(JSON.parse(text));
      else process.stdout.write(text);
    });

  show.command("run")
    .argument("<id>", "run id or directory")
    .option("--json", "print JSON")
    .action(async (id: string, options: { json?: boolean }) => {
      const locator = await resolveRunLocator(id);
      const file = path.join(runDir(locator.runId, locator.cwd), "run.json");
      const text = await fs.readFile(file, "utf8");
      if (options.json) printJson(JSON.parse(text));
      else process.stdout.write(text);
    });
}
