import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const runReal = process.env.RUN_REAL_ACPX_E2E === "1";

function realReadAgent(): string {
  return process.env.ACPX_REAL_READONLY_AGENT ?? process.env.ACPX_REAL_AGENT ?? "aiden";
}

function realEditAgent(): string {
  return process.env.ACPX_REAL_EDIT_AGENT ?? process.env.ACPX_REAL_AGENT ?? "trae";
}

function findAcpxOrThrow(): string {
  try {
    return execFileSync("zsh", ["-lc", "command -v acpx"], { encoding: "utf8" }).trim();
  } catch {
    throw new Error("RUN_REAL_ACPX_E2E=1 requires acpx on PATH");
  }
}

describe.skipIf(!runReal)("real acpx agents e2e", () => {
  it("reaches a blocked terminal state through the CLI without invoking an agent", async () => {
    const acpx = findAcpxOrThrow();
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-workflow-orchestrator-real-contract-"));
    await fs.writeFile(path.join(cwd, "sample.txt"), "hello\n", "utf8");
    const specPath = path.join(cwd, "workflow.spec.json");
    await fs.writeFile(specPath, JSON.stringify({
      schemaVersion: "acpx-workflow-orchestrator.workflow/v1",
      name: "real-deterministic-contract",
      root: "discover",
      inputs: {
        cwd: { type: "path", default: cwd }
      },
      roles: {},
      limits: { maxAgents: 2, maxConcurrency: 1, maxFanoutItems: 1, maxFixRounds: 0, stageTimeoutMinutes: 1 },
      stages: [
        { id: "discover", kind: "discover", method: "glob", args: { scope: ["**/*.txt"] }, output: "files" },
        {
          id: "decide",
          kind: "decisionGate",
          mode: "program",
          dependsOn: ["discover"],
          rules: [{ when: { source: "outputs.discover.files", op: "exists" }, to: "blocked" }],
          default: "blocked"
        },
        { id: "gate", kind: "gate", dependsOn: ["decide"] }
      ]
    }, null, 2), "utf8");

    const raw = runCli(cwd, acpx, ["run", "--spec", specPath, "--yes", "--wait", "--json"], 2 * 60 * 1000);
    const result = JSON.parse(raw);
    expect(result.status).toBe("blocked");
    expect(result.runView.status).toBe("blocked");
    await expect(fs.stat(path.join(result.runDir, "outputs", "discover.json"))).resolves.toBeTruthy();
    await expect(fs.stat(path.join(result.runDir, "attempts"))).resolves.toBeTruthy();
  }, 3 * 60 * 1000);

  it("runs a small code task through a configured real ACP agent", async () => {
    const acpx = findAcpxOrThrow();
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-workflow-orchestrator-real-"));
    await fs.mkdir(path.join(cwd, "src"));
    await fs.writeFile(path.join(cwd, "src", "status.txt"), "initial\n", "utf8");
    const specPath = path.join(cwd, "workflow.spec.json");
    const inputPath = path.join(cwd, "input.json");
    await fs.writeFile(specPath, JSON.stringify({
      schemaVersion: "acpx-workflow-orchestrator.workflow/v1",
      name: "real-small-code-task",
      root: "implement",
      inputs: {
        task: { type: "string", default: "" },
        cwd: { type: "path", default: cwd }
      },
      roles: {
        implementer: { category: "implementation", agent: realEditAgent(), mode: "edit" }
      },
      limits: { maxAgents: 4, maxConcurrency: 1, maxFanoutItems: 1, maxFixRounds: 0, stageTimeoutMinutes: 10 },
      stages: [
        {
          id: "implement",
          kind: "agentTask",
          role: "implementer",
          variables: [{ name: "task", source: "input.task" }],
          prompt: [
            "In the current working directory, complete this task:",
            "${task}",
            "",
            "Do the file edit directly. Keep the final response brief and finish with the required final JSON object."
          ].join("\n")
        },
        {
          id: "gate",
          kind: "gate",
          dependsOn: ["implement"]
        }
      ]
    }, null, 2), "utf8");
    await fs.writeFile(inputPath, JSON.stringify({
      cwd,
      task: "Edit src/status.txt so it contains exactly one line: done"
    }, null, 2), "utf8");

    const raw = runCli(cwd, acpx, ["run", "--spec", specPath, "--input-json", inputPath, "--yes", "--wait", "--json"], 20 * 60 * 1000);
    const result = JSON.parse(raw);
    expect(result.status).toBe("completed");
    expect((await fs.readFile(path.join(cwd, "src", "status.txt"), "utf8")).trim()).toBe("done");
    await expect(fs.stat(path.join(result.runDir, "attempts", "implement", "attempt-1", "raw.txt"))).resolves.toBeTruthy();
    await expect(fs.stat(path.join(result.runDir, "outputs", "gate.json"))).resolves.toBeTruthy();
  }, 25 * 60 * 1000);
});

function runCli(cwd: string, acpx: string, args: string[], timeout: number): string {
  return execFileSync(tsxPath(), [cliPath(), ...args], {
    cwd,
    encoding: "utf8",
    timeout,
    env: { ...process.env, PATH: `${path.dirname(acpx)}:${process.env.PATH ?? ""}` }
  });
}

function cliPath(): string {
  return path.resolve(__dirname, "..", "..", "..", "src", "cli.ts");
}

function tsxPath(): string {
  return path.resolve(__dirname, "..", "..", "..", "node_modules", ".bin", "tsx");
}
