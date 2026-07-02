import { access, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runSourceCli } from "./support/cli-runner.js";
import { copyWorkflowFixture } from "./support/fixtures.js";
import { withIsolatedTestWorkspace, withTestWorkspace } from "./support/workspace.js";

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

  it("checks and runs a facade-import workflow without workspace node_modules", async () => {
    await withIsolatedTestWorkspace("run-zero-install-facade", async workspace => {
      const workflow = join(workspace, "workflow.ts");
      await writeFile(workflow, `import { defineWorkflow, z } from "acpus/core";
import { where } from "acpus/expression";

export default defineWorkflow({
  name: "zero-install",
  inputSchema: z.object({ ready: z.boolean() }),
}).build(({ input, step }) => {
  step("require_ready").assert({ condition: where(input, { ready: true }) });
  return { ready: input.ready };
});
`);

      const checked = await runSourceCli(workspace, ["workflows", "check", workflow, "--json"]);
      expect(checked.exitCode).toBe(0);
      expect(JSON.parse(checked.stdout)).toMatchObject({
        ok: true,
        phase: "check",
        workflow: { name: "zero-install" },
      });

      const ran = await runSourceCli(workspace, ["workflows", "run", workflow, "--input", "{\"ready\":true}", "--json"]);
      expect(ran.exitCode).toBe(0);
      expect(JSON.parse(ran.stdout.trim().split("\n").at(-1)!)).toMatchObject({
        ok: true,
        phase: "run",
        run: {
          status: "completed",
          output: { ready: true },
        },
      });
    });
  }, 15_000);

  it("checks an official task facade import without workspace node_modules", async () => {
    await withIsolatedTestWorkspace("run-zero-install-task-facade", async workspace => {
      const workflow = join(workspace, "workflow.ts");
      await writeFile(workflow, `import { defineWorkflow, z } from "acpus/core";
import { createWorktree } from "acpus/tasks/git";

export default defineWorkflow({
  name: "zero-install-task-facade",
  inputSchema: z.object({ repo: z.path(), path: z.path() }),
}).build(({ input, step }) => {
  const worktree = step("worktree").task({
    run: {
      task: createWorktree,
      input: { repo: input.repo, path: input.path },
    },
  });
  return { created: worktree.output.created };
});
`);

      const checked = await runSourceCli(workspace, ["workflows", "check", workflow, "--json"]);

      expect(checked.exitCode).toBe(0);
      expect(JSON.parse(checked.stdout)).toMatchObject({
        ok: true,
        phase: "check",
        workflow: { name: "zero-install-task-facade" },
      });
    });
  }, 15_000);

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

  it("runs a facade-import reusable task through the background supervisor", async () => {
    await withIsolatedTestWorkspace("run-background-zero-install-task", async workspace => {
      const workflow = join(workspace, "workflow.ts");
      await writeFile(join(workspace, "tasks.ts"), `import { task, z } from "acpus/core";

export const normalize = task.define({
  inputSchema: z.object({ value: z.string() }),
  exec: async ({ input }) => ({ value: input.value.trim() }),
});
`);
      await writeFile(workflow, `import { defineWorkflow, z } from "acpus/core";
import { normalize } from "./tasks.js";

export default defineWorkflow({
  name: "background-zero-install-task",
  inputSchema: z.object({ value: z.string() }),
}).build(({ input, step }) => {
  const result = step("normalize").task({
    run: { task: normalize, input: { value: input.value } },
  });
  return { value: result.output.value };
});
`);

      const admitted = await runSourceCli(workspace, ["workflows", "run", workflow, "--input", "{\"value\":\" ok \"}", "--background", "--json"]);
      expect(admitted.exitCode).toBe(0);
      const runId = JSON.parse(admitted.stdout).run.id as string;

      await expectRunCompleted(workspace, runId, { value: "ok" });
    });
  }, 20_000);
});

async function expectRunCompleted(workspace: string, runId: string, output: unknown): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const inspected = await runSourceCli(workspace, ["runs", "inspect", runId, "--json"]);
    expect(inspected.exitCode).toBe(0);
    const body = JSON.parse(inspected.stdout);
    if (body.run.status === "completed") {
      expect(body.run.output).toEqual(output);
      return;
    }
    if (body.run.status === "failed") throw new Error(JSON.stringify(body.run.error ?? body.run));
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Run ${runId} did not complete.`);
}
