import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import type { WorkflowIR } from "@acpus/core";

const repoRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

describe("acpus run --dry-run", () => {
  it("typechecks, compiles, and validates a workflow module", async () => {
    await withWorkflow(validWorkflow(), async workflow => {
      const result = await runCli(["run", workflow, "--dry-run"]);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Workflow dry-run passed.");
      expect(result.stdout).toContain("Workflow: cli-valid");
      expect(result.stdout).toContain("Diagnostics: 0 errors, 0 warnings, 0 infos");
      expect(result.stdout).toContain("Preflight:");
      expect(result.stdout).toContain("IR digest: sha256:");
    });
  });

  it("prints stable JSON output", async () => {
    await withWorkflow(validWorkflow(), async workflow => {
      const result = await runCli(["run", workflow, "--dry-run", "--json"]);

      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: true,
        phase: "dry-run",
        workflow: {
          name: "cli-valid",
          irVersion: 2,
          nodeCount: 1,
          outputKeys: ["ready"],
          diagnostics: {
            errors: 0,
            warnings: 0,
          },
        },
        taskBundleCount: 0,
      });
      const json = JSON.parse(result.stdout);
      expect(json.preflightDir).toContain(".acpus/preflight/");
      expect(json.irDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
      expect(json.sourceGraphDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    });
  });

  it("writes a frozen preflight artifact by default", async () => {
    await withWorkflow(validWorkflow(), async workflow => {
      const result = await runCli(["run", workflow, "--dry-run", "--json"]);

      expect(result.exitCode).toBe(0);
      const json = JSON.parse(result.stdout);
      const ir = JSON.parse(await readFile(join(json.preflightDir, "workflow.ir.json"), "utf8")) as WorkflowIR;
      const lock = JSON.parse(await readFile(join(json.preflightDir, "lock.json"), "utf8"));
      expect(ir.name).toBe("cli-valid");
      expect(ir.diagnostics.filter(diagnostic => diagnostic.severity === "error")).toEqual([]);
      expect(lock).toMatchObject({
        kind: "acpus_preflight_lock",
        version: 1,
        ir: { path: "workflow.ir.json", digest: json.irDigest },
      });
    });
  });

  it("fails before compile when TypeScript typecheck fails", async () => {
    await withWorkflow(typeErrorWorkflow(), async workflow => {
      const result = await runCli(["run", workflow, "--dry-run", "--json"]);

      expect(result.exitCode).toBe(1);
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: false,
        phase: "typecheck",
        message: "Workflow typecheck failed.",
      });
      expect(result.stdout).toContain("Type 'number' is not assignable to type 'string'");
    });
  });

  it("fails when compiled IR has error diagnostics", async () => {
    await withWorkflow(malformedWorkflow(), async workflow => {
      const result = await runCli(["run", workflow, "--dry-run", "--json"]);

      expect(result.exitCode).toBe(1);
      const json = JSON.parse(result.stdout);
      expect(json).toMatchObject({
        ok: false,
        phase: "validate",
        workflow: {
          name: "cli-malformed",
        },
      });
      expect(json.workflow.diagnostics.errors).toBeGreaterThan(0);
      expect(result.stdout).toContain("ID001");
    });
  });

  it("requires --dry-run until the runtime scheduler exists", async () => {
    await withWorkflow(validWorkflow(), async workflow => {
      const result = await runCli(["run", workflow]);

      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("Runtime scheduler is not implemented yet.");
    });
  });

  it("returns JSON usage errors for unknown options", async () => {
    await withWorkflow(validWorkflow(), async workflow => {
      const result = await runCli(["run", workflow, "--dry-run", "--bogus", "--json"]);

      expect(result.exitCode).toBe(2);
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: false,
        phase: "usage",
      });
      expect(result.stdout).toContain("unknown option");
      expect(result.stderr).toBe("");
    });
  });

  it("does not support --ir-out", async () => {
    await withWorkflow(validWorkflow(), async workflow => {
      const result = await runCli(["run", workflow, "--dry-run", "--ir-out", "workflow.ir.json", "--json"]);

      expect(result.exitCode).toBe(2);
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: false,
        phase: "usage",
      });
      expect(result.stdout).toContain("unknown option");
    });
  });

  it("returns JSON usage errors for unknown commands", async () => {
    const result = await runCli(["bogus", "--json"]);

    expect(result.exitCode).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      phase: "usage",
    });
    expect(result.stdout).toContain("unknown command");
    expect(result.stderr).toBe("");
  });

  it("shows commander help with only the run command", async () => {
    const result = await runCli(["--help"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Usage: acpus");
    expect(result.stdout).toContain("run");
    expect(result.stdout).not.toContain("compile [");
    expect(result.stdout).not.toContain("check [");
    expect(result.stdout).not.toContain("help [");
  });
});

async function withWorkflow(source: string, fn: (workflow: string) => Promise<void>): Promise<void> {
  await mkdir(join(repoRoot, ".tmp-tests"), { recursive: true });
  const dir = await mkdtemp(join(repoRoot, ".tmp-tests", "acpus-workflow-"));
  try {
    const workflow = join(dir, "workflow.ts");
    await writeFile(workflow, source);
    await fn(workflow);
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(join(repoRoot, ".acpus", "preflight"), { recursive: true, force: true });
  }
}

async function runCli(args: string[]): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  return new Promise(resolveProcess => {
    const child = spawn(process.execPath, [
      "--conditions=development",
      "--import",
      "tsx",
      cli,
      ...args,
    ], {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, FORCE_COLOR: "0" },
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", chunk => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", chunk => stderr.push(Buffer.from(chunk)));
    child.on("close", exitCode => resolveProcess({
      exitCode,
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8"),
    }));
  });
}

function validWorkflow(): string {
  return `
import { defineWorkflow, where, z } from "@acpus/core";

export default defineWorkflow({
  name: "cli-valid",
  inputSchema: z.object({ ready: z.boolean() }),
}).build(({ input, step, output }) => {
  step("require_ready").assert({
    condition: where(input, { ready: true }),
  });

  return output({ ready: input.ready });
});
`;
}

function typeErrorWorkflow(): string {
  return `
import { defineWorkflow, z } from "@acpus/core";

const value: string = 1;

export default defineWorkflow({
  name: "cli-type-error",
  inputSchema: z.object({ ready: z.boolean() }),
}).build(({ input, output }) => output({ ready: input.ready, value }));
`;
}

function malformedWorkflow(): string {
  return `
import { defineWorkflow, z } from "@acpus/core";

export default defineWorkflow({
  name: "cli-malformed",
  inputSchema: z.object({ ready: z.boolean() }),
}).build(({ input, step, output }) => {
  step("bad id").assert({ condition: true });
  return output({ ready: input.ready });
});
`;
}
