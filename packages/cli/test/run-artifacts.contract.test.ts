import { Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ArtifactRecord, RunInspectionTargetArtifactsDocument } from "@acpus/runtime";
import * as Effect from "effect/Effect";
import { createRunsCommand } from "../src/runs/command.js";
import { runCli } from "../src/program.js";
import { CaptureStream } from "./support/capture-stream.js";

const runtime = vi.hoisted(() => ({
  inspectTargetArtifacts: vi.fn(),
  listArtifacts: vi.fn(),
  resolveArtifact: vi.fn(),
}));

vi.mock("@acpus/runtime", async importOriginal => ({
  ...await importOriginal<typeof import("@acpus/runtime")>(),
  inspectTargetArtifacts: runtime.inspectTargetArtifacts,
  listArtifacts: runtime.listArtifacts,
  resolveArtifact: runtime.resolveArtifact,
}));

const artifacts: ArtifactRecord[] = [{
  id: "artifact_1",
  runId: "run_1",
  nodeKey: "review~1a2b3c4d",
  attempt: 1,
  mediaType: "application/json",
  digest: "sha256:abc",
  size: 42,
  path: "/home/user/.acpus/workspaces/0123456789abcdef0123456789abcdef/runtime/runs/run_1/artifacts/review~1a2b3c4d/attempt-1/agent/turn-001.json",
}];
const resolvedArtifact = {
  ...artifacts[0]!,
  uri: "artifact://run_1/artifact_1",
};

describe("runs artifacts", () => {
  beforeEach(() => {
    runtime.listArtifacts.mockReset().mockReturnValue(okList(artifacts));
    runtime.inspectTargetArtifacts.mockReset().mockReturnValue(okTarget(artifacts));
    runtime.resolveArtifact.mockReset().mockReturnValue(okArtifact(resolvedArtifact));
  });

  it("lists all artifact metadata as id, media type, and absolute path", async () => {
    const result = await runCommand(["artifacts", "run_1"]);

    expect(result).toEqual({
      exitCode: 0,
      stderr: "",
      stdout: `artifact_1 application/json ${artifacts[0]!.path}\n`,
    });
    expect(runtime.listArtifacts).toHaveBeenCalledWith("/workspace", "run_1");
    expect(runtime.inspectTargetArtifacts).not.toHaveBeenCalled();
  });

  it("reuses target inspection for static, dynamic, frame, and attempt targets", async () => {
    const result = await runCommand(["artifacts", "run_1", "--target", "attempt_1"]);

    expect(runtime.inspectTargetArtifacts).toHaveBeenCalledWith("/workspace", {
      runId: "run_1",
      target: "attempt_1",
    });
    expect(result.stdout).toBe(`artifact_1 application/json ${artifacts[0]!.path}\n`);
    expect(runtime.listArtifacts).not.toHaveBeenCalled();
  });

  it("prints a successful empty result", async () => {
    runtime.listArtifacts.mockReturnValue(okList([]));

    await expect(runCommand(["artifacts", "run_1"])).resolves.toEqual({
      exitCode: 0,
      stdout: "No artifacts.\n",
      stderr: "",
    });
  });

  it("reports missing runs as text", async () => {
    runtime.listArtifacts.mockReturnValue(okList(undefined));
    const stdout = new CaptureStream();
    const stderr = new CaptureStream();
    expect(await runCli(["runs", "artifacts", "missing"], {
      cwd: "/workspace",
      stdout,
      stderr,
    })).toBe(1);
    expect(stdout.text).toBe("");
    expect(stderr.text).toContain("Run 'missing' was not found.");
    expect(stderr.text).toContain("Error code: RUN_NOT_FOUND");
  });

  it("reports missing targets through inspect errors", async () => {
    runtime.inspectTargetArtifacts.mockReturnValue(Effect.fail({
      type: "target-not-found", runId: "run_1", target: "missing", message: "Run target 'missing' was not found.",
    }));
    await expect(runCommand(["artifacts", "run_1", "--target", "missing"])).rejects.toMatchObject({
      exitCode: 1,
      result: { phase: "inspect", errorCode: "TARGET_NOT_FOUND" },
    });
  });

  it.each([
    ["runtime-store-repair-required", "RUNTIME_STORE_REPAIR_REQUIRED", "acpus doctor --fix"],
    ["runtime-store-unsupported", "RUNTIME_STORE_UNSUPPORTED", "acpus doctor"],
  ])("maps %s while listing artifacts", async (type, errorCode, recovery) => {
    runtime.listArtifacts.mockReturnValue(runtimeReadFailure(type));
    const stdout = new CaptureStream();
    const stderr = new CaptureStream();

    expect(await runCli(["runs", "artifacts", "run_1"], {
      cwd: "/workspace",
      stdout,
      stderr,
    })).toBe(1);
    expect(stdout.text).toBe("");
    expect(stderr.text).toContain(`Error code: ${errorCode}`);
    expect(stderr.text).toContain(recovery);
  });
});

describe("runs artifact", () => {
  beforeEach(() => {
    runtime.resolveArtifact.mockReset().mockReturnValue(okArtifact(resolvedArtifact));
  });

  it("locates one verified local source without reading its body", async () => {
    const result = await runCommand(["artifact", resolvedArtifact.uri]);

    expect(result).toEqual({
      exitCode: 0,
      stderr: "",
      stdout: [
        `Path: ${resolvedArtifact.path}`,
        `Media-Type: ${resolvedArtifact.mediaType}`,
        `Size: ${resolvedArtifact.size} bytes`,
        `Digest: ${resolvedArtifact.digest}`,
        `Source: review attempt ${resolvedArtifact.attempt}`,
        "",
      ].join("\n"),
    });
    expect(runtime.resolveArtifact).toHaveBeenCalledWith("/workspace", resolvedArtifact.uri);
    expect(result.stdout).not.toContain("artifact body contents");
  });

  it("uses a text placeholder for an absent media type", async () => {
    const { mediaType: _mediaType, ...withoutMediaType } = resolvedArtifact;
    runtime.resolveArtifact.mockReturnValue(okArtifact(withoutMediaType));

    expect((await runCommand(["artifact", withoutMediaType.uri])).stdout).toContain("Media-Type: -\n");
  });

  it.each([
    ["invalid-artifact-ref", "usage", 2, undefined],
    ["artifact-not-found", "inspect", 1, "ARTIFACT_NOT_FOUND"],
    ["artifact-path-invalid", "inspect", 1, "ARTIFACT_PATH_INVALID"],
    ["runtime-store-repair-required", "inspect", 1, "RUNTIME_STORE_REPAIR_REQUIRED"],
    ["runtime-store-unsupported", "inspect", 1, "RUNTIME_STORE_UNSUPPORTED"],
  ])("maps %s failures to text errors", async (type, _phase, exitCode, errorCode) => {
    runtime.resolveArtifact.mockReturnValue(errArtifact(type));
    const stdout = new CaptureStream();
    const stderr = new CaptureStream();

    expect(await runCli(["runs", "artifact", resolvedArtifact.uri], {
      cwd: "/workspace",
      stdout,
      stderr,
    })).toBe(exitCode);
    expect(stdout.text).toBe("");
    expect(stderr.text).toContain("Artifact lookup failed.");
    if (errorCode !== undefined) expect(stderr.text).toContain(`Error code: ${errorCode}`);
  });
});

async function runCommand(argv: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
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
  await command.parseAsync(argv, { from: "user" });
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
  return Effect.succeed(document);
}

function okArtifact(value: typeof resolvedArtifact | Omit<typeof resolvedArtifact, "mediaType">) {
  return Effect.succeed(value);
}

function okList(value: ArtifactRecord[] | undefined) {
  return Effect.succeed(value);
}

function errArtifact(type: string) {
  return Effect.fail({
    type,
    runId: "run_1",
    artifactId: "artifact_1",
    message: "Artifact lookup failed.",
  });
}

function runtimeReadFailure(type: string) {
  return Effect.fail({
    type,
    message: "Runtime store cannot be read.",
    path: "/workspace/.acpus/runtime.sqlite",
  });
}
