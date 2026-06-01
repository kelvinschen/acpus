import fs from "node:fs/promises";
import path from "node:path";
import type { Command } from "commander";
import { draftsDir, globalWorkflowsDir, projectWorkflowsDir, runsDir } from "../run-index/paths.js";
import { printJson } from "./common.js";

export function registerList(program: Command): void {
  program.command("list")
    .argument("<kind>", "workflows|runs|drafts")
    .option("--global", "list global workflows")
    .option("--json", "print JSON")
    .action(async (kind: string, options: { global?: boolean; json?: boolean }) => {
      const dir = kind === "workflows"
        ? (options.global ? globalWorkflowsDir() : projectWorkflowsDir())
        : kind === "runs"
          ? runsDir()
          : kind === "drafts"
            ? draftsDir()
            : "";
      if (!dir) throw new Error("kind must be workflows, runs, or drafts");
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
