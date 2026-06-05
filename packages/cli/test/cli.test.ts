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

    expect(payload.ir.runtimeInputs).toEqual({ files: ["a.ts"] });
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
