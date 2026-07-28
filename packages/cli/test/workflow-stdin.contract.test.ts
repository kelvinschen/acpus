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

      const exitCode = await runCli(["workflow", "check", "-", "--json"], {
        cwd: workspace,
        stdin: Readable.from([Buffer.from(source)]),
        stdout,
        stderr,
      });

      expect(exitCode, stdout.text).toBe(0);
      expect(JSON.parse(stdout.text)).toMatchObject({
        ok: true,
        phase: "check",
        workflow: {
          name: "stdin-check",
          diagnostics: {
            total: 1,
            errors: 0,
            warnings: 1,
            infos: 0,
          },
        },
        diagnostics: [{
          code: "SC001",
          severity: "warning",
          source: {
            file: "workflow.ts",
            line: 2,
            column: expect.any(Number),
          },
        }],
      });
      expect(stderr.text).toBe("");
    });
  });
});
