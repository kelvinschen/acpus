import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InspectionError, InspectionObservation, InspectionView } from "@acpus/runtime";
import { followRun } from "../src/run-follow.js";
import { CaptureStream } from "./support/capture-stream.js";

const runtime = vi.hoisted(() => ({ observeInspection: vi.fn() }));

vi.mock("@acpus/runtime", async importOriginal => ({
  ...await importOriginal<typeof import("@acpus/runtime")>(),
  observeInspection: runtime.observeInspection,
}));

describe("inspection observation transcript", () => {
  beforeEach(() => {
    runtime.observeInspection.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders attachment, compact semantic changes, and closure as an append-only transcript", async () => {
    vi.spyOn(Date, "now").mockReturnValueOnce(0).mockReturnValue(423_000);
    runtime.observeInspection.mockImplementation(() => emissions([
      ok({ kind: "attached", view: runningView() }),
      ok({
        kind: "update",
        changes: [{ subject: { label: "design_board", selector: "@1a2b3c4d5e6f" }, state: { status: "completed" } }],
        timeline: [{ kind: "phase", at: "2026-07-30T00:00:02.000Z", phase: "tool", turn: 1 }],
      }),
      ok({ kind: "closed", reason: "subject-terminal", view: completedView() }),
    ]));
    const stdout = new CaptureStream();

    const outcome = await followRun("/workspace", { kind: "run", runId: "run_1" }, {
      until: "subject-terminal",
      stdout,
      stderr: new CaptureStream(),
    });

    expect(outcome).toEqual({ kind: "closed", reason: "subject-terminal", run: { id: "run_1", status: "completed" } });
    expect(runtime.observeInspection).toHaveBeenCalledWith("/workspace", expect.objectContaining({
      view: { kind: "run", runId: "run_1" },
      until: "subject-terminal",
      signal: expect.any(AbortSignal),
    }));
    expect(stdout.text.match(/Attached:/g)).toHaveLength(1);
    expect(stdout.text).toContain("Attached:\nRun run_1  design  running  1m16s");
    expect(stdout.text.match(/Tree:/g)).toHaveLength(2);
    expect(stdout.text.slice(0, stdout.text.indexOf("Updates"))).not.toContain("Await:");
    expect(stdout.text).toContain("Updates · run 8m19s:\n  ✓ design_board  @1a2b3c4d5e6f · completed");
    expect(stdout.text).toContain("Timeline:\n  2026-07-30T00:00:02.000Z  phase tool");
    expect(stdout.text).not.toContain("turn=1");
    expect(stdout.text).toContain("Output:\n  {\n    \"accepted\": true\n  }");
    expect(stdout.text).not.toContain("spinner");
    expect(stdout.text).not.toContain("heartbeat");
  });

  it("keeps target updates unqualified", async () => {
    runtime.observeInspection.mockImplementation(() => emissions([
      ok({ kind: "attached", view: targetTimeline() }),
      ok({
        kind: "update",
        changes: [{ subject: { label: "review", selector: "@1a2b3c4d5e6f#2" }, state: { status: "running" } }],
      }),
      ok({
        kind: "closed",
        reason: "subject-terminal",
        view: { ...targetTimeline(), state: { status: "completed" } },
      }),
    ]));
    const stdout = new CaptureStream();

    await followRun("/workspace", {
      kind: "target",
      runId: "run_1",
      target: "@1a2b3c4d5e6f#2",
      detail: "timeline",
    }, {
      until: "subject-terminal",
      stdout,
      stderr: new CaptureStream(),
    });

    expect(stdout.text).toContain("Updates:\n  ⠋ review  @1a2b3c4d5e6f#2 · running");
    expect(stdout.text).not.toContain("Updates · run");
  });

  it("prints durable Timeline evidence without an empty state update", async () => {
    runtime.observeInspection.mockImplementation(() => emissions([
      ok({ kind: "attached", view: targetTimeline() }),
      ok({
        kind: "update",
        changes: [],
        timeline: [{
          kind: "activity",
          at: "2026-07-30T00:00:02.000Z",
          channel: "tool",
          attempt: 2,
          turn: 1,
          summary: "Bash",
        }],
      }),
      ok({
        kind: "closed",
        reason: "subject-terminal",
        view: { ...targetTimeline(), state: { status: "completed" } },
      }),
    ]));
    const stdout = new CaptureStream();

    await followRun("/workspace", {
      kind: "target",
      runId: "run_1",
      target: "@1a2b3c4d5e6f#2",
      detail: "timeline",
    }, {
      until: "subject-terminal",
      stdout,
      stderr: new CaptureStream(),
    });

    expect(stdout.text).toContain("Timeline:\n  2026-07-30T00:00:02.000Z  tool  Bash");
    expect(stdout.text).not.toContain("attempt=2");
    expect(stdout.text).not.toContain("Attempt 2:");
    expect(stdout.text).not.toContain("turn=1");
    expect(stdout.text).not.toContain("Updates:");
  });

  it("falls back to an unqualified run update when attachment has no duration", async () => {
    const attached = runningView();
    delete attached.run.durationMs;
    runtime.observeInspection.mockImplementation(() => emissions([
      ok({ kind: "attached", view: attached }),
      ok({
        kind: "update",
        changes: [{ subject: { label: "design_board" }, state: { status: "running" } }],
      }),
      ok({ kind: "closed", reason: "subject-terminal", view: completedView() }),
    ]));
    const stdout = new CaptureStream();

    await followRun("/workspace", { kind: "run", runId: "run_1" }, {
      until: "subject-terminal",
      stdout,
      stderr: new CaptureStream(),
    });

    expect(stdout.text).toContain("Updates:\n  ⠋ design_board · running");
    expect(stdout.text).not.toContain("Updates · run");
  });

  it("does not emit elapsed time without a Runtime observation", async () => {
    let now = 0;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    runtime.observeInspection.mockImplementation((_cwd: string, query: { signal: AbortSignal }) => (async function* () {
      yield ok({ kind: "attached", view: runningView() });
      await new Promise<void>(resolve => query.signal.addEventListener("abort", () => resolve(), { once: true }));
    })());
    const stdout = new CaptureStream();
    const followed = followRun("/workspace", { kind: "run", runId: "run_1" }, {
      until: "decision-boundary",
      stdout,
      stderr: new CaptureStream(),
    });
    await vi.waitFor(() => expect(stdout.text).toContain("Attached:"));
    const attachment = stdout.text;

    now = 600_000;
    await Promise.resolve();

    expect(stdout.text).toBe(attachment);
    process.emit("SIGINT");
    await followed;
  });

  it("prints only the closed coherent view when the subject already meets its stop policy", async () => {
    runtime.observeInspection.mockImplementation(() => emissions([
      ok({ kind: "closed", reason: "awaiting-input", view: awaitingView() }),
    ]));
    const stdout = new CaptureStream();

    const outcome = await followRun("/workspace", { kind: "run", runId: "run_1" }, {
      until: "decision-boundary",
      stdout,
      stderr: new CaptureStream(),
    });

    expect(outcome).toEqual({ kind: "closed", reason: "awaiting-input", run: { id: "run_1", status: "running" } });
    expect(stdout.text.match(/Tree:/g)).toHaveLength(1);
    expect(stdout.text).not.toContain("Updates:");
  });

  it("stops consuming as soon as Runtime closes the observation", async () => {
    runtime.observeInspection.mockImplementation(() => (async function* () {
      yield ok({ kind: "closed", reason: "subject-terminal", view: completedView() });
      throw new Error("must not read after a closed observation");
    })());
    const stdout = new CaptureStream();
    const stderr = new CaptureStream();

    const outcome = await followRun("/workspace", { kind: "run", runId: "run_1" }, {
      until: "subject-terminal",
      stdout,
      stderr,
    });

    expect(outcome).toEqual({ kind: "closed", reason: "subject-terminal", run: { id: "run_1", status: "completed" } });
    expect(stderr.text).toBe("");
  });

  it("detaches read-only and preserves a selected Timeline recovery command", async () => {
    let release!: () => void;
    runtime.observeInspection.mockImplementation((_cwd: string, query: { signal: AbortSignal }) => (async function* () {
      yield ok({ kind: "attached", view: targetTimeline() });
      await new Promise<void>(resolve => {
        release = resolve;
        query.signal.addEventListener("abort", () => resolve(), { once: true });
      });
    })());
    const stdout = new CaptureStream();
    const followed = followRun("/workspace", {
      kind: "target",
      runId: "run_1",
      target: "@1a2b3c4d5e6f#2",
      detail: "timeline",
    }, {
      until: "decision-boundary",
      stdout,
      stderr: new CaptureStream(),
    });
    await vi.waitFor(() => expect(stdout.text).toContain("Timeline review"));

    process.emit("SIGINT");
    release();

    expect(await followed).toEqual({ kind: "detached" });
    expect(stdout.text).toContain("Detached from run run_1.");
    expect(stdout.text).toContain("Inspect: acpus runs inspect run_1 --target '@1a2b3c4d5e6f#2' --timeline");
    expect(stdout.text.slice(stdout.text.indexOf("Detached from run run_1."))).not.toContain("--await-decision");
  });

  it("detaches when Ctrl-C races an in-flight inspection error", async () => {
    let resolveNext!: (value: IteratorResult<unknown>) => void;
    runtime.observeInspection.mockImplementation(() => ({
      [Symbol.asyncIterator]: () => ({
        next: () => new Promise<IteratorResult<unknown>>(resolve => { resolveNext = resolve; }),
        return: async () => ({ done: true, value: undefined }),
      }),
    }));
    const stderr = new CaptureStream();
    const followed = followRun("/workspace", { kind: "run", runId: "run_1" }, {
      until: "decision-boundary",
      stdout: new CaptureStream(),
      stderr,
    });

    await vi.waitFor(() => expect(resolveNext).toBeTypeOf("function"));
    process.emit("SIGINT");
    resolveNext({ done: false, value: err({ type: "read-failed", runId: "run_1", message: "late read failure" }) });

    expect(await followed).toEqual({ kind: "detached" });
    expect(stderr.text).toBe("");
  });

  it("prints an ambiguous candidate handoff without attaching", async () => {
    const error: InspectionError = {
      type: "target-ambiguous",
      runId: "run_1",
      target: "review",
      candidates: {
        kind: "candidates",
        run: { id: "run_1", status: "running" },
        target: "review",
        entries: Array.from({ length: 13 }, (_, index) => ({
          selector: `@${(index + 1).toString(16).padStart(12, "0")}`,
          status: "running",
          breadcrumb: `batch[${index}] › review`,
        })),
      },
      message: "Target is ambiguous.",
    };
    runtime.observeInspection.mockImplementation(() => emissions([err(error)]));
    const stdout = new CaptureStream();
    const stderr = new CaptureStream();

    const outcome = await followRun("/workspace", {
      kind: "target",
      runId: "run_1",
      target: "review",
      detail: "summary",
    }, {
      until: "decision-boundary",
      stdout,
      stderr,
    });

    expect(outcome).toEqual({ kind: "error", error });
    expect(stdout.text).toBe("");
    expect(stderr.text).toContain("Target review  matches=13");
    expect(stderr.text).toContain("Select: acpus runs inspect run_1 --target @000000000001");
    expect(stderr.text).toContain("Select: acpus runs inspect run_1 --target @00000000000d");
    expect(stderr.text).not.toContain("Next:");
    expect(stderr.text).toContain("Cannot attach: Target is ambiguous.");
  });

  it("prints the exact recovery command after a read failure", async () => {
    const error: InspectionError = { type: "read-failed", runId: "run_1", message: "store read failed" };
    runtime.observeInspection.mockImplementation(() => emissions([err(error)]));
    const stderr = new CaptureStream();

    const outcome = await followRun("/workspace", {
      kind: "target",
      runId: "run_1",
      target: "@1a2b3c4d5e6f",
      detail: "timeline",
    }, {
      until: "subject-terminal",
      stdout: new CaptureStream(),
      stderr,
    });

    expect(outcome).toEqual({ kind: "error", error });
    expect(stderr.text).toBe([
      "Inspection failed: store read failed",
      "Inspect: acpus runs inspect run_1 --target @1a2b3c4d5e6f --timeline",
      "",
    ].join("\n"));
  });

  it("prints an invalid query as usage text without a recovery command", async () => {
    const error: InspectionError = { type: "invalid-query", message: "Target selector is malformed." };
    runtime.observeInspection.mockImplementation(() => emissions([err(error)]));
    const stderr = new CaptureStream();

    const outcome = await followRun("/workspace", { kind: "run", runId: "run_1" }, {
      until: "subject-terminal",
      stdout: new CaptureStream(),
      stderr,
    });

    expect(outcome).toEqual({ kind: "error", error });
    expect(stderr.text).toBe("Target selector is malformed.\n");
  });
});

function runningView(): Extract<InspectionView, { kind: "run" }> {
  return {
    kind: "run",
    run: { id: "run_1", name: "design", status: "running", durationMs: 76_000 },
    counts: { total: 1, running: 1 },
    tree: [{
      type: "item",
      subject: { label: "design_board", kind: "agent", selector: "@1a2b3c4d5e6f" },
      state: { status: "running" },
      children: [],
    }],
  };
}

function completedView(): Extract<InspectionView, { kind: "run" }> {
  return {
    ...runningView(),
    run: { id: "run_1", name: "design", status: "completed", durationMs: 500_000 },
    counts: { total: 1, completed: 1 },
    tree: [{
      type: "item",
      subject: { label: "design_board", kind: "agent", selector: "@1a2b3c4d5e6f" },
      state: { status: "completed" },
      children: [],
    }],
    output: { accepted: true },
  };
}

function awaitingView(): Extract<InspectionView, { kind: "run" }> {
  return {
    kind: "run",
    run: { id: "run_1", name: "design", status: "running" },
    counts: { total: 1, awaiting: 1 },
    tree: [{
      type: "item",
      subject: { label: "approve", kind: "signal", selector: "@1a2b3c4d5e6f" },
      state: { status: "awaiting" },
      attention: { kind: "awaiting-input", summary: "approval needed", signal: "@signal1" },
      children: [],
    }],
  };
}

function targetTimeline(): Extract<InspectionView, { kind: "target"; detail: "timeline" }> {
  return {
    kind: "target",
    detail: "timeline",
    run: { id: "run_1", status: "running" },
    subject: { label: "review", kind: "agent", selector: "@1a2b3c4d5e6f#2" },
    state: { status: "running" },
    recent: [],
  };
}

async function* emissions(values: unknown[]): AsyncGenerator<unknown> {
  yield* values;
}

function ok(value: InspectionObservation): { isErr(): false; value: InspectionObservation } {
  return { isErr: () => false, value };
}

function err(error: InspectionError): { isErr(): true; error: InspectionError } {
  return { isErr: () => true, error };
}
