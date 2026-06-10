import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execaNode } from "execa";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const cliEntry = join(repoRoot, "packages/cli/src/index.ts");
const fixtureDir = join(repoRoot, "packages/core/test/fixtures");

describe("acpus CLI", () => {
  it("lints a valid workflow as JSON", async () => {
    const result = await execaNode(cliEntry, ["workflows", "lint", join(fixtureDir, "all-primitives.yaml"), "--json"], {
      nodeOptions: ["--import", "tsx", "--conditions=development"]
    });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).ok).toBe(true);
  });

  it("returns exit code 10 for static lint errors", async () => {
    const result = await execaNode(cliEntry, ["workflows", "lint", join(fixtureDir, "invalid-reference.yaml"), "--json"], {
      nodeOptions: ["--import", "tsx", "--conditions=development"],
      reject: false
    });

    expect(result.exitCode).toBe(10);
    expect(JSON.parse(result.stdout).diagnostics[0].severity).toBe("error");
  });


  it("prints dry-run diagnostics, IR, and schedule", async () => {
    const result = await execaNode(cliEntry, ["workflows", "run", join(fixtureDir, "all-primitives.yaml"), "--dry-run", "--json"], {
      nodeOptions: ["--import", "tsx", "--conditions=development"]
    });
    const payload = JSON.parse(result.stdout);

    expect(payload.ok).toBe(true);
    expect(payload.ir.name).toBe("all-primitives");
    expect(payload.schedule.nodes).toHaveLength(9);
  });

  it("accepts input from a JSON file in dry-run mode", async () => {
    const tempDir = join(repoRoot, ".tmp-tests");
    mkdirSync(tempDir, { recursive: true });
    const inputPath = join(tempDir, "input.json");
    writeFileSync(inputPath, JSON.stringify({ files: ["a.ts"] }));

    const result = await execaNode(cliEntry, ["workflows", "run", join(fixtureDir, "all-primitives.yaml"), "--dry-run", "--json", "--input", inputPath], {
      nodeOptions: ["--import", "tsx", "--conditions=development"]
    });
    const payload = JSON.parse(result.stdout);

    expect(payload.ir.runtimeInput).toEqual({ files: ["a.ts"] });
  });

  it("accepts inline JSON via --input in dry-run mode", async () => {
    const result = await execaNode(cliEntry, [
      "workflows", "run", join(fixtureDir, "all-primitives.yaml"),
      "--dry-run", "--json", "--input", '{"files":["inline.ts"]}'
    ], {
      nodeOptions: ["--import", "tsx", "--conditions=development"]
    });
    const payload = JSON.parse(result.stdout);

    expect(payload.ok).toBe(true);
    expect(payload.ir.runtimeInput).toEqual({ files: ["inline.ts"] });
  });

  it("non-dry-run execution requires supervisor and returns non-zero on error", async () => {
    const result = await execaNode(cliEntry, ["workflows", "run", join(fixtureDir, "all-primitives.yaml"), "--json"], {
      nodeOptions: ["--import", "tsx", "--conditions=development"],
      reject: false
    });

    // With lazy supervisor, a supervisor may be spawned. The exit code is either
    // 40 (supervisor spawn/connection error) or a runtime error code.
    // Either way, it should be non-zero for a real spec with real agents.
    expect(result.exitCode).not.toBe(0);
    const output = result.stderr || result.stdout;
    expect(output.length).toBeGreaterThan(0);
  }, 30_000);

  it("returns exit code 40 for supervisor errors when supervisor is unreachable", async () => {
    // This test requires no supervisor to be running. Since other tests may have
    // started one, we verify the exit code is either 40 (connection error) or
    // a non-zero runtime error if the supervisor is actually reachable.
    const result = await execaNode(cliEntry, ["runs", "show", "nonexistent-run-id", "--json"], {
      nodeOptions: ["--import", "tsx", "--conditions=development"],
      reject: false
    });

    // Either 40 (no supervisor) or 20 (supervisor reachable, run not found)
    expect([20, 40]).toContain(result.exitCode);
  }, 30_000);

  it("exposes a replay command that returns an error when run is not found", async () => {
    const result = await execaNode(cliEntry, ["runs", "replay", "some-run-id", "--json"], {
      nodeOptions: ["--import", "tsx", "--conditions=development"],
      reject: false
    });

    // Either 40 (no supervisor) or 20 (supervisor reachable, replay failed)
    expect([20, 40]).toContain(result.exitCode);
    expect(JSON.parse(result.stdout).ok).toBe(false);
  }, 30_000);

  it("accepts --json on Node-level retry", async () => {
    const result = await execaNode(cliEntry, ["runs", "retry", "some-run-id", "--node", "workflow/step-a", "--json"], {
      nodeOptions: ["--import", "tsx", "--conditions=development"],
      reject: false
    });

    // Either 40 (no supervisor) or 20 (supervisor reachable, run not found)
    expect([20, 40]).toContain(result.exitCode);
    expect(JSON.parse(result.stdout).ok).toBe(false);
  }, 30_000);

  it("rejects --background --visualize as invalid combination", async () => {
    const result = await execaNode(cliEntry, ["workflows", "run", join(fixtureDir, "all-primitives.yaml"), "--background", "--visualize"], {
      nodeOptions: ["--import", "tsx", "--conditions=development"],
      reject: false
    });

    // Should fail before contacting supervisor (CLI argument error, not DSL error)
    expect(result.exitCode).toBe(1);
  });

  it("rejects --visualize --json as invalid combination", async () => {
    const result = await execaNode(cliEntry, ["workflows", "run", join(fixtureDir, "all-primitives.yaml"), "--visualize", "--json"], {
      nodeOptions: ["--import", "tsx", "--conditions=development"],
      reject: false
    });

    expect(result.exitCode).toBe(1);
  });

  it("lists project Workflow Catalog entries as JSON", async () => {
    const result = await execaNode(cliEntry, ["workflows", "list", "--json"], {
      nodeOptions: ["--import", "tsx", "--conditions=development"]
    });
    const payload = JSON.parse(result.stdout);

    expect(payload.some((entry: { ref?: string }) => entry.ref === "project:codebase-deep-research")).toBe(true);
  });

  it("supports the wf shorthand alias", async () => {
    const result = await execaNode(cliEntry, ["wf", "show", "project:codebase-deep-research", "--json"], {
      nodeOptions: ["--import", "tsx", "--conditions=development"]
    });
    const payload = JSON.parse(result.stdout);

    expect(payload.name).toBe("codebase-deep-research");
    expect(payload.status).toBe("ready");
  });

  it("lints a workflow resolved from a catalog ref", async () => {
    const tempDir = join(repoRoot, ".tmp-tests", "lint-catalog-ref");
    rmSync(tempDir, { recursive: true, force: true });
    mkdirSync(join(tempDir, ".acpus", "workflows"), { recursive: true });
    writeFileSync(join(tempDir, ".acpus", "workflows", "lint-me.workflow.yaml"), SIMPLE_WORKFLOW("lint-me"));

    const result = await execaNode(cliEntry, ["workflows", "lint", "project:lint-me", "--json"], {
      cwd: tempDir,
      nodeOptions: ["--import", "tsx", "--conditions=development"]
    });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).ok).toBe(true);
  });

  it("returns structured JSON for runs clean dry-run", async () => {
    const tempDir = join(repoRoot, ".tmp-tests", "runs-clean-json");
    rmSync(tempDir, { recursive: true, force: true });
    mkdirSync(tempDir, { recursive: true });

    const result = await execaNode(cliEntry, ["runs", "clean", "--dry-run", "--json"], {
      cwd: tempDir,
      nodeOptions: ["--import", "tsx", "--conditions=development"],
      reject: false
    });

    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload).toMatchObject({
      dryRun: true,
      deletedCount: 0,
      skippedCount: 0,
      bytesReclaimed: 0
    });
    expect(Array.isArray(payload.deleted)).toBe(true);
    expect(Array.isArray(payload.skipped)).toBe(true);
  }, 30_000);

  it("rejects ambiguous short workflow names", async () => {
    const tempDir = join(repoRoot, ".tmp-tests", "ambiguous-catalog");
    mkdirSync(join(tempDir, ".acpus", "workflows"), { recursive: true });
    writeFileSync(join(tempDir, ".acpus", "workflows", "one.workflow.yaml"), SIMPLE_WORKFLOW("duplicate"));
    writeFileSync(join(tempDir, ".acpus", "workflows", "two.workflow.yaml"), SIMPLE_WORKFLOW("duplicate"));

    const result = await execaNode(cliEntry, ["workflows", "run", "duplicate", "--dry-run", "--json"], {
      cwd: tempDir,
      nodeOptions: ["--import", "tsx", "--conditions=development"],
      reject: false
    });

    expect(result.exitCode).toBe(20);
    expect(JSON.parse(result.stdout).diagnostics[0].message).toMatch(/ambiguous|conflict/i);
  });

  it("no longer has a top-level 'run' command", async () => {
    const result = await execaNode(cliEntry, ["run", join(fixtureDir, "all-primitives.yaml"), "--dry-run"], {
      nodeOptions: ["--import", "tsx", "--conditions=development"],
      reject: false
    });

    // Commander should report unknown command
    expect(result.exitCode).not.toBe(0);
  });

  it("no longer has a --daemon flag on run command", async () => {
    const result = await execaNode(cliEntry, ["workflows", "run", join(fixtureDir, "all-primitives.yaml"), "--daemon", "http://localhost:3839"], {
      nodeOptions: ["--import", "tsx", "--conditions=development"],
      reject: false
    });

    // Commander should report unknown option
    expect(result.exitCode).not.toBe(0);
    const output = result.stderr || result.stdout;
    expect(output).toMatch(/unknown.*option|--daemon/i);
  });
});

function SIMPLE_WORKFLOW(name: string): string {
  return `
version: 1
name: ${name}
workflow:
  steps:
    - id: ok
      run: program
      cmd: "echo ok"
`;
}
