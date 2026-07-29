import { Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ArtifactRecord, RunInspectionTargetArtifactsDocument } from "@acpus/runtime";
import { createRunsCommand } from "../src/commands/runs.js";
import { CaptureStream } from "./support/capture-stream.js";

const runtime = vi.hoisted(() => ({
  inspectTargetArtifacts: vi.fn(),
  listArtifacts: vi.fn(),
}));

vi.mock("@acpus/runtime", async importOriginal => ({
  ...await importOriginal<typeof import("@acpus/runtime")>(),
  inspectTargetArtifacts: runtime.inspectTargetArtifacts,
  listArtifacts: runtime.listArtifacts,
}));

const artifacts: ArtifactRecord[] = [{
  id: "artifact_1",
  runId: "run_1",
  nodeKey: "review~abc",
  attempt: 1,
  mediaType: "application/x-ndjson",
  digest: "sha256:abc",
  size: 42,
  path: "/home/user/.acpus/workspaces/0123456789abcdef0123456789abcdef/runtime/runs/run_1/artifacts/review~abc/attempt-1/agent/turn-001.trace.jsonl",
}];

describe("runs artifacts", () => {
  beforeEach(() => {
    runtime.listArtifacts.mockReset().mockResolvedValue(artifacts);
    runtime.inspectTargetArtifacts.mockReset().mockResolvedValue(okTarget(artifacts));
  });

  it("lists all artifact metadata as id, media type, and absolute path", async () => {
    const result = await runCommand(["artifacts", "run_1"], false);

    expect(result).toEqual({
      exitCode: 0,
      stderr: "",
      stdout: `artifact_1 application/x-ndjson ${artifacts[0]!.path}\n`,
    });
    expect(runtime.listArtifacts).toHaveBeenCalledWith("/workspace", "run_1");
    expect(runtime.inspectTargetArtifacts).not.toHaveBeenCalled();
  });

  it("emits the stable JSON envelope without reading artifact bodies", async () => {
    const result = await runCommand(["artifacts", "run_1"], true);

    expect(JSON.parse(result.stdout)).toEqual({
      schemaVersion: 1,
      ok: true,
      phase: "inspect",
      runId: "run_1",
      artifacts,
    });
    expect(result.stdout).not.toContain("artifact body contents");
  });

  it("reuses target inspection for static, dynamic, frame, and attempt targets", async () => {
    const result = await runCommand(["artifacts", "run_1", "--target", "attempt_1"], true);

    expect(runtime.inspectTargetArtifacts).toHaveBeenCalledWith("/workspace", {
      runId: "run_1",
      target: "attempt_1",
    });
    expect(JSON.parse(result.stdout)).toEqual({
      schemaVersion: 1,
      ok: true,
      phase: "inspect",
      runId: "run_1",
      target: "attempt_1",
      artifacts,
    });
    expect(runtime.listArtifacts).not.toHaveBeenCalled();
  });

  it("prints a successful empty result", async () => {
    runtime.listArtifacts.mockResolvedValue([]);

    await expect(runCommand(["artifacts", "run_1"], false)).resolves.toEqual({
      exitCode: 0,
      stdout: "No artifacts.\n",
      stderr: "",
    });
  });

  it("reports missing runs and targets through inspect errors", async () => {
    runtime.listArtifacts.mockResolvedValue(undefined);
    await expect(runCommand(["artifacts", "missing"], true)).rejects.toMatchObject({
      exitCode: 1,
      result: { phase: "inspect", errorCode: "RUN_NOT_FOUND" },
    });

    runtime.inspectTargetArtifacts.mockResolvedValue({
      isErr: () => true,
      error: { type: "target-not-found", runId: "run_1", target: "missing", message: "Run target 'missing' was not found." },
    });
    await expect(runCommand(["artifacts", "run_1", "--target", "missing"], true)).rejects.toMatchObject({
      exitCode: 1,
      result: { phase: "inspect", errorCode: "TARGET_NOT_FOUND" },
    });
  });
});

async function runCommand(argv: string[], json: boolean): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const stdout = new CaptureStream();
  const stderr = new CaptureStream();
  let exitCode = -1;
  const command = createRunsCommand({
    cwd: "/workspace",
    stdin: Readable.from([]),
    stdout,
    stderr,
    setExitCode: code => { exitCode = code; },
  });
  await command.parseAsync([...argv, ...(json ? ["--json"] : [])], { from: "user" });
  return { exitCode, stdout: stdout.text, stderr: stderr.text };
}

function okTarget(value: ArtifactRecord[]) {
  const document: RunInspectionTargetArtifactsDocument = {
    schemaVersion: 2,
    kind: "artifacts",
    run: { id: "run_1", status: "running", updatedAt: "2026-07-25T00:00:00.000Z" },
    subject: {
      targetKind: "attempt",
      id: "@1a2b3c4d5e6f#1",
      ref: "@1a2b3c4d5e6f#1",
      label: "review",
      kind: "agent",
      nodeId: "review",
      attemptNo: 1,
    },
    artifacts: value,
  };
  return {
    isErr: () => false as const,
    value: document,
  };
}
