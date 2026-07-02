import { access } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runSourceCli } from "./support/cli-runner.js";
import { copyWorkflowFixture } from "./support/fixtures.js";
import { withTestWorkspace } from "./support/workspace.js";

describe.concurrent("acpus workflows run smoke", () => {
  it("checks a workflow without validating missing submit input", async () => {
    await withTestWorkspace("workflow-check-no-input", async workspace => {
      const workflow = await copyWorkflowFixture(workspace, "workflows/basic/valid.workflow.ts");

      const result = await runSourceCli(workspace, ["workflows", "check", workflow, "--json"]);

      expect(result.exitCode).toBe(0);
      const output = JSON.parse(result.stdout);
      expect(output).toMatchObject({
        ok: true,
        phase: "check",
      });
      expect(output.preflightDir).toEqual(expect.stringContaining(".acpus/preflight/"));
      expect(output.irDigest).toEqual(expect.stringMatching(/^sha256:/));
      expect(output.sourceGraphDigest).toEqual(expect.stringMatching(/^sha256:/));
      await expect(access(join(workspace, ".acpus", "state", "runtime.db"))).rejects.toThrow();
    });
  });

  it("runs a pure workflow and reports the completed run", async () => {
    await withTestWorkspace("run-pure", async workspace => {
      const workflow = await copyWorkflowFixture(workspace, "workflows/basic/valid.workflow.ts");

      const result = await runSourceCli(workspace, ["workflows", "run", workflow, "--input", "{\"ready\":true}", "--json"]);

      expect(result.exitCode).toBe(0);
      const lines = result.stdout.trim().split("\n").map(line => JSON.parse(line));
      expect(lines[0]).toMatchObject({ phase: "run", kind: "admitted" });
      expect(lines.slice(1, -1)).toEqual(expect.arrayContaining([
        expect.objectContaining({ phase: "run", kind: "node completed" }),
      ]));
      expect(lines.at(-1)).toMatchObject({
        ok: true,
        phase: "run",
        kind: "terminal summary",
        run: {
          status: "completed",
        },
      });
    });
  });

  it("prints bounded observations in foreground text mode", async () => {
    await withTestWorkspace("run-pure-text-observations", async workspace => {
      const workflow = await copyWorkflowFixture(workspace, "workflows/basic/valid.workflow.ts");

      const result = await runSourceCli(workspace, ["workflows", "run", workflow, "--input", "{\"ready\":true}"]);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toMatch(/node completed: require_ready~[a-f0-9]+ completed/);
      expect(result.stdout).toContain("Run completed.");
    });
  });

  it("rejects invalid JSON input without creating runtime state", async () => {
    await withTestWorkspace("run-invalid-json", async workspace => {
      const workflow = await copyWorkflowFixture(workspace, "workflows/basic/valid.workflow.ts");

      const result = await runSourceCli(workspace, ["workflows", "run", workflow, "--input", "{", "--json"]);

      expect(result.exitCode).toBe(2);
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: false,
        phase: "usage",
      });
      await expect(access(join(workspace, ".acpus", "state", "runtime.db"))).rejects.toThrow();
    });
  });

  it("rejects schema-invalid input without creating runtime state", async () => {
    await withTestWorkspace("run-invalid-schema-input", async workspace => {
      const workflow = await copyWorkflowFixture(workspace, "workflows/basic/valid.workflow.ts");

      const result = await runSourceCli(workspace, ["workflows", "run", workflow, "--input", "{\"ready\":\"yes\"}", "--json"]);

      expect(result.exitCode).toBe(1);
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: false,
        phase: "validate",
      });
      await expect(access(join(workspace, ".acpus", "state", "runtime.db"))).rejects.toThrow();
    });
  });

  it("rejects invalid agent override JSON before creating runtime state", async () => {
    await withTestWorkspace("run-invalid-agents-json", async workspace => {
      const workflow = await copyWorkflowFixture(workspace, "workflows/basic/valid.workflow.ts");

      for (const agents of ["{", "[]"]) {
        const result = await runSourceCli(workspace, ["workflows", "run", workflow, "--agents", agents, "--json"]);

        expect(result.exitCode).toBe(2);
        expect(JSON.parse(result.stdout)).toMatchObject({
          ok: false,
          phase: "usage",
        });
      }
      await expect(access(join(workspace, ".acpus", "state", "runtime.db"))).rejects.toThrow();
    });
  });

  it("admits background runs without local scheduler advancement", async () => {
    await withTestWorkspace("run-background", async workspace => {
      const workflow = await copyWorkflowFixture(workspace, "workflows/signals/signal.workflow.ts");

      const result = await runSourceCli(workspace, ["workflows", "run", workflow, "--background", "--json"]);

      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: true,
        phase: "run",
        run: {
          status: "pending",
        },
      });
    });
  });
});
