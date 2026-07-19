import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/program.js";
import { CaptureStream } from "./support/capture-stream.js";
import { withTestWorkspace } from "./support/workspace.js";

describe("workflow visualization CLI contract", () => {
  it("renders the semantic tree to text and structured JSON by default", async () => {
    await withTestWorkspace("workflow-viz-terminal", async workspace => {
      const workflow = await writeVizWorkflow(workspace);
      const expected = `program-viz
input { ready: boolean }
output { ready }
agents: none

┌─ ? choose · if
│  ├┄ then
│  │  └─ ◈ then_check · assert
│  └┄ else
│     └─ ◈ else_check · assert
└─ ◈ after · assert`;

      const stdout = new CaptureStream();
      const stderr = new CaptureStream();
      const exitCode = await runCli(["workflow", "viz", workflow], { cwd: workspace, stdout, stderr });

      expect(exitCode).toBe(0);
      expect(stdout.text).toBe(`${expected}\n`);
      expect(stderr.text).toBe("");

      const jsonStdout = new CaptureStream();
      const jsonStderr = new CaptureStream();
      const jsonExitCode = await runCli(["workflow", "viz", workflow, "--json"], {
        cwd: workspace,
        stdout: jsonStdout,
        stderr: jsonStderr,
      });

      expect(jsonExitCode).toBe(0);
      expect(JSON.parse(jsonStdout.text)).toMatchObject({
        ok: true,
        phase: "viz",
        visualization: expected,
        workflow: { name: "program-viz", nodeCount: 4 },
      });
      expect(jsonStdout.text).not.toContain("\u001b");
      expect(jsonStderr.text).toBe("");
    });
  });

  it("rejects --force without --out before workflow preparation", async () => {
    const stdout = new CaptureStream();
    const stderr = new CaptureStream();
    const exitCode = await runCli(["workflow", "viz", "missing.workflow.ts", "--force", "--json"], {
      cwd: process.cwd(),
      stdout,
      stderr,
    });

    expect(exitCode).toBe(2);
    expect(JSON.parse(stdout.text)).toMatchObject({
      ok: false,
      phase: "usage",
      message: "--force requires --out.",
    });
    expect(stderr.text).toBe("");
  });

  it("generates workflow visualization HTML with overwrite controls", async () => {
    await withTestWorkspace("workflow-viz-program", async workspace => {
      const workflow = await writeVizWorkflow(workspace);
      const out = join(workspace, "artifacts", "viz.html");

      const stdout = new CaptureStream();
      const stderr = new CaptureStream();
      const exitCode = await runCli(["workflow", "viz", workflow, "--out", out, "--json"], { cwd: workspace, stdout, stderr });

      expect(exitCode).toBe(0);
      expect(JSON.parse(stdout.text)).toMatchObject({
        ok: true,
        phase: "viz",
        outputPath: out,
        workflow: { name: "program-viz", nodeCount: 4 },
      });
      const html = await readFile(out, "utf8");
      expect(html).toContain("window.__ACPUS_WORKFLOW_VIZ__=");
      expect(html).toContain("Program viz description.");
      expect(html).not.toMatch(/\s(?:src|href)=["']https?:\/\//);
      const bundleJson = html.split("window.__ACPUS_WORKFLOW_VIZ__=")[1]?.split(";\n</script>")[0];
      if (!bundleJson) throw new Error("expected workflow visualization bundle");
      expect(JSON.parse(bundleJson).workflow.nodeCount).toBe(4);
      expect(stderr.text).toBe("");

      const duplicateStdout = new CaptureStream();
      const duplicateExit = await runCli(["workflow", "viz", workflow, "--out", out, "--json"], {
        cwd: workspace,
        stdout: duplicateStdout,
        stderr: new CaptureStream(),
      });
      expect(duplicateExit).toBe(2);
      expect(JSON.parse(duplicateStdout.text).message).toContain("already exists");

      const forcedStdout = new CaptureStream();
      const forcedExit = await runCli(["workflow", "viz", workflow, "--out", out, "--force", "--json"], {
        cwd: workspace,
        stdout: forcedStdout,
        stderr: new CaptureStream(),
      });
      expect(forcedExit).toBe(0);
    });
  });
});

async function writeVizWorkflow(workspace: string): Promise<string> {
  const workflow = join(workspace, "workflow.ts");
  await writeFile(workflow, `import { defineWorkflow, z } from "acpus/core";

export default defineWorkflow({
  name: "program-viz",
  description: "Program viz description.",
  inputSchema: z.object({ ready: z.boolean() }),
}).build(({ input, step }) => {
  step("choose").if({
    condition: input.ready,
    then() {
      step("then_check").assert({ condition: true });
      return {};
    },
    else() {
      step("else_check").assert({ condition: true });
      return {};
    },
  });
  step("after").assert({ condition: true });
  return { ready: input.ready };
});
`);
  return workflow;
}
