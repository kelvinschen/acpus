import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/program.js";
import { CaptureStream } from "./support/capture-stream.js";
import { withAuthoringTestWorkspace } from "./support/workspace.js";

describe("workflow stdin CLI contract", () => {
  it("checks a raw TypeScript workflow supplied through '-'", async () => {
    await withAuthoringTestWorkspace("workflow-stdin-check", async workspace => {
      const source = `\uFEFF${[
        'import { defineWorkflow } from "acpus/core";',
        "export async function load(name: string): Promise<unknown> { return import(name); }",
        'export default defineWorkflow({ name: "stdin-check" }).build(() => ({ ok: true }));',
        "",
      ].join("\n")}`;
      const stdout = new CaptureStream();
      const stderr = new CaptureStream();

      const exitCode = await runCli(["workflow", "check", "-"], {
        cwd: workspace,
        stdin: Readable.from([Buffer.from(source)]),
        stdout,
        stderr,
      });

      expect(exitCode, stdout.text).toBe(0);
      expect(stdout.text).toContain("✓ WorkflowIR          0 errors · 0 static nodes");
      expect(stdout.text).toMatch(/workflow\.ts:2:\d+ \[warning SC001\]/u);
      expect(stderr.text).toBe("");
    });
  });
});
