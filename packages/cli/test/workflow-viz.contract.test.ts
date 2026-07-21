import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/program.js";
import { CaptureStream } from "./support/capture-stream.js";
import { withTestWorkspace } from "./support/workspace.js";

describe("workflow visualization CLI contract", () => {
  it("renders the semantic tree as terminal text", async () => {
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

      const unsupportedStdout = new CaptureStream();
      const unsupportedStderr = new CaptureStream();
      const unsupportedExitCode = await runCli(["workflow", "viz", workflow, "--json"], {
        cwd: workspace,
        stdout: unsupportedStdout,
        stderr: unsupportedStderr,
      });

      expect(unsupportedExitCode).toBe(2);
      expect(unsupportedStdout.text).toBe("");
      expect(unsupportedStderr.text).toContain("unknown option '--json'");
    });
  });

  it("rejects --force without --out before workflow preparation", async () => {
    const stdout = new CaptureStream();
    const stderr = new CaptureStream();
    const exitCode = await runCli(["workflow", "viz", "missing.workflow.ts", "--force"], {
      cwd: process.cwd(),
      stdout,
      stderr,
    });

    expect(exitCode).toBe(2);
    expect(stdout.text).toBe("");
    expect(stderr.text).toContain("--force requires --out.");
  });

  it("generates workflow visualization HTML with overwrite controls", async () => {
    await withTestWorkspace("workflow-viz-program", async workspace => {
      const workflow = await writeVizWorkflow(workspace);
      const out = join(workspace, "artifacts", "viz.html");

      const stdout = new CaptureStream();
      const stderr = new CaptureStream();
      const exitCode = await runCli(["workflow", "viz", workflow, "--out", out], { cwd: workspace, stdout, stderr });

      expect(exitCode).toBe(0);
      expect(stdout.text).toContain(`Output: ${out}`);
      const html = await readFile(out, "utf8");
      expect(html).toContain("window.__ACPUS_WORKFLOW_VIZ__=");
      expect(html).toContain("Program viz description.");
      expect(html).not.toMatch(/\s(?:src|href)=["']https?:\/\//);
      const bundleJson = html.split("window.__ACPUS_WORKFLOW_VIZ__=")[1]?.split(";\n</script>")[0];
      if (!bundleJson) throw new Error("expected workflow visualization bundle");
      expect(JSON.parse(bundleJson).workflow.nodeCount).toBe(4);
      expect(stderr.text).toBe("");

      const duplicateStdout = new CaptureStream();
      const duplicateStderr = new CaptureStream();
      const duplicateExit = await runCli(["workflow", "viz", workflow, "--out", out], {
        cwd: workspace,
        stdout: duplicateStdout,
        stderr: duplicateStderr,
      });
      expect(duplicateExit).toBe(2);
      expect(duplicateStdout.text).toBe("");
      expect(duplicateStderr.text).toContain("already exists");

      const forcedStdout = new CaptureStream();
      const forcedExit = await runCli(["workflow", "viz", workflow, "--out", out, "--force"], {
        cwd: workspace,
        stdout: forcedStdout,
        stderr: new CaptureStream(),
      });
      expect(forcedExit).toBe(0);
    });
  });

  it("classifies filesystem failures as operational visualization errors", async () => {
    await withTestWorkspace("workflow-viz-io", async workspace => {
      const workflow = await writeVizWorkflow(workspace);
      const blockedParent = join(workspace, "not-a-directory");
      await writeFile(blockedParent, "file");
      const stdout = new CaptureStream();
      const stderr = new CaptureStream();

      const exitCode = await runCli(["workflow", "viz", workflow, "--out", join(blockedParent, "viz.html")], {
        cwd: workspace,
        stdout,
        stderr,
      });

      expect(exitCode).toBe(1);
      expect(stdout.text).toBe("");
      expect(stderr.text).toContain("not-a-directory");
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
