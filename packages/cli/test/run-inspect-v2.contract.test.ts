import { Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  RunInspectionError,
  RunInspectionTargetSummaryDocument,
  RunInspectionTimelineDocument,
} from "@acpus/runtime";
import { createRunsCommand } from "../src/commands/runs.js";
import { runCli } from "../src/program.js";
import { CaptureStream } from "./support/capture-stream.js";

const runtime = vi.hoisted(() => ({
  getRunInspection: vi.fn(),
  followRunInspection: vi.fn(),
}));

vi.mock("@acpus/runtime", async importOriginal => ({
  ...await importOriginal<typeof import("@acpus/runtime")>(),
  getRunInspection: runtime.getRunInspection,
  followRunInspection: runtime.followRunInspection,
}));

describe("runs inspect v2", () => {
  beforeEach(() => {
    runtime.getRunInspection.mockReset();
    runtime.followRunInspection.mockReset();
  });

  it("passes Timeline pagination opaquely to Runtime", async () => {
    runtime.getRunInspection.mockResolvedValue(ok(timeline()));

    const result = await runCommand([
      "inspect",
      "run_1",
      "--target",
      "review~abc",
      "--timeline",
      "--limit",
      "24",
      "--before",
      "opaque-page",
      "--json",
    ]);

    expect(result.exitCode).toBe(0);
    expect(runtime.getRunInspection).toHaveBeenCalledWith("/workspace", {
      runId: "run_1",
      mode: "timeline",
      target: "review~abc",
      page: { limit: 24, before: "opaque-page" },
    });
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      phase: "inspect",
      schemaVersion: 2,
      kind: "timeline",
    });
  });

  it("starts follow without a cross-connection cursor", async () => {
    runtime.followRunInspection.mockImplementation(async function* () {
      yield ok({
        schemaVersion: 2,
        kind: "snapshot",
        document: timeline(),
      });
      yield ok({
        schemaVersion: 2,
        kind: "done",
        run: { id: "run_1", status: "completed" },
      });
    });

    const result = await runCommand([
      "inspect",
      "run_1",
      "--target",
      "attempt_1",
      "--timeline",
      "--follow",
      "--json",
    ]);

    expect(result.exitCode).toBe(0);
    expect(runtime.getRunInspection).not.toHaveBeenCalled();
    expect(runtime.followRunInspection).toHaveBeenCalledWith("/workspace", expect.objectContaining({
      runId: "run_1",
      mode: "timeline",
      target: "attempt_1",
      intervalMs: 3_000,
      signal: expect.any(AbortSignal),
    }));
    expect(runtime.followRunInspection.mock.calls[0]?.[1]).not.toHaveProperty("after");
    expect(JSON.parse(result.stdout.split("\n")[0]!)).toMatchObject({
      kind: "snapshot",
      document: { kind: "timeline" },
    });
  });

  it("emits the target Decision Summary without private bodies", async () => {
    runtime.getRunInspection.mockResolvedValue(ok(summary()));

    const result = await runCommand([
      "inspect",
      "run_1",
      "--target",
      "attempt_1",
      "--json",
    ]);

    const output = JSON.parse(result.stdout);
    expect(output).toMatchObject({
      schemaVersion: 2,
      kind: "target",
      subject: { attemptId: "attempt_1" },
      evidence: {
        directory: "/private/evidence/agents/attempt_1",
        records: [{ prompt: { kind: "task", bytes: 30, digest: "sha256:prompt" } }],
      },
    });
    expect(output).not.toHaveProperty("instances");
    expect(result.stdout).not.toContain("<steering>");
    expect(result.stdout).not.toContain("operator correction");
    expect(result.stdout).not.toContain("steerId");
  });

  it("bounds adversarial multibyte target text to 1.5 KiB without splitting UTF-8", async () => {
    const document = summary();
    const multibyte = "界".repeat(2_000);
    document.run.id = multibyte;
    document.subject = {
      ...document.subject,
      id: multibyte,
      label: multibyte,
      kind: multibyte,
      attemptId: multibyte,
    };
    document.availableActions = [
      { kind: "inspect-timeline", target: multibyte },
      { kind: "steer", target: multibyte },
    ];
    document.evidence = {
      ...document.evidence!,
      directory: `/${multibyte}`,
      records: [{
        ...document.evidence!.records[0]!,
        file: multibyte,
        prompt: {
          ...document.evidence!.records[0]!.prompt,
          digest: multibyte,
        },
      }],
    };
    runtime.getRunInspection.mockResolvedValue(ok(document));

    const result = await runCommand(["inspect", "run_1", "--target", "attempt_1"]);

    expect(result.exitCode).toBe(0);
    expect(Buffer.byteLength(result.stdout, "utf8")).toBeLessThanOrEqual(1_536);
    expect(result.stdout).not.toContain("\ufffd");
  });

  it.each([
    {
      name: "ambiguous target candidates",
      error: {
        type: "target-ambiguous",
        runId: "run_1",
        target: "review",
        candidateKeys: ["review~alpha", "review~beta"],
        message: "Target is ambiguous.",
      } satisfies RunInspectionError,
      expectedCode: "TARGET_AMBIGUOUS",
      expected: {
        type: "target-ambiguous",
        runId: "run_1",
        target: "review",
        candidateKeys: ["review~alpha", "review~beta"],
      },
    },
    {
      name: "invalid Timeline cursor identity",
      error: {
        type: "invalid-cursor",
        runId: "run_1",
        target: "review~alpha",
        message: "Cursor does not belong to this target.",
      } satisfies RunInspectionError,
      expectedCode: "INVALID_CURSOR",
      expected: {
        type: "invalid-cursor",
        runId: "run_1",
        target: "review~alpha",
      },
    },
  ])("preserves $name in sanitized one-shot JSON", async ({ error, expectedCode, expected }) => {
    runtime.getRunInspection.mockResolvedValue(err(error));

    const result = await runCliCommand([
      "runs",
      "inspect",
      "run_1",
      "--target",
      "review",
      "--timeline",
      "--json",
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({
      schemaVersion: 1,
      ok: false,
      phase: "inspect",
      errorCode: expectedCode,
      inspectionError: expected,
    });
    expect(JSON.parse(result.stdout).inspectionError).not.toHaveProperty("cause");
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

async function runCliCommand(argv: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const stdout = new CaptureStream();
  const stderr = new CaptureStream();
  const exitCode = await runCli(argv, {
    cwd: "/workspace",
    stdin: Readable.from([]),
    stdout,
    stderr,
  });
  return { exitCode, stdout: stdout.text, stderr: stderr.text };
}

function timeline(): RunInspectionTimelineDocument {
  return {
    schemaVersion: 2,
    kind: "timeline",
    run: { id: "run_1", status: "running", updatedAt: "2026-07-25T00:00:00.000Z" },
    subject: {
      targetKind: "dynamic-node",
      id: "review~abc",
      label: "review",
      kind: "agent",
      nodeId: "review",
      nodeKey: "review~abc",
    },
    state: { status: "running" },
    recent: { entries: [], returned: 0, omittedBefore: 0, hasOlder: false },
  };
}

function summary(): RunInspectionTargetSummaryDocument {
  return {
    schemaVersion: 2,
    kind: "target",
    run: { id: "run_1", status: "running", updatedAt: "2026-07-25T00:00:00.000Z" },
    subject: {
      targetKind: "attempt",
      id: "attempt_1",
      label: "review",
      kind: "agent",
      nodeId: "review",
      nodeKey: "review~abc",
      attemptId: "attempt_1",
      attemptNo: 1,
    },
    state: { status: "running" },
    availableActions: [
      { kind: "inspect-timeline", target: "attempt_1" },
      { kind: "steer", target: "attempt_1" },
    ],
    evidence: {
      directory: "/private/evidence/agents/attempt_1",
      state: "recording",
      completeness: "complete",
      turnCount: 1,
      omittedTurns: 0,
      gapCount: 0,
      schedulerDisposition: "pending",
      records: [{
        turn: 1,
        file: "turn-001.evidence.jsonl.partial",
        prompt: { kind: "task", bytes: 30, digest: "sha256:prompt" },
        lastDurableResponseBytes: 12,
        trace: {
          state: "recording",
          file: "turn-001.trace.jsonl.partial",
          bytes: 128,
          digest: "sha256:trace",
        },
      }],
    },
  };
}

function ok<T>(value: T) {
  return {
    value,
    isOk: () => true as const,
    isErr: () => false as const,
  };
}

function err(error: RunInspectionError) {
  return {
    error,
    isOk: () => false as const,
    isErr: () => true as const,
  };
}
