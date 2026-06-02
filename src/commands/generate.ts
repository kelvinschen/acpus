import fs from "node:fs/promises";
import path from "node:path";
import type { Command } from "commander";
import { draftsDir } from "../run-index/paths.js";
import { printJson } from "./common.js";

export function registerGenerate(program: Command): void {
  program.command("generate")
    .option("--name <name>", "draft name", "draft-workflow")
    .option("--json", "print JSON")
    .action(async (options: { name: string; json?: boolean }) => {
      const dir = draftsDir();
      await fs.mkdir(dir, { recursive: true });
      const file = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}-${options.name}.workflow.spec.json`);
      const spec = {
        schemaVersion: "acpus.workflow/v1",
        name: options.name,
        description: "Draft workflow scaffold. Main Agent should edit before running.",
        root: "plan",
        inputs: {
          task: { type: "string", default: "" },
          cwd: { type: "path", default: "." }
        },
        roles: {
          planner: { category: "planning", agent: "claude", mode: "readOnly" }
        },
        limits: { stageTimeoutMinutes: 30 },
        stages: [
          { id: "plan", kind: "agentTask", role: "planner", prompt: "Plan the requested workflow task: ${task}", variables: [{ name: "task", source: "input.task" }] },
          { id: "gate", kind: "gate", dependsOn: ["plan"] }
        ]
      };
      await fs.writeFile(file, `${JSON.stringify(spec, null, 2)}\n`, "utf8");
      if (options.json) printJson({ ok: true, path: file });
      else process.stdout.write(`${file}\n`);
    });
}
