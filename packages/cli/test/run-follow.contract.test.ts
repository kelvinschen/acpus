import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  WatchInspectionEmission,
  RunInspectionCandidatesDocument,
  RunInspectionError,
  RunInspectionSnapshot,
  RunInspectionTimelineDocument,
  WatchInspectionQuery,
} from "@acpus/runtime";
import { followRun } from "../src/run-follow.js";
import { CaptureStream } from "./support/capture-stream.js";

const runtime = vi.hoisted(() => ({ watchInspection: vi.fn() }));

vi.mock("@acpus/runtime", async importOriginal => ({
  ...await importOriginal<typeof import("@acpus/runtime")>(),
  watchInspection: runtime.watchInspection,
}));

describe("Inspection v2 follow", () => {
  beforeEach(() => {
    runtime.watchInspection.mockReset();
  });

  it("prints one self-contained initial view and one boundary view without a lifecycle transcript", async () => {
    runtime.watchInspection.mockImplementation(() => emissions([
      view(snapshot()),
      view(snapshot({
        run: { ...snapshot().run, status: "completed", execution: { state: "terminal", lastStatus: "completed" } },
        counts: { total: 1, completed: 1 },
        items: [{ ...snapshot().items[0]!, status: "completed" }],
        output: { accepted: true },
      })),
    ]));
    const stdout = new CaptureStream();

    const outcome = await followRun("/workspace", { view: { kind: "run", runId: "run_1" } }, {
      phase: "inspect",
      format: "text",
      stdout,
      stderr: new CaptureStream(),
    });

    expect(outcome).toEqual({ kind: "done", run: { id: "run_1", status: "completed" } });
    expect(stdout.text.match(/Tree:/g)).toHaveLength(2);
    expect(stdout.text.match(/"accepted": true/g)).toHaveLength(1);
    expect(stdout.text).not.toContain("checkpoint");
    expect(stdout.text).not.toContain("Resynced");
    expect(stdout.text).not.toMatch(/^\+/m);
  });

  it("returns one boundary view when attachment is already actionable", async () => {
    const actionable = snapshot({
      run: { ...snapshot().run, status: "awaiting" },
      counts: { total: 1, awaiting: 1 },
      items: [{
        ...snapshot().items[0]!,
        kind: "signal",
        status: "awaiting",
        ref: "@1a2b3c4d5e6f",
        signal: { target: "private-signal", schemaSummary: "{ approved: boolean }" },
      }],
    });
    runtime.watchInspection.mockImplementation(() => emissions([view(actionable)]));
    const stdout = new CaptureStream();

    const outcome = await followRun("/workspace", { view: { kind: "run", runId: "run_1" } }, {
      phase: "inspect",
      format: "text",
      stdout,
      stderr: new CaptureStream(),
    });

    expect(outcome).toEqual({ kind: "done", run: { id: "run_1", status: "awaiting" } });
    expect(stdout.text.match(/Tree:/g)).toHaveLength(1);
    expect(stdout.text).toContain("Signal: acpus runs signal run_1 --target @1a2b3c4d5e6f --payload '<json>'");
  });

  it("writes standalone ordered Timeline semantic entries between bounded views", async () => {
    runtime.watchInspection.mockImplementation(() => emissions([
      view(timeline()),
      {
        schemaVersion: 2,
        kind: "timeline-entry",
        entry: {
          id: "private-entry-phase",
          kind: "phase",
          at: "2026-07-25T00:00:02.000Z",
          attemptId: "private-attempt",
          attemptNo: 1,
          turn: 2,
          phase: "tool",
        },
      },
      {
        schemaVersion: 2,
        kind: "timeline-entry",
        entry: {
          id: "private-entry-visibility",
          kind: "visibility",
          at: "2026-07-25T00:00:03.000Z",
          state: "degraded",
          reason: "observation-gap",
        },
      },
      view({
        ...timeline(),
        run: { ...timeline().run, status: "completed" },
        state: { status: "completed" },
      }),
    ]));
    const stdout = new CaptureStream();

    await followRun("/workspace", {
      view: { kind: "timeline", runId: "run_1", target: "@1a2b3c4d5e6f#1" },
    }, {
      phase: "inspect",
      format: "text",
      stdout,
      stderr: new CaptureStream(),
    });

    expect(stdout.text.match(/Recent:/g)).toHaveLength(2);
    expect(stdout.text).toContain("Timeline: 2026-07-25T00:00:02.000Z  phase tool  attempt=1  turn=2");
    expect(stdout.text).toContain("Timeline: 2026-07-25T00:00:03.000Z  Visibility degraded/observation-gap");
    expect(stdout.text).not.toContain("private-entry");
    expect(stdout.text).not.toContain("private-attempt");
  });

  it("keeps text and NDJSON on the same view and semantic-entry protocol", async () => {
    const values: WatchInspectionEmission[] = [
      view(snapshot()),
      {
        schemaVersion: 2,
        kind: "timeline-entry",
        entry: {
          id: "private-entry",
          kind: "control",
          at: "2026-07-25T00:00:02.000Z",
          attemptId: "private-attempt",
          attemptNo: 1,
          action: "steered",
        },
      },
      view(snapshot({
        run: { ...snapshot().run, status: "completed", execution: { state: "terminal", lastStatus: "completed" } },
        counts: { total: 1, completed: 1 },
        items: [{ ...snapshot().items[0]!, status: "completed" }],
        output: null,
      })),
    ];
    runtime.watchInspection.mockImplementation(() => emissions(values));
    const stdout = new CaptureStream();

    await followRun("/workspace", { view: { kind: "run", runId: "run_1" } }, {
      phase: "run",
      format: "ndjson",
      stdout,
      stderr: new CaptureStream(),
    });

    const records = stdout.text.trim().split("\n").map(line => JSON.parse(line));
    expect(records.map(record => record.kind)).toEqual(["view", "timeline-entry", "view"]);
    expect(records[0]).toMatchObject({ schemaVersion: 2, document: { kind: "snapshot" } });
    expect(records[1]).toMatchObject({ entry: { kind: "control", action: "steered", attemptNo: 1 } });
    expect(records[1].entry).not.toHaveProperty("id");
    expect(records[1].entry).not.toHaveProperty("attemptId");
    expect(records[2].document.output).toBeNull();
    expect(JSON.stringify(records)).not.toContain("private-entry");
    expect(JSON.stringify(records)).not.toContain("private-attempt");
  });

  it("uses workflow-owned polling cadence without adding it to the Runtime query", async () => {
    vi.useFakeTimers();
    let initialPulled!: () => void;
    let secondPulled!: () => void;
    let resolveBoundary!: (value: IteratorResult<unknown>) => void;
    const initial = new Promise<void>(resolve => { initialPulled = resolve; });
    const second = new Promise<void>(resolve => { secondPulled = resolve; });
    let pulls = 0;
    runtime.watchInspection.mockImplementation(() => ({
      [Symbol.asyncIterator]() {
        let call = 0;
        return {
          next: () => {
            call += 1;
            if (call === 1) {
              initialPulled();
              return Promise.resolve({ done: false, value: ok(view(snapshot())) });
            }
            if (call === 2) {
              pulls += 1;
              secondPulled();
              return new Promise<IteratorResult<unknown>>(resolve => { resolveBoundary = resolve; });
            }
            return Promise.resolve({ done: true, value: undefined });
          },
          return: () => Promise.resolve({ done: true, value: undefined }),
        };
      },
    }) as never);
    const stdout = new CaptureStream();

    try {
      const followed = followRun("/workspace", { view: { kind: "run", runId: "run_1" } }, {
        phase: "run",
        format: "text",
        stdout,
        stderr: new CaptureStream(),
        pollIntervalMs: 250,
      });
      await initial;
      await vi.advanceTimersByTimeAsync(0);
      expect(stdout.text.match(/Tree:/g)).toHaveLength(1);
      expect(pulls).toBe(0);
      await vi.advanceTimersByTimeAsync(249);
      expect(pulls).toBe(0);
      await vi.advanceTimersByTimeAsync(1);
      await second;
      resolveBoundary({
        done: false,
        value: ok(view(snapshot({
          run: { ...snapshot().run, status: "completed", execution: { state: "terminal", lastStatus: "completed" } },
          counts: { total: 1, completed: 1 },
          items: [{ ...snapshot().items[0]!, status: "completed" }],
        }))),
      });
      await vi.advanceTimersByTimeAsync(250);
      await followed;
      expect(pulls).toBe(1);
      expect(stdout.text.match(/Tree:/g)).toHaveLength(2);
      expect(runtime.watchInspection.mock.calls[0]?.[1]).not.toHaveProperty("intervalMs");
    } finally {
      vi.useRealTimers();
    }
  });

  it("detaches on Ctrl-C without inventing an NDJSON record", async () => {
    let release!: () => void;
    runtime.watchInspection.mockImplementation(async function* (
      _cwd: string,
      query: WatchInspectionQuery,
    ) {
      yield ok(view(snapshot()));
      await new Promise<void>(resolve => {
        release = resolve;
        query.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
    });
    const stdout = new CaptureStream();
    const stderr = new CaptureStream();
    const followed = followRun("/workspace", { view: { kind: "run", runId: "run_1" } }, {
      phase: "inspect",
      format: "ndjson",
      stdout,
      stderr,
    });
    await vi.waitFor(() => expect(stdout.text).toContain('"kind":"view"'));

    process.emit("SIGINT");
    release();
    const outcome = await followed;

    expect(outcome).toEqual({ kind: "detached" });
    expect(stdout.text.trim().split("\n").map(line => JSON.parse(line).kind)).toEqual(["view"]);
    expect(stderr.text).toContain("Detached from run run_1");
    expect(stderr.text).toContain("acpus runs inspect run_1");
  });

  it("emits a public schema-v2 error without an internal cause", async () => {
    runtime.watchInspection.mockImplementation(() => errorEmissions({
      type: "inspection-read-failed",
      runId: "run_1",
      message: "read failed",
      cause: new Error("/private/runtime.db"),
    }));
    const stdout = new CaptureStream();

    const outcome = await followRun("/workspace", { view: { kind: "run", runId: "run_1" } }, {
      phase: "inspect",
      format: "ndjson",
      stdout,
      stderr: new CaptureStream(),
    });

    expect(outcome).toMatchObject({ kind: "error" });
    expect(JSON.parse(stdout.text)).toEqual({
      schemaVersion: 2,
      ok: false,
      phase: "inspect",
      kind: "error",
      error: {
        type: "inspection-read-failed",
        runId: "run_1",
        message: "read failed",
      },
    });
  });

  it("renders an ambiguous target's candidate handoff before a text follow error", async () => {
    runtime.watchInspection.mockImplementation(() => errorEmissions({
      type: "target-ambiguous",
      runId: "run_1",
      target: "review",
      candidates: candidates(),
      message: "Target review matches multiple occurrences.",
    } satisfies RunInspectionError));
    const stderr = new CaptureStream();

    const outcome = await followRun("/workspace", {
      view: {
        kind: "target",
        runId: "run_1",
        target: "review",
        includeAllTopology: true,
        includeControls: true,
      },
    }, {
      phase: "inspect",
      format: "text",
      stdout: new CaptureStream(),
      stderr,
    });

    expect(outcome).toMatchObject({ kind: "error", error: { type: "target-ambiguous" } });
    expect(stderr.text).toContain("@1a2b3c4d5e6f");
    expect(stderr.text).toContain("Select: acpus runs inspect run_1 --target @ref --all --controls");
    expect(stderr.text).not.toContain("--follow");
    expect(stderr.text).toContain("Inspection failed: Target review matches multiple occurrences.");
  });
});

function snapshot(overrides: Partial<RunInspectionSnapshot> = {}): RunInspectionSnapshot {
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
    counts: { total: 1, ready: 1 },
    items: [{
      key: "work",
      role: "static",
      path: ["work"],
      label: "work",
      kind: "task",
      status: "ready",
      nodeId: "work",
    }],
    availableActions: [],
    ...overrides,
  };
}

function timeline(): RunInspectionTimelineDocument {
  return {
    schemaVersion: 2,
    kind: "timeline",
    run: {
      id: "run_1",
      status: "running",
      updatedAt: "2026-07-25T00:00:01.000Z",
    },
    subject: {
      targetKind: "attempt",
      id: "@1a2b3c4d5e6f#1",
      ref: "@1a2b3c4d5e6f#1",
      label: "review",
      kind: "agent",
      nodeId: "review",
      attemptNo: 1,
    },
    state: { status: "running", startedAt: "2026-07-25T00:00:00.000Z" },
    current: {
      kind: "agent",
      attemptId: "private-current-attempt",
      turn: 1,
      turnKind: "task",
      phase: "tool",
      updatedAt: "2026-07-25T00:00:01.000Z",
      tools: {
        active: [{
          name: "Read",
          status: "running",
          updatedAt: "2026-07-25T00:00:01.000Z",
        }],
        omittedActive: 0,
      },
    },
    recent: {
      entries: [],
      page: 1,
      limit: 12,
      returned: 0,
      omittedBefore: 0,
      hasOlder: false,
    },
  };
}

function candidates(): RunInspectionCandidatesDocument {
  return {
    schemaVersion: 2,
    kind: "candidates",
    run: { id: "run_1", status: "running", updatedAt: "2026-07-25T00:00:01.000Z" },
    target: "review",
    candidates: {
      entries: [{
        ref: "@1a2b3c4d5e6f",
        status: "running",
        breadcrumb: "batch[0] › review",
        kind: "dynamic-node",
      }],
      page: 1,
      limit: 12,
      total: 2,
      hasMore: false,
    },
  };
}

function view(document: RunInspectionSnapshot | RunInspectionTimelineDocument): WatchInspectionEmission {
  return { schemaVersion: 2, kind: "view", document };
}

async function* emissions(values: readonly WatchInspectionEmission[]) {
  for (const value of values) yield ok(value);
}

function ok<T>(value: T) {
  return { isErr: () => false as const, value };
}

async function* errorEmissions(error: unknown) {
  yield { isErr: () => true as const, error };
}
