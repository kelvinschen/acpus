import { Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ArtifactRecord, RunInspectionTargetArtifactsDocument } from "@acpus/runtime";
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
  nodeKey: "review~abc",
  attempt: 1,
  mediaType: "application/json",
  digest: "sha256:abc",
  size: 42,
  path: "/home/user/.acpus/workspaces/0123456789abcdef0123456789abcdef/runtime/runs/run_1/artifacts/review~abc/attempt-1/agent/turn-001.json",
}];
const resolvedArtifact = {
  ...artifacts[0]!,
  uri: "artifact://run_1/artifact_1",
};

describe("runs artifacts", () => {
  beforeEach(() => {
    runtime.listArtifacts.mockReset().mockResolvedValue(artifacts);
    runtime.inspectTargetArtifacts.mockReset().mockResolvedValue(okTarget(artifacts));
    runtime.resolveArtifact.mockReset().mockResolvedValue(okArtifact(resolvedArtifact));
  });

  it("lists all artifact metadata as id, media type, and absolute path", async () => {
    const result = await runCommand(["artifacts", "run_1"], false);

    expect(result).toEqual({
      exitCode: 0,
      stderr: "",
      stdout: `artifact_1 application/json ${artifacts[0]!.path}\n`,
    });
    expect(runtime.listArtifacts).toHaveBeenCalledWith("/workspace", "run_1");
    expect(runtime.inspectTargetArtifacts).not.toHaveBeenCalled();
  });

  it("emits the stable JSON envelope without reading artifact bodies", async () => {
    const result = await runCommand(["artifacts", "run_1"], true);
    const expected = {
      schemaVersion: 1,
      ok: true,
      phase: "inspect",
      runId: "run_1",
      artifacts,
    };

    expect(JSON.parse(result.stdout)).toEqual(expected);
    expect(result.stdout).toBe(`${JSON.stringify(expected)}\n`);
    expect(result.stderr).toBe("");
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
    expect(JSON.parse((await runCommand(["artifacts", "run_1"], true)).stdout)).toMatchObject({
      ok: true,
      artifacts: [],
    });
  });

  it("reports missing runs through the structured error envelope", async () => {
    runtime.listArtifacts.mockResolvedValue(undefined);
    const stdout = new CaptureStream();
    const stderr = new CaptureStream();
    expect(await runCli(["runs", "artifacts", "missing", "--json"], {
      cwd: "/workspace",
      stdout,
      stderr,
    })).toBe(1);
    expect(JSON.parse(stdout.text)).toMatchObject({
      schemaVersion: 1,
      ok: false,
      phase: "inspect",
      errorCode: "RUN_NOT_FOUND",
    });
    expect(stdout.text).toBe(`${stdout.text.trimEnd()}\n`);
    expect(stdout.text.trimEnd()).not.toContain("\n");
    expect(stderr.text).toBe("");
  });

  it("reports missing targets through inspect errors", async () => {
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

describe("runs artifact", () => {
  beforeEach(() => {
    runtime.resolveArtifact.mockReset().mockResolvedValue(okArtifact(resolvedArtifact));
  });

  it("locates one verified local source without reading its body", async () => {
    const result = await runCommand(["artifact", resolvedArtifact.uri], false);

    expect(result).toEqual({
      exitCode: 0,
      stderr: "",
      stdout: [
        `Path: ${resolvedArtifact.path}`,
        `Media-Type: ${resolvedArtifact.mediaType}`,
        `Size: ${resolvedArtifact.size} bytes`,
        `Digest: ${resolvedArtifact.digest}`,
        `Source: ${resolvedArtifact.nodeKey} attempt ${resolvedArtifact.attempt}`,
        "",
      ].join("\n"),
    });
    expect(runtime.resolveArtifact).toHaveBeenCalledWith("/workspace", resolvedArtifact.uri);
    expect(result.stdout).not.toContain("artifact body contents");
  });

  it("emits the resolved artifact in a stable JSON envelope", async () => {
    const result = await runCommand(["artifact", resolvedArtifact.uri], true);
    const expected = {
      schemaVersion: 1,
      ok: true,
      phase: "inspect",
      artifact: resolvedArtifact,
    };

    expect(result).toEqual({
      exitCode: 0,
      stderr: "",
      stdout: `${JSON.stringify(expected)}\n`,
    });
  });

  it("uses a text placeholder and omits absent media type in JSON", async () => {
    const { mediaType: _mediaType, ...withoutMediaType } = resolvedArtifact;
    runtime.resolveArtifact.mockResolvedValue(okArtifact(withoutMediaType));

    expect((await runCommand(["artifact", withoutMediaType.uri], false)).stdout).toContain("Media-Type: -\n");
    expect(JSON.parse((await runCommand(["artifact", withoutMediaType.uri], true)).stdout).artifact)
      .not.toHaveProperty("mediaType");
  });

  it.each([
    ["invalid-artifact-ref", "usage", 2, undefined],
    ["artifact-not-found", "inspect", 1, "ARTIFACT_NOT_FOUND"],
    ["artifact-path-invalid", "inspect", 1, "ARTIFACT_PATH_INVALID"],
  ])("maps %s failures to quiet JSON", async (type, phase, exitCode, errorCode) => {
    runtime.resolveArtifact.mockResolvedValue(errArtifact(type));
    const stdout = new CaptureStream();
    const stderr = new CaptureStream();

    expect(await runCli(["runs", "artifact", resolvedArtifact.uri, "--json"], {
      cwd: "/workspace",
      stdout,
      stderr,
    })).toBe(exitCode);
    expect(JSON.parse(stdout.text)).toMatchObject({
      schemaVersion: 1,
      ok: false,
      phase,
      ...(errorCode === undefined ? {} : { errorCode }),
    });
    expect(stdout.text).toBe(`${stdout.text.trimEnd()}\n`);
    expect(stderr.text).toBe("");
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

function okArtifact(value: typeof resolvedArtifact | Omit<typeof resolvedArtifact, "mediaType">) {
  return {
    isErr: () => false as const,
    value,
  };
}

function errArtifact(type: string) {
  return {
    isErr: () => true as const,
    error: {
      type,
      runId: "run_1",
      artifactId: "artifact_1",
      message: "Artifact lookup failed.",
    },
  };
}
