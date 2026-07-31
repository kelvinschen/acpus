import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { WorkflowIR } from "@acpus/core/ir";
import type { PreparedWorkflow } from "@acpus/workflow-compiler";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../src/program.js";
import { CaptureStream } from "./support/capture-stream.js";
import { withPlainTestWorkspace } from "./support/workspace.js";

const mock = vi.hoisted(() => ({
  prepareWorkflowForCli: vi.fn(),
}));

vi.mock("../src/workflow-preparation.js", async importOriginal => ({
  ...await importOriginal<typeof import("../src/workflow-preparation.js")>(),
  prepareWorkflowForCli: mock.prepareWorkflowForCli,
}));

describe("workflow visualization CLI contract", () => {
  beforeEach(() => {
    mock.prepareWorkflowForCli.mockReset();
    mock.prepareWorkflowForCli.mockResolvedValue({ prepared: preparedWorkflow() });
  });

  it("renders the semantic tree as terminal text", async () => {
    await withPlainTestWorkspace("workflow-viz-terminal", async workspace => {
      const workflow = await writeWorkflowEntry(workspace);
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
    expect(mock.prepareWorkflowForCli).not.toHaveBeenCalled();
  });

  it("generates workflow visualization HTML with overwrite controls", async () => {
    await withPlainTestWorkspace("workflow-viz-program", async workspace => {
      const workflow = await writeWorkflowEntry(workspace);
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
    await withPlainTestWorkspace("workflow-viz-io", async workspace => {
      const workflow = await writeWorkflowEntry(workspace);
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

async function writeWorkflowEntry(workspace: string): Promise<string> {
  const workflow = join(workspace, "workflow.ts");
  await writeFile(workflow, "export default {};\n");
  return workflow;
}

function preparedWorkflow(): PreparedWorkflow {
  const emptyOutput = { kind: "object", fields: {} } as const;
  const ir: WorkflowIR = {
    irVersion: 7,
    name: "program-viz",
    description: "Program viz description.",
    inputSchema: {
      kind: "object",
      fields: { ready: { kind: "boolean" } },
      required: ["ready"],
      additionalProperties: false,
    },
    agents: {},
    root: {
      nodes: [{
        id: "choose",
        kind: "if",
        condition: { kind: "ref", path: ["input", "ready"] },
        then: {
          nodes: [{ id: "then_check", kind: "assert", condition: { kind: "literal", value: true } }],
          output: emptyOutput,
        },
        else: {
          nodes: [{ id: "else_check", kind: "assert", condition: { kind: "literal", value: true } }],
          output: emptyOutput,
        },
      }, {
        id: "after",
        kind: "assert",
        condition: { kind: "literal", value: true },
      }],
      output: { kind: "object", fields: { ready: { kind: "ref", path: ["input", "ready"] } } },
    },
    diagnostics: [],
  };
  return {
    source: { kind: "workspace", entry: "workflow.ts" },
    ir,
    irJson: `${JSON.stringify(ir, null, 2)}\n`,
    sourceGraphDigest: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    lock: {
      kind: "acpus_workflow_preparation_lock",
      version: 2,
      workflow: {
        source: { kind: "workspace", entry: "workflow.ts" },
        entryDigest: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      },
      ir: {
        path: "workflow.ir.json",
        digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      },
      sourceGraphDigest: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    },
  };
}
