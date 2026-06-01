import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { beforeAll, describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const tsxBin = path.join(root, "node_modules", ".bin", "tsx");
const cli = path.join(root, "src", "cli.ts");

describe("CLI lifecycle", () => {
  beforeAll(async () => {
    await execa("npm", ["run", "build"], { cwd: root });
  }, 60_000);

  it("validates, saves, runs, observes, diagnoses, resumes, reports, and generates drafts", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-cli-lifecycle-"));
    await fs.writeFile(path.join(cwd, "sample.txt"), "hello\n", "utf8");
    const specPath = path.join(cwd, "deterministic.workflow.spec.json");
    await fs.writeFile(specPath, `${JSON.stringify(deterministicSpec(cwd), null, 2)}\n`, "utf8");

    const validate = JSON.parse((await run(cwd, "validate", "--spec", specPath, "--json")).stdout) as { ok: boolean };
    const preview = JSON.parse((await run(cwd, "preview", "--spec", specPath, "--json")).stdout) as { workflowName: string; status: string };
    const save = JSON.parse((await run(cwd, "save", "deterministic", "--spec", specPath, "--json")).stdout) as { ok: boolean; workflow: string };
    const workflows = JSON.parse((await run(cwd, "list", "workflows", "--json")).stdout) as { entries: string[] };
    const saved = JSON.parse((await run(cwd, "show", "workflow", "deterministic", "--json")).stdout) as { name: string };
    const generated = JSON.parse((await run(cwd, "generate", "--name", "generated", "--json")).stdout) as { ok: boolean; path: string };
    const drafts = JSON.parse((await run(cwd, "list", "drafts", "--json")).stdout) as { entries: string[] };
    const draft = JSON.parse((await run(cwd, "show", "draft", path.basename(generated.path), "--json")).stdout) as { name: string };
    const runResult = JSON.parse((await run(cwd, "run", "--workflow", "deterministic", "--yes", "--wait", "--json")).stdout) as { logicalRunId: string; status: string };
    const follow = JSON.parse((await run(cwd, "follow", runResult.logicalRunId, "--json")).stdout) as { status: string };
    const diagnose = JSON.parse((await run(cwd, "diagnose", runResult.logicalRunId, "--wait", "--json")).stdout) as { status: string };
    const report = JSON.parse((await run(cwd, "report", "--run", runResult.logicalRunId, "--json", "--detailed")).stdout) as { run: { status: string }; diagnostics: unknown[] };
    const resume = JSON.parse((await run(cwd, "resume", runResult.logicalRunId, "--wait", "--json")).stdout) as { status: string };
    const shownRun = JSON.parse((await run(cwd, "show", "run", runResult.logicalRunId, "--json")).stdout) as { logicalRunId: string };
    const runs = JSON.parse((await run(cwd, "list", "runs", "--json")).stdout) as { entries: string[] };

    expect(validate.ok).toBe(true);
    expect(preview).toMatchObject({ workflowName: "deterministic-cli", status: "pending" });
    expect(save).toMatchObject({ ok: true, workflow: "deterministic" });
    expect(workflows.entries).toContain("deterministic");
    expect(saved.name).toBe("deterministic-cli");
    expect(generated.ok).toBe(true);
    expect(drafts.entries).toContain(path.basename(generated.path));
    expect(draft.name).toBe("generated");
    expect(runResult.status).toBe("blocked");
    expect(follow.status).toBe("blocked");
    expect(diagnose.status).toBe("diagnosed_blocked");
    expect(report.run.status).toBe("diagnosed_blocked");
    expect(report.diagnostics.length).toBeGreaterThan(0);
    expect(resume.status).toBe("blocked");
    expect(shownRun.logicalRunId).toBe(runResult.logicalRunId);
    expect(runs.entries).toContain(runResult.logicalRunId);
  }, 60_000);
});

async function run(cwd: string, ...args: string[]) {
  return execa(tsxBin, [cli, ...args], { cwd });
}

function deterministicSpec(cwd: string) {
  return {
    schemaVersion: "acpx-workflow-orchestrator.workflow/v1",
    name: "deterministic-cli",
    description: "No-agent CLI lifecycle workflow.",
    root: "discover",
    inputs: {
      cwd: { type: "path", default: cwd }
    },
    roles: {},
    limits: { maxAgents: 1, maxConcurrency: 1, maxFanoutItems: 1, maxFixRounds: 0, stageTimeoutMinutes: 1 },
    stages: [
      { id: "discover", kind: "discover", method: "glob", args: { scope: ["*.txt"] }, output: "files" },
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
  };
}
