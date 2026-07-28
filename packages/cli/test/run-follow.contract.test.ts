import { describe, expect, it, vi, beforeEach } from "vitest";
import type {
  RunInspectionChange,
  RunInspectionEmission,
  FollowRunInspectionQuery,
  RunInspectionItem,
  RunInspectionSnapshot,
  RunInspectionTimelineDocument,
} from "@acpus/runtime";
import { followRun, parseFollowInterval } from "../src/run-follow.js";
import { CaptureStream } from "./support/capture-stream.js";

const runtime = vi.hoisted(() => ({ followRunInspection: vi.fn() }));

vi.mock("@acpus/runtime", async importOriginal => ({
  ...await importOriginal<typeof import("@acpus/runtime")>(),
  followRunInspection: runtime.followRunInspection,
}));

class TtyCaptureStream extends CaptureStream {
  isTTY = true;
}

describe("Inspection v2 follow", () => {
  beforeEach(() => {
    runtime.followRunInspection.mockReset();
  });

  it("prints one bounded snapshot then only semantic deltas for a pipe", async () => {
    runtime.followRunInspection.mockImplementation(() => emissions([
      snapshotEmission(snapshot()),
      {
        schemaVersion: 2,
        kind: "delta",
        changes: [{
          kind: "overview",
          run: { ...snapshot().run, updatedAt: "2026-07-25T00:00:01.000Z" },
          changes: [{
            sequence: 2,
            at: "2026-07-25T00:00:01.000Z",
            entity: { kind: "node", id: "work", nodeId: "work" },
            subject: "work",
            action: "started",
            status: "running",
            itemKey: "work",
          }],
          patch: {
            upsertItems: [{ ...snapshot().items[0]!, status: "running" }],
            removeItemKeys: [],
          },
        }],
      },
      done("completed", { ok: true }),
    ]));
    const stdout = new CaptureStream();

    const outcome = await followRun("/workspace", {
      runId: "run_1",
      mode: "overview",
    }, {
      phase: "inspect",
      format: "text",
      stdout,
      stderr: new CaptureStream(),
    });

    expect(outcome).toEqual({ kind: "done", run: { id: "run_1", status: "completed" } });
    expect(stdout.text.match(/Tree:/g)).toHaveLength(1);
    expect(stdout.text).toContain("+1s  work  running");
    expect(stdout.text).toContain("Run run_1  review  completed");
    expect(stdout.text.match(/\"ok\": true/g)).toHaveLength(1);
  });

  it("appends Timeline current updates and semantic entry upserts", async () => {
    const current = timeline().current;
    if (current?.kind !== "agent") throw new Error("expected Agent current activity");
    runtime.followRunInspection.mockImplementation(() => emissions([
      snapshotEmission(timeline()),
      {
        schemaVersion: 2,
        kind: "delta",
        changes: [
          {
            kind: "current",
            current: {
              ...current,
              phase: "settling",
              response: { text: "finalizing", originalBytes: 10, truncated: false },
            },
          },
          {
            kind: "recent",
            upsert: [{
              id: "activity:1",
              kind: "activity",
              at: "2026-07-25T00:00:02.000Z",
              attemptId: "attempt_1",
              turn: 1,
              channel: "response",
              summary: { text: "closed answer", originalBytes: 13, truncated: false },
            }],
            order: ["activity:1"],
            page: {
              returned: 1,
              omittedBefore: 0,
              hasOlder: false,
            },
          },
        ],
      },
      done("completed"),
    ]));
    const stdout = new CaptureStream();

    await followRun("/workspace", {
      runId: "run_1",
      mode: "timeline",
      target: "attempt_1",
    }, {
      phase: "inspect",
      format: "text",
      stdout,
      stderr: new CaptureStream(),
    });

    expect(stdout.text).toContain("Current settling · Read running");
    expect(stdout.text).toContain("response  turn=1  closed answer");
    expect(stdout.text.match(/Recent:/g)).toHaveLength(1);
  });

  it("emits the Runtime protocol as schema-v2 NDJSON and does not repeat output", async () => {
    runtime.followRunInspection.mockImplementation(() => emissions([
      snapshotEmission({ ...snapshot(), output: { hiddenUntilDone: true } }),
      done("completed", { final: true }),
    ]));
    const stdout = new CaptureStream();

    await followRun("/workspace", { runId: "run_1", mode: "overview" }, {
      phase: "run",
      format: "ndjson",
      stdout,
      stderr: new CaptureStream(),
    });

    const records = stdout.text.trim().split("\n").map(line => JSON.parse(line));
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      schemaVersion: 2,
      kind: "snapshot",
      document: { schemaVersion: 2, kind: "snapshot" },
    });
    expect(records[0].document).not.toHaveProperty("output");
    expect(records[1]).toMatchObject({
      schemaVersion: 2,
      kind: "done",
      output: { final: true },
    });
  });

  it("redraws a bounded Timeline document for TTY consumers", async () => {
    const current = timeline().current;
    if (current?.kind !== "agent") throw new Error("expected Agent current activity");
    runtime.followRunInspection.mockImplementation(() => emissions([
      snapshotEmission(timeline()),
      {
        schemaVersion: 2,
        kind: "delta",
        changes: [{ kind: "current", current: { ...current, phase: "settling" } }],
      },
      done("completed"),
    ]));
    const stdout = new TtyCaptureStream();

    await followRun("/workspace", {
      runId: "run_1",
      mode: "timeline",
      target: "attempt_1",
    }, {
      phase: "inspect",
      format: "text",
      stdout,
      stderr: new CaptureStream(),
    });

    expect(stdout.text).toContain("\u001b[J");
    expect(stdout.text).toContain("settling");
    expect(stdout.text).not.toContain("observation journal record");
  });

  it("coalesces overview omissions by context and flushes them after thirty seconds", async () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-07-25T00:00:00.000Z");
    let release!: () => void;
    const released = new Promise<void>(resolve => {
      release = resolve;
    });
    const initial = fanoutSnapshot(20);
    runtime.followRunInspection.mockImplementation(async function* () {
      yield ok(snapshotEmission(initial));
      yield ok(overviewDelta(2, fanoutChanges("completed"), fanoutItems("completed")));
      vi.setSystemTime("2026-07-25T00:00:01.000Z");
      yield ok(overviewDelta(3, fanoutChanges("ready"), fanoutItems("ready")));
      await released;
      yield ok(done("completed"));
    });
    const stdout = new CaptureStream();

    try {
      const followed = followRun("/workspace", {
        runId: "run_1",
        mode: "overview",
      }, {
        phase: "inspect",
        format: "text",
        stdout,
        stderr: new CaptureStream(),
      });

      await vi.advanceTimersByTimeAsync(29_000);
      expect(stdout.text.match(/contexts omitted/g)).toHaveLength(1);
      expect(stdout.text).toContain("… 5 contexts omitted (completed=5)");

      await vi.advanceTimersByTimeAsync(1_000);
      expect(stdout.text.match(/contexts omitted/g)).toHaveLength(2);
      expect(stdout.text).toContain("… 5 contexts omitted (ready=5)");

      release();
      await vi.advanceTimersByTimeAsync(0);
      await followed;
    } finally {
      vi.useRealTimers();
    }
  });

  it("flushes a pending overview omission before terminal output", async () => {
    const initial = fanoutSnapshot(20);
    runtime.followRunInspection.mockImplementation(() => emissions([
      snapshotEmission(initial),
      overviewDelta(2, fanoutChanges("completed"), fanoutItems("completed")),
      overviewDelta(3, fanoutChanges("started"), fanoutItems("running")),
      done("completed", { final: true }),
    ]));
    const stdout = new CaptureStream();

    await followRun("/workspace", { runId: "run_1", mode: "overview" }, {
      phase: "inspect",
      format: "text",
      stdout,
      stderr: new CaptureStream(),
    });

    expect(stdout.text.match(/contexts omitted/g)).toHaveLength(2);
    expect(stdout.text).toContain("… 5 contexts omitted (running=5)");
    expect(stdout.text.indexOf("running=5")).toBeLessThan(stdout.text.indexOf("Output:"));
  });

  it("coalesces matching terminal Agent transition and progress without losing details", async () => {
    const initial = agentSnapshot();
    const completed = { ...initial.items[0]!, status: "completed" as const };
    runtime.followRunInspection.mockImplementation(() => emissions([
      snapshotEmission(initial),
      overviewDelta(2, [{
        sequence: 7,
        at: "2026-07-25T00:00:02.000Z",
        entity: { kind: "attempt", id: "attempt_1", nodeId: "review" },
        subject: "review",
        action: "completed",
        status: "completed",
        attemptNo: 1,
        itemKey: completed.key,
        message: "lifecycle complete",
      }, {
        progressVersion: 6,
        at: "2026-07-25T00:00:02.000Z",
        entity: { kind: "progress", id: "review~1", nodeId: "review" },
        subject: "review",
        action: "progress",
        status: "completed",
        attemptNo: 1,
        itemKey: completed.key,
        message: "final progress",
      }], [completed]),
      done("completed"),
    ]));
    const stdout = new CaptureStream();

    await followRun("/workspace", { runId: "run_1", mode: "overview" }, {
      phase: "inspect",
      format: "text",
      stdout,
      stderr: new CaptureStream(),
    });

    expect(stdout.text.match(/^\+\S+\s+review\s+completed/gm)).toHaveLength(1);
    expect(stdout.text).toContain("lifecycle complete · final progress");
  });

  it("periodically redraws a TTY document and writes terminal output once", async () => {
    vi.useFakeTimers();
    let release!: () => void;
    runtime.followRunInspection.mockImplementation(async function* () {
      yield ok(snapshotEmission({ ...snapshot(), output: { hidden: true } }));
      await new Promise<void>(resolve => {
        release = resolve;
      });
      yield ok(done("completed", { final: true }));
    });
    const stdout = new TtyCaptureStream();

    try {
      const followed = followRun("/workspace", {
        runId: "run_1",
        mode: "overview",
      }, {
        phase: "inspect",
        format: "text",
        stdout,
        stderr: new CaptureStream(),
      });

      await vi.advanceTimersByTimeAsync(1_000);
      expect(stdout.text).toContain("\u001b[J");
      release();
      await vi.advanceTimersByTimeAsync(0);
      await followed;
      expect(stdout.text.match(/"final": true/g)).toHaveLength(1);
      expect(stdout.text).not.toContain('"hidden": true');
    } finally {
      vi.useRealTimers();
    }
  });

  it("emits a compact checkpoint without repeating Timeline activity", async () => {
    vi.useFakeTimers();
    let release!: () => void;
    runtime.followRunInspection.mockImplementation(async function* () {
      yield { isErr: () => false as const, value: snapshotEmission(timeline()) };
      await new Promise<void>(resolve => { release = resolve; });
      yield { isErr: () => false as const, value: done("completed") };
    });
    const stdout = new CaptureStream();
    try {
      const followed = followRun("/workspace", {
        runId: "run_1",
        mode: "timeline",
        target: "attempt_1",
      }, {
        phase: "inspect",
        format: "text",
        stdout,
        stderr: new CaptureStream(),
      });

      await vi.advanceTimersByTimeAsync(30_000);
      expect(stdout.text).toContain("· checkpoint  running  review");
      expect(stdout.text.match(/Tool: Read running/g)).toHaveLength(1);
      release();
      await followed;
    } finally {
      vi.useRealTimers();
    }
  });

  it("detaches on Ctrl-C without inventing an NDJSON emission", async () => {
    let release!: () => void;
    const released = new Promise<void>(resolve => {
      release = resolve;
    });
    runtime.followRunInspection.mockImplementation(async function* () {
      yield ok(snapshotEmission(snapshot()));
      await released;
    });
    const stdout = new CaptureStream();
    const stderr = new CaptureStream();
    const followed = followRun("/workspace", {
      runId: "run_1",
      mode: "overview",
    }, {
      phase: "run",
      format: "ndjson",
      stdout,
      stderr,
    });
    await vi.waitFor(() => expect(stdout.text).toContain('"kind":"snapshot"'));

    process.emit("SIGINT");
    release();
    const outcome = await followed;

    expect(outcome).toEqual({ kind: "detached" });
    expect(stdout.text.trim().split("\n").map(line => JSON.parse(line).kind)).toEqual(["snapshot"]);
    expect(stderr.text).toContain("Detached from run run_1");
    expect(stderr.text).toContain("acpus runs cancel run_1");
    expect(stderr.text).not.toContain("Resume:");
    expect(stderr.text).not.toContain("--after");
  });

  it("detaches before the first emission without printing a resume hint", async () => {
    let started!: () => void;
    const providerStarted = new Promise<void>(resolve => {
      started = resolve;
    });
    runtime.followRunInspection.mockImplementation(async function* (
      _cwd: string,
      query: FollowRunInspectionQuery,
    ) {
      started();
      await new Promise<void>(resolve => {
        if (query.signal?.aborted) resolve();
        else query.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
    });
    const stdout = new CaptureStream();
    const followed = followRun("/workspace", {
      runId: "run_1",
      mode: "timeline",
      target: "attempt_1",
    }, {
      phase: "inspect",
      format: "text",
      stdout,
      stderr: new CaptureStream(),
    });
    await providerStarted;

    process.emit("SIGINT");
    const outcome = await followed;

    expect(outcome).toEqual({ kind: "detached" });
    expect(stdout.text).toContain("Detached from run run_1");
    expect(stdout.text).toContain("acpus runs cancel run_1");
    expect(stdout.text).not.toContain("Resume:");
    expect(stdout.text).not.toContain("--after");
  });

  it("emits a public schema-v2 error without internal cause", async () => {
    runtime.followRunInspection.mockImplementation(() => errorEmissions({
      type: "inspection-read-failed",
      runId: "run_1",
      message: "read failed",
      cause: new Error("/private/runtime.db"),
    }));
    const stdout = new CaptureStream();

    const outcome = await followRun("/workspace", {
      runId: "run_1",
      mode: "overview",
    }, {
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

  it("parses the bounded follow polling interval", () => {
    expect(parseFollowInterval(undefined)).toBe(3_000);
    expect(parseFollowInterval("250ms")).toBe(250);
    expect(() => parseFollowInterval("100ms")).toThrow("--interval must be at least 250ms");
  });
});

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
  };
}

function agentSnapshot(): RunInspectionSnapshot {
  return {
    ...snapshot(),
    counts: { total: 1, running: 1 },
    items: [{
      key: "review~1",
      role: "instance",
      path: ["review"],
      label: "review",
      kind: "agent",
      status: "running",
      nodeId: "review",
      nodeKey: "review~1",
      attemptId: "attempt_1",
      attemptNo: 1,
      agent: {
        key: "reviewer",
      },
    }],
  };
}

function fanoutSnapshot(contexts: number): RunInspectionSnapshot {
  return {
    ...snapshot(),
    counts: { total: contexts, completed: contexts },
    items: Array.from({ length: contexts }, (_, index) => fanoutItem(index, "completed")),
  };
}

function fanoutItems(status: RunInspectionItem["status"]): RunInspectionItem[] {
  return Array.from({ length: 5 }, (_, offset) => fanoutItem(20 + offset, status));
}

function fanoutItem(index: number, status: RunInspectionItem["status"]): RunInspectionItem {
  return {
    key: `work~${index}`,
    role: "instance",
    path: [`batch[${index}]`, "work"],
    label: `batch[${index}] › work`,
    kind: "task",
    status,
    nodeId: "work",
    nodeKey: `work~${index}`,
  };
}

function fanoutChanges(
  action: "ready" | "started" | "completed",
): RunInspectionChange[] {
  const status = action === "started" ? "running" : action;
  return Array.from({ length: 5 }, (_, offset) => {
    const index = 20 + offset;
    return {
      sequence: 10 + offset,
      at: "2026-07-25T00:00:01.000Z",
      entity: { kind: "node", id: `work~${index}`, nodeId: "work" },
      subject: `batch[${index}] › work`,
      action,
      status,
      itemKey: `work~${index}`,
    };
  });
}

function overviewDelta(
  sequence: number,
  changes: RunInspectionChange[],
  items: RunInspectionItem[],
): RunInspectionEmission {
  return {
    schemaVersion: 2,
    kind: "delta",
    changes: [{
      kind: "overview",
      run: {
        ...snapshot().run,
        updatedAt: `2026-07-25T00:00:0${sequence}.000Z`,
      },
      changes,
      patch: { upsertItems: items, removeItemKeys: [] },
    }],
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
      id: "attempt_1",
      label: "review",
      kind: "agent",
      nodeId: "review",
      nodeKey: "review~abc",
      attemptId: "attempt_1",
      attemptNo: 1,
    },
    state: { status: "running", startedAt: "2026-07-25T00:00:00.000Z" },
    current: {
      kind: "agent",
      attemptId: "attempt_1",
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
      returned: 0,
      omittedBefore: 0,
      hasOlder: false,
    },
  };
}

function snapshotEmission(
  document: RunInspectionSnapshot | RunInspectionTimelineDocument,
): RunInspectionEmission {
  return {
    schemaVersion: 2,
    kind: "snapshot",
    document,
  };
}

function done(status: "completed", output?: unknown): RunInspectionEmission {
  return {
    schemaVersion: 2,
    kind: "done",
    run: { id: "run_1", status },
    ...(output === undefined ? {} : { output: output as never }),
  };
}

async function* emissions(values: RunInspectionEmission[]) {
  for (const value of values) {
    yield ok(value);
  }
}

function ok<T>(value: T) {
  return { isErr: () => false as const, value };
}

async function* errorEmissions(error: unknown) {
  yield { isErr: () => true as const, error };
}
