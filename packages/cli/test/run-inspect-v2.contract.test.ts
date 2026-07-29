import { Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  RunInspectionCandidatesDocument,
  RunInspectionEvidenceCandidatesDocument,
  RunInspectionEvidenceDocument,
  RunInspectionError,
  RunInspectionRaw,
  RunInspectionSnapshot,
  RunInspectionTargetSummaryDocument,
  RunInspectionTimelineDocument,
} from "@acpus/runtime";
import { createRunsCommand } from "../src/commands/runs.js";
import { runCli } from "../src/program.js";
import { CaptureStream } from "./support/capture-stream.js";

const runtime = vi.hoisted(() => ({
  inspectEvidence: vi.fn(),
  inspectRaw: vi.fn(),
  inspectRun: vi.fn(),
  inspectTarget: vi.fn(),
  inspectTimeline: vi.fn(),
  watchInspection: vi.fn(),
}));

vi.mock("@acpus/runtime", async importOriginal => ({
  ...await importOriginal<typeof import("@acpus/runtime")>(),
  inspectEvidence: runtime.inspectEvidence,
  inspectRaw: runtime.inspectRaw,
  inspectRun: runtime.inspectRun,
  inspectTarget: runtime.inspectTarget,
  inspectTimeline: runtime.inspectTimeline,
  watchInspection: runtime.watchInspection,
}));

describe("runs inspect v2", () => {
  beforeEach(() => {
    runtime.inspectEvidence.mockReset();
    runtime.inspectRaw.mockReset();
    runtime.inspectRun.mockReset();
    runtime.inspectTarget.mockReset();
    runtime.inspectTimeline.mockReset();
    runtime.watchInspection.mockReset();
  });

  it("uses the named Run job for overview and topology reads", async () => {
    runtime.inspectRun.mockResolvedValue(ok(snapshot()));

    const overview = await runCommand(["inspect", "run_1", "--json"]);
    expect(overview.exitCode).toBe(0);
    expect(runtime.inspectRun).toHaveBeenLastCalledWith("/workspace", { runId: "run_1" });

    const topology = await runCommand(["inspect", "run_1", "--all", "--controls", "--json"]);
    expect(topology.exitCode).toBe(0);
    expect(runtime.inspectRun).toHaveBeenLastCalledWith("/workspace", {
      runId: "run_1",
      includeAllTopology: true,
      includeControls: true,
    });
    expect(runtime.inspectTarget).not.toHaveBeenCalled();
    expect(runtime.inspectEvidence).not.toHaveBeenCalled();
  });

  it("uses the named Raw job without an ordinary inspection read", async () => {
    runtime.inspectRaw.mockResolvedValue(ok(raw()));

    const result = await runCommand(["inspect", "run_1", "--raw", "--json"]);

    expect(result.exitCode).toBe(0);
    expect(runtime.inspectRaw).toHaveBeenCalledWith("/workspace", { runId: "run_1" });
    expect(runtime.inspectRun).not.toHaveBeenCalled();
    expect(runtime.inspectTarget).not.toHaveBeenCalled();
    expect(runtime.inspectTimeline).not.toHaveBeenCalled();
    expect(runtime.inspectEvidence).not.toHaveBeenCalled();
  });

  it("passes one-based Timeline pages to Runtime", async () => {
    runtime.inspectTimeline.mockResolvedValue(ok(timeline()));

    const result = await runCommand([
      "inspect",
      "run_1",
      "--target",
      "@1a2b3c4d5e6f",
      "--timeline",
      "--limit",
      "24",
      "--page",
      "2",
      "--json",
    ]);

    expect(result.exitCode).toBe(0);
    expect(runtime.inspectTimeline).toHaveBeenCalledWith("/workspace", {
      runId: "run_1",
      target: "@1a2b3c4d5e6f",
      limit: 24,
      page: 2,
    });
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      phase: "inspect",
      kind: "timeline",
    });
    expect(result.stdout.trimEnd().split("\n")).toHaveLength(1);
  });

  it("passes pages to repeated-target candidate inspection", async () => {
    runtime.inspectTarget.mockResolvedValue(ok(candidates()));

    const result = await runCommand([
      "inspect",
      "run_1",
      "--target",
      "review batch",
      "--limit",
      "5",
      "--page",
      "3",
      "--json",
    ]);

    expect(result.exitCode).toBe(0);
    expect(runtime.inspectTarget).toHaveBeenCalledWith("/workspace", {
      runId: "run_1",
      target: "review batch",
      limit: 5,
      page: 3,
    });
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      phase: "inspect",
      kind: "candidates",
    });
    expect(result.stdout.trimEnd().split("\n")).toHaveLength(1);
  });

  it("passes target-scoped topology and explicit controls to Runtime", async () => {
    runtime.inspectTarget.mockResolvedValue(ok(summary()));

    const result = await runCommand([
      "inspect",
      "run_1",
      "--target",
      "@1a2b3c4d5e6f",
      "--all",
      "--controls",
      "--json",
    ]);

    expect(result.exitCode).toBe(0);
    expect(runtime.inspectTarget).toHaveBeenCalledWith("/workspace", {
      runId: "run_1",
      target: "@1a2b3c4d5e6f",
      includeAllTopology: true,
      includeControls: true,
    });
  });

  it("makes Evidence a separate pageable exact-attempt job", async () => {
    runtime.inspectEvidence.mockResolvedValue(ok(evidenceCandidates()));

    const result = await runCommand([
      "inspect",
      "run_1",
      "--target",
      "review",
      "--evidence",
      "--limit",
      "5",
      "--page",
      "3",
      "--json",
    ]);

    expect(result.exitCode).toBe(0);
    expect(runtime.inspectEvidence).toHaveBeenCalledWith("/workspace", {
      runId: "run_1",
      target: "review",
      limit: 5,
      page: 3,
    });
    expect(JSON.parse(result.stdout)).toMatchObject({ kind: "evidence-candidates" });
  });

  it("starts follow without a cross-connection cursor", async () => {
    runtime.watchInspection.mockImplementation(async function* () {
      yield ok({
        schemaVersion: 2,
        kind: "view",
        document: timeline(),
      });
    });

    const result = await runCommand([
      "inspect",
      "run_1",
      "--target",
      "@1a2b3c4d5e6f#1",
      "--timeline",
      "--limit",
      "5",
      "--follow",
      "--json",
    ]);

    expect(result.exitCode).toBe(0);
    expect(runtime.inspectTimeline).not.toHaveBeenCalled();
    expect(runtime.watchInspection).toHaveBeenCalledWith("/workspace", expect.objectContaining({
      view: {
        kind: "timeline",
        runId: "run_1",
        target: "@1a2b3c4d5e6f#1",
        limit: 5,
      },
      signal: expect.any(AbortSignal),
    }));
    expect(runtime.watchInspection.mock.calls[0]?.[1]).not.toHaveProperty("after");
    expect(JSON.parse(result.stdout.split("\n")[0]!)).toMatchObject({
      kind: "view",
      document: { kind: "timeline" },
    });
  });

  it("preserves target-scoped topology in a follow watch", async () => {
    runtime.watchInspection.mockImplementation(async function* () {
      yield ok({ schemaVersion: 2, kind: "view", document: snapshot() });
    });

    const result = await runCommand([
      "inspect",
      "run_1",
      "--target",
      "@1a2b3c4d5e6f",
      "--all",
      "--follow",
      "--json",
    ]);

    expect(result.exitCode).toBe(0);
    expect(runtime.watchInspection).toHaveBeenCalledWith("/workspace", expect.objectContaining({
      view: {
        kind: "target",
        runId: "run_1",
        target: "@1a2b3c4d5e6f",
        includeAllTopology: true,
      },
      signal: expect.any(AbortSignal),
    }));
  });

  it("emits the target Decision Summary without private bodies", async () => {
    runtime.inspectTarget.mockResolvedValue(ok(summary()));

    const result = await runCommand([
      "inspect",
      "run_1",
      "--target",
      "@1a2b3c4d5e6f#1",
      "--json",
    ]);

    const output = JSON.parse(result.stdout);
    expect(output).toMatchObject({
      kind: "target",
      subject: { id: "@1a2b3c4d5e6f#1", ref: "@1a2b3c4d5e6f#1", attemptNo: 1 },
    });
    expect(output).not.toHaveProperty("evidence");
    expect(output).not.toHaveProperty("instances");
    expect(result.stdout).not.toContain("<steering>");
    expect(result.stdout).not.toContain("operator correction");
    expect(result.stdout).not.toContain("steerId");
    expect(result.stdout.trimEnd().split("\n")).toHaveLength(1);
    expect(runtime.inspectEvidence).not.toHaveBeenCalled();
  });

  it("keeps exact operands intact when distinct state exceeds the soft envelope", async () => {
    const document = evidence();
    const multibyte = "界".repeat(2_000);
    document.subject = {
      ...document.subject,
      id: multibyte,
      ref: "@1a2b3c4d5e6f#1",
    };
    document.evidence = {
      ...document.evidence,
      directory: `/${multibyte}`,
      records: {
        ...document.evidence.records,
        entries: [{
          ...document.evidence.records.entries[0]!,
          file: multibyte,
          prompt: {
            ...document.evidence.records.entries[0]!.prompt,
            digest: multibyte,
          },
        }],
      },
    };
    runtime.inspectEvidence.mockResolvedValue(ok(document));

    const result = await runCommand(["inspect", "run_1", "--target", "@1a2b3c4d5e6f#1", "--evidence"]);

    expect(result.exitCode).toBe(0);
    expect(Buffer.byteLength(result.stdout, "utf8")).toBeGreaterThan(1_536);
    expect(result.stdout).toContain(`  Directory: /${multibyte}`);
    expect(result.stdout).toContain(`${multibyte}  prompt=task/30B/${multibyte}`);
    expect(result.stdout).toContain("Evidence review  @1a2b3c4d5e6f#1");
    expect(result.stdout).not.toContain("\ufffd");
  });

  it("returns short candidate refs for an ambiguous exact inspection", async () => {
    const error = {
      type: "target-ambiguous",
      runId: "run_1",
      target: "review",
      candidates: candidates(),
      message: "Target is ambiguous.",
    } satisfies RunInspectionError;
    runtime.inspectTimeline.mockResolvedValue(err(error));

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
      ok: false,
      phase: "inspect",
      errorCode: "TARGET_AMBIGUOUS",
      inspectionError: {
        type: "target-ambiguous",
        runId: "run_1",
        target: "review",
        candidates: {
          kind: "candidates",
          candidates: {
            entries: [
              { ref: "@1a2b3c4d5e6f" },
              { ref: "@6f5e4d3c2b1a" },
            ],
            page: 1,
            total: 2,
          },
        },
      },
    });
    expect(JSON.parse(result.stdout).inspectionError).not.toHaveProperty("cause");
  });

  it("prints the same candidate page for an ambiguous exact text inspection", async () => {
    const error = {
      type: "target-ambiguous",
      runId: "run_1",
      target: "review",
      candidates: candidates(),
      message: "Target is ambiguous.",
    } satisfies RunInspectionError;
    runtime.inspectTimeline.mockResolvedValue(err(error));

    const result = await runCliCommand([
      "runs",
      "inspect",
      "run_1",
      "--target",
      "review",
      "--timeline",
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Target review  matches=2");
    expect(result.stderr).toContain("@1a2b3c4d5e6f");
    expect(result.stderr).toContain("Select: acpus runs inspect run_1 --target @ref --timeline");
    expect(result.stderr).not.toContain("Next:");
    expect(result.stderr).toContain("Target is ambiguous.");
  });

  it("retains Evidence in an ambiguous occurrence handoff", async () => {
    const error = {
      type: "target-ambiguous",
      runId: "run_1",
      target: "review",
      candidates: candidates(),
      message: "Target is ambiguous.",
    } satisfies RunInspectionError;
    runtime.inspectEvidence.mockResolvedValue(err(error));

    const result = await runCliCommand([
      "runs",
      "inspect",
      "run_1",
      "--target",
      "review",
      "--evidence",
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Select: acpus runs inspect run_1 --target @ref --evidence");
    expect(result.stderr).toContain("Target is ambiguous.");
  });

  it("retains target-scoped flags in a successful candidate handoff", async () => {
    runtime.inspectTarget.mockResolvedValue(ok(candidates()));

    const result = await runCommand([
      "inspect",
      "run_1",
      "--target",
      "review",
      "--all",
      "--controls",
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Select: acpus runs inspect run_1 --target @ref --all --controls");
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

function snapshot(): RunInspectionSnapshot {
  return {
    schemaVersion: 2,
    kind: "snapshot",
    run: {
      id: "run_1",
      name: "review",
      status: "running",
      workflowEntry: "review.workflow.ts",
      createdAt: "2026-07-25T00:00:00.000Z",
      updatedAt: "2026-07-25T00:00:00.000Z",
      execution: { state: "active", lastStatus: "running" },
    },
    counts: { total: 0 },
    items: [],
    availableActions: [],
  };
}

function raw(): RunInspectionRaw {
  return { schemaVersion: 2, kind: "raw" } as RunInspectionRaw;
}

function timeline(): RunInspectionTimelineDocument {
  return {
    schemaVersion: 2,
    kind: "timeline",
    run: { id: "run_1", status: "running", updatedAt: "2026-07-25T00:00:00.000Z" },
    subject: {
      targetKind: "dynamic-node",
      id: "@1a2b3c4d5e6f",
      ref: "@1a2b3c4d5e6f",
      label: "review",
      kind: "agent",
      nodeId: "review",
    },
    state: { status: "running" },
    recent: { entries: [], page: 1, limit: 12, returned: 0, omittedBefore: 0, hasOlder: false },
  };
}

function summary(): RunInspectionTargetSummaryDocument {
  return {
    schemaVersion: 2,
    kind: "target",
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
    state: { status: "running" },
    availableActions: [
      { kind: "inspect-timeline", target: "@1a2b3c4d5e6f#1" },
    ],
  };
}

function evidence(): RunInspectionEvidenceDocument {
  return {
    schemaVersion: 2,
    kind: "evidence",
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
    evidence: {
      directory: "/private/evidence/agents/attempt_1",
      state: "recording",
      completeness: "complete",
      turnCount: 1,
      gapCount: 0,
      schedulerDisposition: "pending",
      records: {
        entries: [{
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
        page: 1,
        limit: 12,
        total: 1,
        hasMore: false,
      },
    },
  };
}

function evidenceCandidates(): RunInspectionEvidenceCandidatesDocument {
  return {
    schemaVersion: 2,
    kind: "evidence-candidates",
    run: { id: "run_1", status: "running", updatedAt: "2026-07-25T00:00:00.000Z" },
    target: "review",
    candidates: {
      entries: [{
        target: "@1a2b3c4d5e6f#1",
        attemptNo: 1,
        status: "running",
        breadcrumb: "batch[0] › review",
      }],
      page: 3,
      limit: 5,
      total: 1,
      hasMore: false,
    },
  };
}

function candidates(): RunInspectionCandidatesDocument {
  return {
    schemaVersion: 2,
    kind: "candidates",
    run: { id: "run_1", status: "running", updatedAt: "2026-07-25T00:00:00.000Z" },
    target: "review",
    candidates: {
      entries: [
        {
          ref: "@1a2b3c4d5e6f",
          status: "running",
          breadcrumb: "batch[0] › review",
          kind: "dynamic-node",
          nodeId: "review",
        },
        {
          ref: "@6f5e4d3c2b1a",
          status: "completed",
          breadcrumb: "batch[1] › review",
          kind: "dynamic-node",
          nodeId: "review",
        },
      ],
      page: 1,
      limit: 12,
      total: 2,
      hasMore: false,
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
