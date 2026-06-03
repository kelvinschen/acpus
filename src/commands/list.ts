import fs from "node:fs/promises";
import path from "node:path";
import type { Command } from "commander";
import { globalWorkflowsDir, projectWorkflowsDir, runsDir } from "../run-index/paths.js";
import { printJson } from "./common.js";

export function registerList(program: Command): void {
  const list = program.command("list");

  list.command("workflows")
    .option("--global", "list global workflows")
    .option("--json", "print JSON")
    .action(async (options: { global?: boolean; json?: boolean }) => {
      const kind = "workflows";
      const dir = options.global ? globalWorkflowsDir() : projectWorkflowsDir();
      const entries = await safeList(dir);
      const output = { kind, dir, entries };
      if (options.json) printJson(output);
      else {
        process.stdout.write(`${kind} in ${dir}\n`);
        for (const entry of entries) process.stdout.write(`- ${entry}\n`);
      }
    });

  list.command("runs")
    .option("--json", "print JSON")
    .action(async (options: { json?: boolean }) => {
      const kind = "runs";
      const dir = runsDir();
      const entries = await safeList(dir);
      const output = { kind, dir, entries };
      if (options.json) printJson(output);
      else {
        process.stdout.write(`${kind} in ${dir}\n`);
        for (const entry of entries) process.stdout.write(`- ${entry}\n`);
      }
    });
}

async function safeList(dir: string): Promise<string[]> {
  try {
    return (await fs.readdir(dir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() || entry.isFile())
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}
