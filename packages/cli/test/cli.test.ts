import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execaNode } from "execa";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const cliEntry = join(repoRoot, "packages/cli/src/index.ts");
const fixtureDir = join(repoRoot, "packages/core/test/fixtures");

describe("acpus CLI", () => {
  it("lints a valid workflow as JSON", async () => {
    const result = await execaNode(cliEntry, ["lint", join(fixtureDir, "all-primitives.yaml"), "--json"], {
      nodeOptions: ["--import", "tsx", "--conditions=development"]
    });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).ok).toBe(true);
  });

  it("returns exit code 10 for static lint errors", async () => {
    const result = await execaNode(cliEntry, ["lint", join(fixtureDir, "invalid-reference.yaml"), "--json"], {
      nodeOptions: ["--import", "tsx", "--conditions=development"],
      reject: false
    });

    expect(result.exitCode).toBe(10);
    expect(JSON.parse(result.stdout).diagnostics[0].severity).toBe("error");
  });

  it("promotes warnings to errors with --strict", async () => {
    // Use the all-primitives fixture which has no warnings; create a minimal spec with a fanout missing key
    const tempDir = join(repoRoot, ".tmp-tests");
    mkdirSync(tempDir, { recursive: true });
    const specPath = join(tempDir, "strict-test.yaml");
    writeFileSync(specPath, `
version: 1
name: strict-test
agents:
  mock: { type: mock }
workflow:
  steps:
    - id: mapped
      fanout:
        over: [1, 2, 3]
        join: all
        do:
          - id: each
            run: program
            cmd: ["echo", "hi"]
outputs:
  result: \${{ steps.mapped.output }}
`);

    const lenient = await execaNode(cliEntry, ["lint", specPath, "--json"], {
      nodeOptions: ["--import", "tsx", "--conditions=development"]
    });
    const strict = await execaNode(cliEntry, ["lint", specPath, "--strict", "--json"], {
      nodeOptions: ["--import", "tsx", "--conditions=development"],
      reject: false
    });

    expect(lenient.exitCode).toBe(0);
    expect(JSON.parse(lenient.stdout).ok).toBe(true);
    expect(strict.exitCode).toBe(10);
    expect(JSON.parse(strict.stdout).ok).toBe(false);
  });

  it("prints dry-run diagnostics, IR, and schedule", async () => {
    const result = await execaNode(cliEntry, ["run", join(fixtureDir, "all-primitives.yaml"), "--dry-run", "--json"], {
      nodeOptions: ["--import", "tsx", "--conditions=development"]
    });
    const payload = JSON.parse(result.stdout);

    expect(payload.ok).toBe(true);
    expect(payload.ir.name).toBe("all-primitives");
    expect(payload.schedule.nodes).toHaveLength(8);
  });

  it("accepts input from a JSON file in dry-run mode", async () => {
    const tempDir = join(repoRoot, ".tmp-tests");
    mkdirSync(tempDir, { recursive: true });
    const inputPath = join(tempDir, "input.json");
    writeFileSync(inputPath, JSON.stringify({ files: ["a.ts"] }));

    const result = await execaNode(cliEntry, ["run", join(fixtureDir, "all-primitives.yaml"), "--dry-run", "--json", "--input", inputPath], {
      nodeOptions: ["--import", "tsx", "--conditions=development"]
    });
    const payload = JSON.parse(result.stdout);

    expect(payload.ir.runtimeInput).toEqual({ files: ["a.ts"] });
  });

  it("accepts inline JSON via --input in dry-run mode", async () => {
    const result = await execaNode(cliEntry, [
      "run", join(fixtureDir, "all-primitives.yaml"),
      "--dry-run", "--json", "--input", '{"files":["inline.ts"]}'
    ], {
      nodeOptions: ["--import", "tsx", "--conditions=development"]
    });
    const payload = JSON.parse(result.stdout);

    expect(payload.ok).toBe(true);
    expect(payload.ir.runtimeInput).toEqual({ files: ["inline.ts"] });
  });

  it("rejects non-dry-run execution in M1", async () => {
    const result = await execaNode(cliEntry, ["run", join(fixtureDir, "all-primitives.yaml"), "--json"], {
      nodeOptions: ["--import", "tsx", "--conditions=development"],
      reject: false
    });

    expect(result.exitCode).toBe(20);
    expect(JSON.parse(result.stdout).diagnostics[0].message).toContain("not implemented");
  });
});
