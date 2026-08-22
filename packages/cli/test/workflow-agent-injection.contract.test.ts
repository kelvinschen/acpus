import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/program.js";
import { CaptureStream } from "./support/capture-stream.js";
import { withAuthoringTestWorkspace } from "./support/workspace.js";

describe("workflow Agent injection CLI contract", () => {
  it("finalizes a configured Preset injection through the real workflow check boundary", async () => {
    await withAuthoringTestWorkspace("workflow-agent-injection", async workspace => {
      const workflow = join(workspace, "workflow.ts");
      await writeFile(workflow, [
        'import { defineWorkflow } from "acpus/core";',
        "export default defineWorkflow({",
        '  name: "agent-injection-check",',
        "  agents: { worker: {}, reviewer: {} },",
        "}).build(() => ({ ok: true }));",
        "",
      ].join("\n"));
      await mkdir(join(workspace, ".acpus"), { recursive: true });
      await writeFile(join(workspace, ".acpus", "config.json"), `${JSON.stringify({
        presets: {
          "critical-reviewer": {
            guidance: "Critical review",
            agent: { use: "claude", model: "review-model" },
          },
        },
      })}\n`);
      const complete = await invoke(workspace, [
        "workflow", "check", workflow, "--agents",
        '{"worker":{"use":"codex"},"reviewer":{"preset":"critical-reviewer"}}',
      ]);
      expect(complete.exitCode, complete.stderr).toBe(0);
      expect(complete.stdout).not.toContain("Unbound Agent slots:");
      expect(complete.stderr).toBe("");
    });
  });
});

async function invoke(cwd: string, argv: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const stdout = new CaptureStream();
  const stderr = new CaptureStream();
  const exitCode = await runCli(argv, { cwd, stdout, stderr });
  return { exitCode, stdout: stdout.text, stderr: stderr.text };
}
