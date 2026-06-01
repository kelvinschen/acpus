import fs from "node:fs/promises";
import path from "node:path";
import type { Command } from "commander";
import { resolveRunLocator } from "../run-index/locator.js";
import { draftsDir, globalWorkflowsDir, projectWorkflowsDir, runDir } from "../run-index/paths.js";
import { printJson } from "./common.js";

export function registerShow(program: Command): void {
  program.command("show")
    .argument("<kind>", "workflow|run|draft")
    .argument("<name>", "name or run id")
    .option("--global", "show global workflow")
    .option("--json", "print JSON")
    .action(async (kind: string, name: string, options: { global?: boolean; json?: boolean }) => {
      const file = await resolveShowFile(kind, name, options.global);
      if (!file) throw new Error("kind must be workflow, run, or draft");
      const text = await fs.readFile(file, "utf8");
      if (options.json) printJson(JSON.parse(text));
      else process.stdout.write(text);
    });
}

async function resolveShowFile(kind: string, name: string, global?: boolean): Promise<string> {
  if (kind === "workflow") return path.join(global ? globalWorkflowsDir() : projectWorkflowsDir(), name, "workflow.spec.json");
  if (kind === "run") {
    const locator = await resolveRunLocator(name);
    return path.join(runDir(locator.runId, locator.cwd), "run.json");
  }
  if (kind === "draft") return path.join(draftsDir(), name);
  return "";
}
