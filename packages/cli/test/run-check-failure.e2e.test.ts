import { describe, expect, it } from "vitest";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { runSourceCli } from "./support/cli-runner.js";
import { copyWorkflowFixture } from "./support/fixtures.js";
import { withTestWorkspace } from "./support/workspace.js";

describe.concurrent("acpus workflows check preparation failure smoke", () => {
  it("reports workflow check failures through the CLI phase mapping", async () => {
    await withTestWorkspace("run-check", async workspace => {
      const workflow = await copyWorkflowFixture(workspace, "workflows/invalid/type-error.workflow.fixture", "type-error.workflow.ts");

      const result = await runSourceCli(workspace, ["workflows", "check", workflow, "--json"]);

      expect(result.exitCode).toBe(1);
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: false,
        phase: "check",
        diagnostics: expect.arrayContaining([
          expect.objectContaining({ code: expect.stringMatching(/^TS/) }),
        ]),
      });
    });
  });

  it("validates check input without creating runtime state", async () => {
    await withTestWorkspace("run-check-input", async workspace => {
      const workflow = await copyWorkflowFixture(workspace, "workflows/basic/valid.workflow.ts");

      const result = await runSourceCli(workspace, ["workflows", "check", workflow, "--input", "{\"ready\":\"yes\"}", "--json"]);

      expect(result.exitCode).toBe(1);
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: false,
        phase: "validate",
      });
      await expect(access(join(workspace, ".acpus", "state", "runtime.db"))).rejects.toThrow();
    });
  });

  it("rejects malformed check input before creating runtime state", async () => {
    await withTestWorkspace("run-check-malformed-input", async workspace => {
      const workflow = await copyWorkflowFixture(workspace, "workflows/basic/valid.workflow.ts");

      const result = await runSourceCli(workspace, ["workflows", "check", workflow, "--input", "{", "--json"]);

      expect(result.exitCode).toBe(2);
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: false,
        phase: "usage",
      });
      await expect(access(join(workspace, ".acpus", "state", "runtime.db"))).rejects.toThrow();
    });
  });
});
