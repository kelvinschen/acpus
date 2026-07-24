import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FollowRunInspectionQuery, RunInspectionChange, RunInspectionEmission, RunInspectionSnapshot, RunInspectionTargetDocument } from "@acpus/runtime";
import { Readable } from "node:stream";
import { createRunsCommand } from "../src/commands/runs.js";
import { followRun } from "../src/run-follow.js";
import { CaptureStream } from "./support/capture-stream.js";

const runtime = vi.hoisted(() => ({ followRunInspection: vi.fn(), getRunInspection: vi.fn() }));

vi.mock("@acpus/runtime", async importOriginal => ({
  ...await importOriginal<typeof import("@acpus/runtime")>(),
  followRunInspection: runtime.followRunInspection,
  getRunInspection: runtime.getRunInspection,
}));

describe("run inspection follow output", () => {
  beforeEach(() => {
    runtime.followRunInspection.mockReset();
    runtime.getRunInspection.mockReset().mockResolvedValue(okResult(snapshot("running")));
  });

  it("emits valid NDJSON and keeps terminal output only in done", async () => {
    const exactChanges = fanoutChanges(25);
    runtime.followRunInspection.mockImplementation(() => emissions([
      { schemaVersion: 1, kind: "snapshot", cursor: cursor(1), document: { ...snapshot("running"), output: { accidental: true } } },
      {
        schemaVersion: 1,
        kind: "update",
        cursor: cursor(1 + exactChanges.length),
        run: runSummary("running"),
        changes: exactChanges,
        patch: { upsertItems: [], removeItemKeys: [] },
      },
      { schemaVersion: 1, kind: "done", cursor: cursor(2 + exactChanges.length), run: runSummary("completed"), output: { result: "ok" } },
    ]));
    const stdout = new CaptureStream();
    const stderr = new CaptureStream();

    const outcome = await followRun("/workspace", { runId: "run_1", mode: "overview", intervalMs: 250 }, {
      phase: "inspect", format: "ndjson", stdout, stderr,
    });

    expect(outcome).toMatchObject({ kind: "done", run: { status: "completed" } });
    const records = stdout.text.trim().split("\n").map(line => JSON.parse(line));
    expect(records.map(record => record.kind)).toEqual(["snapshot", "update", "done"]);
    expect(records[0].document.output).toBeUndefined();
    expect(records[1].changes).toHaveLength(exactChanges.length);
    expect(records.filter(record => record.output !== undefined)).toHaveLength(1);
    expect(records[2].output).toEqual({ result: "ok" });
    expect(stderr.text).toBe("");
  });

  it("appends only semantic changes for pipe output", async () => {
    runtime.followRunInspection.mockImplementation(() => emissions([
      { schemaVersion: 1, kind: "snapshot", cursor: cursor(1), document: snapshot("running") },
      {
        schemaVersion: 1,
        kind: "update",
        cursor: cursor(2),
        run: runSummary("running"),
        changes: [{ sequence: 2, at: "2026-07-11T00:00:01.000Z", entity: { kind: "node", id: "work~abc", nodeId: "work" }, subject: "work", action: "started", status: "running" }],
        patch: { upsertItems: [], removeItemKeys: [] },
      },
      { schemaVersion: 1, kind: "done", cursor: cursor(3), run: runSummary("completed"), output: {} },
    ]));
    const stdout = new CaptureStream();

    await followRun("/workspace", { runId: "run_1", mode: "overview" }, {
      phase: "inspect", format: "text", stdout, stderr: new CaptureStream(),
    });

    expect(stdout.text.match(/Run run_1  workflow  running/g)).toHaveLength(1);
    expect(stdout.text).toContain("+1s  work  running");
    expect(stdout.text).toContain("Run run_1  workflow  completed  2s");
    expect(stdout.text).toContain("Output:\n  {}");
  });

  it.each([
    { name: "prints a root-only failure in snapshot follow", mode: "overview" as const, propagated: false, visible: true },
    { name: "suppresses a propagated root failure in snapshot follow", mode: "overview" as const, propagated: true, visible: false },
    { name: "suppresses a root failure in target follow", mode: "target" as const, propagated: false, visible: false },
  ])("$name", async ({ mode, propagated, visible }) => {
    const initial = snapshot("running");
    const failedRun = failedRunSummary();
    const failedItem = {
      ...initial.items[0]!,
      status: "failed" as const,
      failure: { origin: "task" as const, code: "task_failed", message: "Task failed." },
    };
    const document = mode === "target" ? targetDocument(initial) : initial;
    runtime.followRunInspection.mockImplementation(() => emissions([
      { schemaVersion: 1, kind: "snapshot", cursor: cursor(1), document },
      {
        schemaVersion: 1,
        kind: "update",
        cursor: cursor(2),
        run: failedRun,
        changes: [{
          sequence: 2,
          at: "2026-07-11T00:00:01.000Z",
          entity: { kind: "run", id: "run_1" },
          subject: "run_1",
          action: "failed",
          status: "failed",
          message: "Workflow output failed.",
        }],
        patch: {
          upsertItems: propagated ? [failedItem] : [],
          removeItemKeys: [],
        },
      },
      { schemaVersion: 1, kind: "done", cursor: cursor(3), run: failedRun },
    ]));
    const stdout = new CaptureStream();
    const query: FollowRunInspectionQuery = mode === "target"
      ? { runId: "run_1", mode, target: "observe" }
      : { runId: "run_1", mode };

    await followRun("/workspace", query, {
      phase: "inspect", format: "text", stdout, stderr: new CaptureStream(),
    });

    const direct = [
      "+1s  run_1  failed  Error (scheduler root_failed): Workflow output failed.",
      "  Inspect: acpus runs inspect run_1 --target root",
      "",
    ].join("\n");
    if (visible) expect(stdout.text).toContain(direct);
    else {
      expect(stdout.text).not.toContain("Error (scheduler root_failed): Workflow output failed.");
      expect(stdout.text).not.toContain("--target root");
    }
  });

  it("appends the actionable command immediately after an awaiting pipe transition", async () => {
    const initial = snapshot("running");
    const approval: RunInspectionSnapshot["items"][number] = {
      key: "node:approval",
      role: "instance",
      path: ["approval"],
      label: "approval",
      kind: "signal",
      status: "awaiting",
      nodeKey: "approval~abc",
      signal: { target: "approval~abc", schemaSummary: "{ ok: boolean }" },
    };
    runtime.followRunInspection.mockImplementation(() => emissions([
      { schemaVersion: 1, kind: "snapshot", cursor: cursor(1), document: initial },
      {
        schemaVersion: 1,
        kind: "update",
        cursor: cursor(2),
        run: runSummary("running"),
        changes: [{
          sequence: 2,
          at: "2026-07-11T00:00:01.000Z",
          entity: { kind: "signal", id: "approval~abc", nodeId: "approval" },
          subject: "approval",
          itemKey: approval.key,
          action: "awaiting",
          status: "awaiting",
        }],
        patch: {
          upsertItems: [approval],
          removeItemKeys: ["work"],
          itemOrder: [approval.key],
          actions: [{ kind: "signal", target: "approval~abc", itemKey: approval.key, schemaSummary: "{ ok: boolean }" }],
        },
      },
      { schemaVersion: 1, kind: "done", cursor: cursor(3), run: runSummary("completed"), output: {} },
    ]));
    const stdout = new CaptureStream();

    await followRun("/workspace", { runId: "run_1", mode: "overview" }, {
      phase: "inspect", format: "text", stdout, stderr: new CaptureStream(),
    });

    expect(stdout.text).toContain("+1s  approval  awaiting\n  Signal: acpus runs signal run_1 --target approval~abc --payload '<json>'\n");
  });

  it("appends inspect and recovery commands immediately after failed and timed-out pipe transitions", async () => {
    const initial = snapshot("running");
    const failed: RunInspectionSnapshot["items"][number] = {
      key: "scope:batch:0",
      role: "context",
      path: ["batch", "item[0]"],
      label: "item[0]",
      kind: "fanout_item",
      status: "failed",
      frameKey: "batch~abc:item:0",
      failure: { origin: "scheduler", code: "expression_failed", message: "Item output failed." },
      scope: { kind: "fanout_item", itemIndex: 0, empty: true },
    };
    const timedOut: RunInspectionSnapshot["items"][number] = {
      key: "node:approval",
      role: "instance",
      path: ["approval"],
      label: "approval",
      kind: "signal",
      status: "timed_out",
      failure: { origin: "scheduler", code: "signal_timeout", message: "Approval timed out." },
    };
    runtime.followRunInspection.mockImplementation(() => emissions([
      { schemaVersion: 1, kind: "snapshot", cursor: cursor(1), document: initial },
      {
        schemaVersion: 1,
        kind: "update",
        cursor: cursor(3),
        run: runSummary("running"),
        changes: [{
          sequence: 2,
          at: "2026-07-11T00:00:01.000Z",
          entity: { kind: "frame", id: "batch~abc:item:0", nodeId: "batch" },
          subject: "batch › item[0]",
          itemKey: failed.key,
          action: "failed",
          status: "failed",
        }, {
          sequence: 3,
          at: "2026-07-11T00:00:01.100Z",
          entity: { kind: "signal", id: "approval~abc", nodeId: "approval" },
          subject: "approval",
          itemKey: timedOut.key,
          action: "timed_out",
          status: "timed_out",
        }],
        patch: {
          upsertItems: [failed, timedOut],
          removeItemKeys: ["work"],
          itemOrder: [failed.key, timedOut.key],
          actions: [
            { kind: "inspect-target", target: "batch~abc:item:0", itemKey: failed.key },
            { kind: "inspect-target", target: "approval~abc", itemKey: timedOut.key },
            { kind: "retry", target: "approval~abc", itemKey: timedOut.key },
            { kind: "fork" },
          ],
        },
      },
      { schemaVersion: 1, kind: "done", cursor: cursor(4), run: runSummary("completed"), output: {} },
    ]));
    const stdout = new CaptureStream();

    await followRun("/workspace", { runId: "run_1", mode: "overview" }, {
      phase: "inspect", format: "text", stdout, stderr: new CaptureStream(),
    });

    expect(stdout.text).toContain("+1s  batch › item[0]  failed  Error (scheduler expression_failed): Item output failed.\n  Inspect: acpus runs inspect run_1 --target batch~abc:item:0\n");
    expect(stdout.text).toContain("+1.1s  approval  timed-out  Error (scheduler signal_timeout): Approval timed out.\n  Inspect: acpus runs inspect run_1 --target approval~abc\n  Retry: acpus runs retry run_1 --target approval~abc\n");
    expect(stdout.text).toContain("  Fork: acpus runs fork run_1\n");
  });

  it("appends authored Agent identity and rich progress for pipe consumers", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-07-11T00:00:02.000Z"));
    const initial = agentSnapshot({
      turnCount: 1,
      lastActivityAt: "2026-07-11T00:00:00.500Z",
      tokenUsage: { totalTokens: 1_000 },
      tools: { totalCallCount: 1, recent: [{ command: "Read", status: "completed" }] },
    });
    const current = {
      ...initial.items[0]!,
      agent: {
        ...initial.items[0]!.agent!,
        turnCount: 2,
        lastActivityAt: "2026-07-11T00:00:01.800Z",
        context: { used: 26_100, size: 200_000 },
        tokenUsage: { inputTokens: 51_800, outputTokens: 205, totalTokens: 52_005 },
        tools: { totalCallCount: 2, recent: [{ command: "Read", status: "completed" }, { command: "Bash: rg", status: "running" }] },
      },
    };
    runtime.followRunInspection.mockImplementation(() => emissions([
      { schemaVersion: 1, kind: "snapshot", cursor: cursor(1), document: initial },
      {
        schemaVersion: 1,
        kind: "update",
        cursor: { eventSequence: 1, progressVersion: 2 },
        run: runSummary("running"),
        changes: [{ progressVersion: 2, at: "2026-07-11T00:00:02.000Z", entity: { kind: "progress", id: "observe~abc", nodeId: "observe" }, subject: "observe", itemKey: "observe~abc", action: "progress", status: "running" }],
        patch: { upsertItems: [current], removeItemKeys: [] },
      },
      { schemaVersion: 1, kind: "done", cursor: cursor(2), run: runSummary("completed"), output: {} },
    ]));
    const stdout = new CaptureStream();

    try {
      await followRun("/workspace", { runId: "run_1", mode: "overview" }, {
      phase: "inspect", format: "text", stdout, stderr: new CaptureStream(),
      });

      expect(stdout.text).toContain("Tree:\n┌─ ⠋ observe · agent(observer) · running");
      expect(stdout.text).toContain("Active:\n  ⠋ observe · agent(observer) · turn 1");
      expect(stdout.text).not.toContain("Last tools:");
      expect(stdout.text).toContain("+2s  observe  running  active=<1s  turn=2  tools=2[✓Read,⠋Bash:rg]  ctx=26.1k/200k  tok=52k");
      expect(stdout.text).not.toContain("claude");
    } finally {
      now.mockRestore();
    }
  });

  it("coalesces matching terminal Agent transition and progress in text without losing details", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-07-11T00:00:21.100Z"));
    const fixture = terminalAgentFixture();
    runtime.followRunInspection.mockImplementation(() => emissions([
      { schemaVersion: 1, kind: "snapshot", cursor: cursor(1), document: fixture.initial },
      {
        schemaVersion: 1,
        kind: "update",
        cursor: { eventSequence: 7, progressVersion: 6 },
        run: runSummary("completed"),
        changes: fixture.changes,
        patch: { upsertItems: [fixture.current], removeItemKeys: [] },
      },
      { schemaVersion: 1, kind: "done", cursor: { eventSequence: 7, progressVersion: 6 }, run: runSummary("completed"), output: { result: "ok" } },
    ]));
    const stdout = new CaptureStream();

    try {
      await followRun("/workspace", { runId: "run_1", mode: "overview" }, {
      phase: "inspect", format: "text", stdout, stderr: new CaptureStream(),
      });

      const terminalLines = stdout.text.split("\n").filter(line => line.includes("observe  completed"));
      expect(terminalLines).toEqual([
        "+21s  observe  completed  attempt=1  active=<1s  turn=1  tools=1[✓Bash:ls]  ctx=26.1k/200k  tok=52.1k  stop=end_turn  lifecycle complete · final progress",
      ]);
      expect(stdout.text).not.toMatch(/(?:^|\n)(?:#7|p6) /);
      expect(stdout.text.match(/"result": "ok"/g)).toHaveLength(1);
    } finally {
      now.mockRestore();
    }
  });

  it("does not coalesce different Agent instances, statuses, or non-terminal progress", async () => {
    const first = terminalAgentFixture();
    const second = {
      ...first.current,
      key: "observe~other",
      nodeKey: "observe~other",
      agent: { ...first.current.agent!, key: "other" },
    };
    const initial = { ...first.initial, items: [first.initial.items[0]!, { ...second, status: "running" as const }] };
    const changes: RunInspectionChange[] = [
      first.changes[0]!,
      { ...first.changes[1]!, itemKey: second.key, entity: { kind: "progress", id: second.nodeKey!, nodeId: "observe" }, subject: "observe" },
      { ...first.changes[1]!, status: "failed", message: "different terminal status" },
      { ...first.changes[1]!, status: "running", message: "non-terminal progress" },
    ];
    runtime.followRunInspection.mockImplementation(() => emissions([
      { schemaVersion: 1, kind: "snapshot", cursor: cursor(1), document: initial },
      {
        schemaVersion: 1,
        kind: "update",
        cursor: { eventSequence: 7, progressVersion: 6 },
        run: runSummary("running"),
        changes,
        patch: { upsertItems: [first.current, second], removeItemKeys: [] },
      },
      { schemaVersion: 1, kind: "done", cursor: { eventSequence: 7, progressVersion: 6 }, run: runSummary("completed"), output: {} },
    ]));
    const stdout = new CaptureStream();

    await followRun("/workspace", { runId: "run_1", mode: "all" }, {
      phase: "inspect", format: "text", stdout, stderr: new CaptureStream(),
    });

    expect(stdout.text.split("\n").filter(line => line.startsWith("+21s  observe"))).toHaveLength(4);
    expect(stdout.text).toContain("different terminal status");
    expect(stdout.text).toContain("non-terminal progress");
  });

  it("keeps terminal transition and progress as separate exact NDJSON changes", async () => {
    const fixture = terminalAgentFixture();
    runtime.followRunInspection.mockImplementation(() => emissions([
      { schemaVersion: 1, kind: "snapshot", cursor: cursor(1), document: fixture.initial },
      {
        schemaVersion: 1,
        kind: "update",
        cursor: { eventSequence: 7, progressVersion: 6 },
        run: runSummary("completed"),
        changes: fixture.changes,
        patch: { upsertItems: [fixture.current], removeItemKeys: [] },
      },
      { schemaVersion: 1, kind: "done", cursor: { eventSequence: 7, progressVersion: 6 }, run: runSummary("completed"), output: { result: "ok" } },
    ]));
    const stdout = new CaptureStream();

    await followRun("/workspace", { runId: "run_1", mode: "overview" }, {
      phase: "inspect", format: "ndjson", stdout, stderr: new CaptureStream(),
    });

    const records = stdout.text.trim().split("\n").map(line => JSON.parse(line));
    expect(records[1].changes).toEqual([
      expect.objectContaining({ sequence: 7, action: "completed" }),
      expect.objectContaining({ progressVersion: 6, action: "progress" }),
    ]);
    expect(records.filter(record => record.output !== undefined)).toHaveLength(1);
  });

  it("forwards every inspection mode and target follow interval to runtime", async () => {
    const oneShotCases = [
      { argv: ["inspect", "run_1"], query: { runId: "run_1", mode: "overview" } },
      { argv: ["inspect", "run_1", "--all"], query: { runId: "run_1", mode: "all" } },
      { argv: ["inspect", "run_1", "--target", "observe"], query: { runId: "run_1", mode: "target", target: "observe" } },
      { argv: ["inspect", "run_1", "--raw"], query: { runId: "run_1", mode: "raw" } },
    ] as const;

    for (const testCase of oneShotCases) {
      runtime.getRunInspection.mockClear();
      const result = await runRunsCommand(testCase.argv);
      expect(result.exitCode).toBe(0);
      expect(runtime.getRunInspection).toHaveBeenCalledOnce();
      expect(runtime.getRunInspection).toHaveBeenCalledWith("/workspace", testCase.query);
    }

    runtime.followRunInspection.mockImplementation(() => emissions([
      { schemaVersion: 1, kind: "snapshot", cursor: cursor(1), document: targetDocument(snapshot("running")) },
      { schemaVersion: 1, kind: "done", cursor: cursor(2), run: runSummary("completed"), output: {} },
    ]));
    const followed = await runRunsCommand(["inspect", "run_1", "--target", "observe", "--follow", "--interval", "250ms"]);

    expect(followed.exitCode).toBe(0);
    expect(runtime.followRunInspection).toHaveBeenCalledWith("/workspace", expect.objectContaining({
      runId: "run_1",
      mode: "target",
      target: "observe",
      intervalMs: 250,
      signal: expect.any(AbortSignal),
    }));
  });

  it("bounds a large overview transcript by unique context while preserving actionable contexts", async () => {
    const ordinary = fanoutChanges(200);
    const actionable = actionableFanoutChanges(ordinary.length + 2);
    runtime.followRunInspection.mockImplementation(() => emissions([
      { schemaVersion: 1, kind: "snapshot", cursor: cursor(1), document: snapshot("running") },
      {
        schemaVersion: 1,
        kind: "update",
        cursor: cursor(1 + ordinary.length + actionable.length),
        run: runSummary("running"),
        changes: [...ordinary, ...actionable],
        patch: { upsertItems: [], removeItemKeys: [] },
      },
      { schemaVersion: 1, kind: "done", cursor: cursor(2 + ordinary.length + actionable.length), run: runSummary("completed"), output: { result: "ok" } },
    ]));
    const stdout = new CaptureStream();

    await followRun("/workspace", { runId: "run_1", mode: "overview" }, {
      phase: "inspect", format: "text", stdout, stderr: new CaptureStream(),
    });

    expect(stdout.text.match(/^\+\S+/gm)).toHaveLength(72);
    expect(stdout.text).toContain("batch[0] › work  ready");
    expect(stdout.text).toContain("batch[19] › work  completed");
    expect(stdout.text).not.toContain("batch[20] › work");
    expect(stdout.text).toContain("batch[200] › work (work~failed)  failed");
    expect(stdout.text).toContain("batch[201] › work (work~timed)  timed-out");
    expect(stdout.text).toContain("batch[202] › work (work~awaiting)  awaiting");
    expect(stdout.text).toContain("batch[203] › work (work~retry)  retrying  attempt=2");
    expect(stdout.text).toContain("… 180 contexts omitted (completed=180)  More: acpus runs inspect run_1 --all --follow");
    expect(stdout.text.match(/"result": "ok"/g)).toHaveLength(1);
  });

  it("emits the first omission immediately, coalesces by context, and flushes after thirty seconds", async () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-07-11T00:00:00.000Z");
    let release!: () => void;
    const released = new Promise<void>(resolve => {
      release = resolve;
    });
    runtime.followRunInspection.mockImplementation(async function* () {
      yield okResult({ schemaVersion: 1, kind: "snapshot", cursor: cursor(1), document: snapshot("running") } as const);
      yield okResult({
        schemaVersion: 1,
        kind: "update",
        cursor: cursor(26),
        run: runSummary("running"),
        changes: fanoutChanges(25).filter(change => change.action === "completed"),
        patch: { upsertItems: [], removeItemKeys: [] },
      } as const);
      vi.setSystemTime("2026-07-11T00:00:01.000Z");
      yield okResult({
        schemaVersion: 1,
        kind: "update",
        cursor: cursor(31),
        run: runSummary("running"),
        changes: fanoutChanges(5, 20).filter(change => change.action === "ready"),
        patch: { upsertItems: [], removeItemKeys: [] },
      } as const);
      await released;
      yield okResult({ schemaVersion: 1, kind: "done", cursor: cursor(32), run: runSummary("completed"), output: {} } as const);
    });
    const stdout = new CaptureStream();

    try {
      const followed = followRun("/workspace", { runId: "run_1", mode: "overview" }, {
      phase: "inspect", format: "text", stdout, stderr: new CaptureStream(),
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

  it("flushes a pending omission before terminal output", async () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-07-11T00:00:00.000Z");
    runtime.followRunInspection.mockImplementation(() => emissions([
      { schemaVersion: 1, kind: "snapshot", cursor: cursor(1), document: snapshot("running") },
      {
        schemaVersion: 1,
        kind: "update",
        cursor: cursor(26),
        run: runSummary("running"),
        changes: fanoutChanges(25).filter(change => change.action === "completed"),
        patch: { upsertItems: [], removeItemKeys: [] },
      },
      {
        schemaVersion: 1,
        kind: "update",
        cursor: cursor(31),
        run: runSummary("running"),
        changes: fanoutChanges(5, 20).filter(change => change.action === "started"),
        patch: { upsertItems: [], removeItemKeys: [] },
      },
      { schemaVersion: 1, kind: "done", cursor: cursor(32), run: runSummary("completed"), output: {} },
    ]));
    const stdout = new CaptureStream();

    try {
      await followRun("/workspace", { runId: "run_1", mode: "overview" }, {
      phase: "inspect", format: "text", stdout, stderr: new CaptureStream(),
      });
      expect(stdout.text.match(/contexts omitted/g)).toHaveLength(2);
      expect(stdout.text).toContain("… 5 contexts omitted (running=5)");
      expect(stdout.text.indexOf("running=5")).toBeLessThan(stdout.text.lastIndexOf("Run run_1  workflow  completed"));
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops a pending omission when the same context emits a protected change", async () => {
    const initial = snapshot("running");
    initial.items = Array.from({ length: 20 }, (_, index) => ({
      key: `instance:work~${index}`,
      role: "instance" as const,
      path: [`batch[${index}]`, "work"],
      label: "work",
      kind: "task",
      status: "running" as const,
      nodeId: "work",
      nodeKey: `work~${index}`,
    }));
    const transitions = fanoutChanges(1, 20);
    const completed = transitions.find(change => change.action === "completed")!;
    const running = transitions.find(change => change.action === "started")!;
    const failed: RunInspectionChange = { ...completed, sequence: 9, action: "failed", status: "failed" };
    runtime.followRunInspection.mockImplementation(() => emissions([
      { schemaVersion: 1, kind: "snapshot", cursor: cursor(1), document: initial },
      { schemaVersion: 1, kind: "update", cursor: cursor(2), run: runSummary("running"), changes: [completed], patch: { upsertItems: [], removeItemKeys: [] } },
      { schemaVersion: 1, kind: "update", cursor: cursor(3), run: runSummary("running"), changes: [running], patch: { upsertItems: [], removeItemKeys: [] } },
      { schemaVersion: 1, kind: "update", cursor: cursor(4), run: runSummary("running"), changes: [failed], patch: { upsertItems: [], removeItemKeys: [] } },
      { schemaVersion: 1, kind: "done", cursor: cursor(5), run: runSummary("completed"), output: {} },
    ]));
    const stdout = new CaptureStream();

    await followRun("/workspace", { runId: "run_1", mode: "overview" }, {
      phase: "inspect", format: "text", stdout, stderr: new CaptureStream(),
    });

    expect(stdout.text).toContain("batch[20] › work  failed");
    expect(stdout.text.match(/contexts omitted/g)).toHaveLength(1);
    expect(stdout.text).not.toContain("contexts omitted (running=1)");
  });

  it("counts dynamic contexts already shown in the compact baseline", async () => {
    const initial = snapshot("running");
    initial.items = Array.from({ length: 20 }, (_, index) => ({
      key: `instance:work~${index}`,
      role: "instance" as const,
      path: [`batch[${index}]`, "work"],
      label: "work",
      kind: "task",
      status: "running" as const,
      nodeId: "work",
      nodeKey: `work~${index}`,
    }));
    const changes = fanoutChanges(2, 20);
    runtime.followRunInspection.mockImplementation(() => emissions([
      { schemaVersion: 1, kind: "snapshot", cursor: cursor(1), document: initial },
      {
        schemaVersion: 1,
        kind: "update",
        cursor: cursor(1 + changes.length),
        run: runSummary("running"),
        changes,
        patch: { upsertItems: [], removeItemKeys: [] },
      },
      { schemaVersion: 1, kind: "done", cursor: cursor(2 + changes.length), run: runSummary("completed"), output: {} },
    ]));
    const stdout = new CaptureStream();

    await followRun("/workspace", { runId: "run_1", mode: "overview" }, {
      phase: "inspect", format: "text", stdout, stderr: new CaptureStream(),
    });

    expect(stdout.text).not.toMatch(/^(?:#\d+|p\d+) /m);
    expect(stdout.text).toContain("… 2 contexts omitted (completed=2)  More: acpus runs inspect run_1 --all --follow");
  });

  it("always retains the bounded runtime summary for Agent progress outside the overview budget", async () => {
    const initial = snapshot("running");
    initial.items = Array.from({ length: 20 }, (_, index) => ({
      key: `instance:work~${index}`,
      role: "instance" as const,
      path: [`batch[${index}]`, "work"],
      label: "work",
      kind: "agent",
      status: "running" as const,
      nodeId: "work",
      nodeKey: `work~${index}`,
    }));
    runtime.followRunInspection.mockImplementation(() => emissions([
      { schemaVersion: 1, kind: "snapshot", cursor: cursor(1), document: initial },
      {
        schemaVersion: 1,
        kind: "update",
        cursor: { eventSequence: 1, progressVersion: 2 },
        run: runSummary("running"),
        changes: [{
          at: "2026-07-11T00:00:02.000Z",
          entity: { kind: "progress", id: "omitted-agents" },
          subject: "omitted Agents",
          action: "progress",
          progressVersion: 2,
          message: "5 changed outside the compact context budget (12 tracked)",
          summary: { kind: "omitted-agent-progress", changed: 5, tracked: 12 },
        }],
        patch: { upsertItems: [], removeItemKeys: [] },
      },
      { schemaVersion: 1, kind: "done", cursor: cursor(2), run: runSummary("completed"), output: {} },
    ]));
    const stdout = new CaptureStream();

    await followRun("/workspace", { runId: "run_1", mode: "overview" }, {
      phase: "inspect", format: "text", stdout, stderr: new CaptureStream(),
    });

    expect(stdout.text).toContain("+2s  omitted Agents  running  5 changed outside the compact context budget (12 tracked)");
    expect(stdout.text).not.toContain("contexts omitted (running=1)");
  });

  it.each(["all", "target"] as const)("does not apply the overview transcript budget to %s follow", async mode => {
    const changes = fanoutChanges(25).filter(change => change.action === "completed");
    runtime.followRunInspection.mockImplementation(() => emissions([
      { schemaVersion: 1, kind: "snapshot", cursor: cursor(1), document: snapshot("running") },
      {
        schemaVersion: 1,
        kind: "update",
        cursor: cursor(1 + changes.length),
        run: runSummary("running"),
        changes,
        patch: { upsertItems: [], removeItemKeys: [] },
      },
      { schemaVersion: 1, kind: "done", cursor: cursor(2 + changes.length), run: runSummary("completed"), output: {} },
    ]));
    const stdout = new CaptureStream();
    const query: FollowRunInspectionQuery = mode === "target"
      ? { runId: "run_1", mode, target: "work" }
      : { runId: "run_1", mode };

    await followRun("/workspace", query, {
      phase: "inspect", format: "text", stdout, stderr: new CaptureStream(),
    });

    expect(stdout.text.match(/^\+\S+/gm)).toHaveLength(25);
    expect(stdout.text).toContain("batch[24] › work  completed");
    expect(stdout.text).not.toContain("contexts omitted");
  });

  it("prints a bounded text checkpoint after thirty seconds of pipe silence", async () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-07-11T00:00:00.000Z");
    let release!: () => void;
    const released = new Promise<void>(resolve => {
      release = resolve;
    });
    runtime.followRunInspection.mockImplementation(() => checkpointEmissions(released));
    runtime.getRunInspection.mockResolvedValue(okResult(agentSnapshot({
      model: "codex",
      turnCount: 2,
      lastActivityAt: "2026-07-11T00:00:29.500Z",
      context: { used: 12_500, size: 200_000 },
      tokenUsage: { inputTokens: 1_000, outputTokens: 500, totalTokens: 1_500 },
      tools: { totalCallCount: 1, recent: [{ command: "Bash: rg", status: "running" }] },
    })));
    const stdout = new CaptureStream();
    try {
      const followed = followRun("/workspace", { runId: "run_1", mode: "overview" }, {
      phase: "inspect", format: "text", stdout, stderr: new CaptureStream(),
      });
      await vi.advanceTimersByTimeAsync(30_000);
      expect(stdout.text.match(/· checkpoint/g)).toHaveLength(1);
      expect(stdout.text).toContain("· checkpoint +30s  running  running=1");
      expect(stdout.text).toContain("observe  turn 2 · ⠋ Bash: rg · updated <1s ago");
      expect(stdout.text).not.toContain("active=");
      expect(stdout.text).not.toContain("tools=");
      expect(stdout.text).not.toContain("ctx=");
      expect(stdout.text).not.toContain("tok=");
      expect(stdout.text).not.toContain("codex");
      release();
      await vi.advanceTimersByTimeAsync(0);
      await followed;
    } finally {
      vi.useRealTimers();
    }
  });

  it("redraws only the live TTY region and preserves output once", async () => {
    runtime.followRunInspection.mockImplementation(() => emissions([
      { schemaVersion: 1, kind: "snapshot", cursor: cursor(1), document: snapshot("running") },
      {
        schemaVersion: 1,
        kind: "update",
        cursor: cursor(2),
        run: runSummary("running"),
        changes: [{ progressVersion: 2, at: "2026-07-11T00:00:01.000Z", entity: { kind: "progress", id: "work~abc" }, subject: "work", action: "progress", status: "running" }],
        patch: { upsertItems: [], removeItemKeys: [] },
      },
      { schemaVersion: 1, kind: "done", cursor: cursor(3), run: runSummary("completed"), output: { result: "ok" } },
    ]));
    const stdout = new TtyCaptureStream();

    await followRun("/workspace", { runId: "run_1", mode: "overview" }, {
      phase: "inspect", format: "text", stdout, stderr: new CaptureStream(),
    });

    expect(stdout.text).toContain("\x1b[");
    expect(stdout.text).not.toContain("\x1b[2J");
    expect(stdout.text.match(/"result": "ok"/g)).toHaveLength(1);
  });

  it("redraws the compact Agent pulse in a TTY overview", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-07-11T00:00:02.000Z"));
    const initial = agentSnapshot({
      turnCount: 1,
      lastActivityAt: "2026-07-11T00:00:00.500Z",
      tools: { totalCallCount: 1, recent: [{ command: "Read", status: "completed" }] },
    });
    const current = {
      ...initial.items[0]!,
      agent: {
        ...initial.items[0]!.agent!,
        turnCount: 2,
        lastActivityAt: "2026-07-11T00:00:01.500Z",
        tools: { totalCallCount: 2, recent: [{ command: "Read", status: "completed" }, { command: "Bash: rg", status: "running" }] },
      },
    };
    runtime.followRunInspection.mockImplementation(() => emissions([
      { schemaVersion: 1, kind: "snapshot", cursor: cursor(1), document: initial },
      {
        schemaVersion: 1,
        kind: "update",
        cursor: { eventSequence: 1, progressVersion: 2 },
        run: runSummary("running"),
        changes: [{ progressVersion: 2, at: "2026-07-11T00:00:01.500Z", entity: { kind: "progress", id: "observe~abc", nodeId: "observe" }, subject: "observe", itemKey: "observe~abc", action: "progress", status: "running" }],
        patch: { upsertItems: [current], removeItemKeys: [] },
      },
      { schemaVersion: 1, kind: "done", cursor: cursor(2), run: runSummary("completed"), output: {} },
    ]));
    const stdout = new TtyCaptureStream();

    try {
      await followRun("/workspace", { runId: "run_1", mode: "overview" }, {
        phase: "inspect", format: "text", stdout, stderr: new CaptureStream(),
      });

      expect(stdout.text).toContain("Active:\n  ⠋ observe · agent(observer) · turn 2 · ⠋ Bash: rg · updated <1s ago");
      expect(stdout.text).not.toContain("agent(observer) · running · ⠋ Bash: rg");
      expect(stdout.text).not.toContain("Context:");
      expect(stdout.text).not.toContain("Tokens:");
    } finally {
      now.mockRestore();
    }
  });

  it("keeps one coalesced terminal Agent row in TTY target change history", async () => {
    const fixture = terminalAgentFixture();
    runtime.followRunInspection.mockImplementation(() => emissions([
      { schemaVersion: 1, kind: "snapshot", cursor: cursor(1), document: targetDocument(fixture.initial) },
      {
        schemaVersion: 1,
        kind: "update",
        cursor: { eventSequence: 7, progressVersion: 6 },
        run: runSummary("completed"),
        changes: fixture.changes,
        patch: { upsertItems: [fixture.current], removeItemKeys: [] },
      },
      { schemaVersion: 1, kind: "done", cursor: { eventSequence: 7, progressVersion: 6 }, run: runSummary("completed"), output: {} },
    ]));
    const stdout = new TtyCaptureStream();

    await followRun("/workspace", { runId: "run_1", mode: "target", target: "observe" }, {
      phase: "inspect", format: "text", stdout, stderr: new CaptureStream(),
    });

    const finalFrame = stdout.text.split("\x1b[J").at(-1)!;
    expect(finalFrame.split("\n").filter(line => line.includes("observe  completed"))).toHaveLength(1);
    expect(finalFrame).not.toMatch(/(?:#7|p6) /);
  });

  it("detaches on Ctrl-C without inventing an NDJSON emission", async () => {
    let release!: () => void;
    const released = new Promise<void>(resolve => {
      release = resolve;
    });
    runtime.followRunInspection.mockImplementation(() => blockedEmissions(released));
    const stdout = new SnapshotCaptureStream();
    const stderr = new CaptureStream();
    const followed = followRun("/workspace", { runId: "run_1", mode: "overview" }, {
      phase: "run", format: "ndjson", stdout, stderr,
    });
    await stdout.snapshotWritten;
    expect(stdout.text).toContain('"kind":"snapshot"');

    process.emit("SIGINT");
    release();
    const outcome = await followed;

    expect(outcome).toEqual({ kind: "detached" });
    expect(stdout.text.trim().split("\n").map(line => JSON.parse(line).kind)).toEqual(["snapshot"]);
    expect(stderr.text).toContain("Detached from run run_1");
    expect(stderr.text).toContain("acpus runs cancel run_1");
  });

  it("emits versioned machine-readable follow errors", async () => {
    runtime.followRunInspection.mockImplementation(async function* () {
      yield {
        isErr: () => true as const,
        isOk: () => false as const,
        error: { type: "run-not-found", runId: "run_1", message: "Run was deleted." },
      };
    });
    const stdout = new CaptureStream();

    const outcome = await followRun("/workspace", { runId: "run_1", mode: "overview" }, {
      phase: "inspect", format: "ndjson", stdout, stderr: new CaptureStream(),
    });

    expect(outcome).toMatchObject({ kind: "error", error: { type: "run-not-found" } });
    expect(JSON.parse(stdout.text)).toMatchObject({ schemaVersion: 1, ok: false, phase: "inspect", kind: "error", error: { type: "run-not-found" } });
  });
});

async function runRunsCommand(argv: readonly string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
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

  await command.parseAsync([...argv, "--json"], { from: "user" });
  return { exitCode, stdout: stdout.text, stderr: stderr.text };
}

class TtyCaptureStream extends CaptureStream {
  readonly isTTY = true;
}

class SnapshotCaptureStream extends CaptureStream {
  private resolveSnapshot!: () => void;
  readonly snapshotWritten = new Promise<void>(resolve => {
    this.resolveSnapshot = resolve;
  });

  override _write(chunk: Buffer | string, encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    super._write(chunk, encoding, error => {
      if (this.text.includes('"kind":"snapshot"')) this.resolveSnapshot();
      callback(error);
    });
  }
}

async function* emissions(values: RunInspectionEmission[]): AsyncIterable<ReturnType<typeof okResult>> {
  for (const value of values) yield okResult(value);
}

async function* blockedEmissions(release: Promise<void>): AsyncIterable<ReturnType<typeof okResult>> {
  yield okResult({ schemaVersion: 1, kind: "snapshot", cursor: cursor(1), document: snapshot("running") });
  await release;
}

async function* checkpointEmissions(release: Promise<void>): AsyncIterable<ReturnType<typeof okResult>> {
  yield okResult({ schemaVersion: 1, kind: "snapshot", cursor: cursor(1), document: snapshot("running") });
  await release;
  yield okResult({ schemaVersion: 1, kind: "done", cursor: cursor(2), run: runSummary("completed"), output: {} });
}

function okResult<T>(value: T) {
  return { isErr: () => false as const, isOk: () => true as const, value };
}

function cursor(eventSequence: number) {
  return { eventSequence, progressVersion: 0 };
}

function fanoutChanges(contextCount: number, startIndex = 0): RunInspectionChange[] {
  return Array.from({ length: contextCount }, (_, offset) => {
    const index = startIndex + offset;
    return ["ready", "started", "completed"].map((action, transition) => ({
      sequence: 2 + offset * 3 + transition,
      at: `2026-07-11T00:00:0${transition + 1}.000Z`,
      entity: { kind: "node" as const, id: `work~${index}`, nodeId: "work" },
      subject: `batch[${index}] › work`,
      action: action as "ready" | "started" | "completed",
      status: action === "ready" ? "ready" as const : action === "started" ? "running" as const : "completed" as const,
    }));
  }).flat();
}

function actionableFanoutChanges(sequence: number): RunInspectionChange[] {
  const contexts = [
    { index: 200, id: "work~failed", kind: "node" as const, action: "failed" as const, status: "failed" as const },
    { index: 201, id: "work~timed", kind: "node" as const, action: "timed_out" as const, status: "timed_out" as const },
    { index: 202, id: "work~awaiting", kind: "signal" as const, action: "awaiting" as const, status: "awaiting" as const },
    { index: 203, id: "work~retry", kind: "attempt" as const, action: "retrying" as const, status: "pending" as const },
  ];
  return contexts.flatMap((context, index) => [{
    sequence: sequence + index * 3,
    at: "2026-07-11T00:00:02.000Z",
    entity: { kind: context.kind, id: context.id, nodeId: "work" },
    subject: `batch[${context.index}] › work (${context.id})`,
    action: "ready" as const,
    status: "ready" as const,
    ...(context.action === "retrying" ? { attemptNo: 2 } : {}),
  }, {
    sequence: sequence + index * 3 + 1,
    at: "2026-07-11T00:00:03.000Z",
    entity: { kind: context.kind, id: context.id, nodeId: "work" },
    subject: `batch[${context.index}] › work (${context.id})`,
    action: "started" as const,
    status: "running" as const,
    ...(context.action === "retrying" ? { attemptNo: 2 } : {}),
  }, {
    sequence: sequence + index * 3 + 2,
    at: "2026-07-11T00:00:04.000Z",
    entity: { kind: context.kind, id: context.id, nodeId: "work" },
    subject: `batch[${context.index}] › work (${context.id})`,
    action: context.action,
    status: context.status,
    ...(context.action === "retrying" ? { attemptNo: 2 } : {}),
  }]);
}

function runSummary(status: "running" | "completed"): RunInspectionSnapshot["run"] {
  return {
    id: "run_1",
    name: "workflow",
    status,
    workflowEntry: "workflow.ts",
    createdAt: "2026-07-11T00:00:00.000Z",
    updatedAt: "2026-07-11T00:00:02.000Z",
    durationMs: 2_000,
    execution: status === "completed" ? { state: "terminal", lastStatus: status, reason: "terminal" } : { state: "active", lastStatus: status, reason: "daemon_alive" },
  };
}

function failedRunSummary(): RunInspectionSnapshot["run"] {
  return {
    ...runSummary("completed"),
    status: "failed",
    execution: { state: "terminal", lastStatus: "failed", reason: "terminal" },
    failure: { origin: "scheduler", code: "root_failed", message: "Workflow output failed." },
  };
}

function snapshot(status: "running" | "completed"): RunInspectionSnapshot {
  return {
    schemaVersion: 1,
    kind: "snapshot",
    cursor: cursor(1),
    run: runSummary(status),
    counts: { total: 1, ...(status === "running" ? { running: 1 } : { completed: 1 }) },
    items: [{ key: "work", role: "static", path: ["work"], label: "work", kind: "task", status }],
    actions: [],
  };
}

function agentSnapshot(agent: Omit<NonNullable<RunInspectionSnapshot["items"][number]["agent"]>, "key" | "backend" | "availability">): RunInspectionSnapshot {
  return {
    ...snapshot("running"),
    items: [{
      key: "observe~abc",
      role: "instance",
      path: ["observe"],
      label: "observe",
      kind: "agent",
      status: "running",
      nodeId: "observe",
      nodeKey: "observe~abc",
      agent: {
        key: "observer",
        backend: { kind: "use", name: "claude" },
        availability: {
          context: agent.context ? "available" : "unavailable",
          tokenUsage: agent.tokenUsage?.totalTokens !== undefined ? "available" : agent.tokenUsage ? "partial" : "unavailable",
        },
        ...agent,
      },
    }],
  };
}

function terminalAgentFixture(): {
  initial: RunInspectionSnapshot;
  current: RunInspectionSnapshot["items"][number];
  changes: RunInspectionChange[];
} {
  const initial = agentSnapshot({
    turnCount: 1,
    lastActivityAt: "2026-07-11T00:00:00.500Z",
    tools: { totalCallCount: 0, recent: [] },
  });
  const current: RunInspectionSnapshot["items"][number] = {
    ...initial.items[0]!,
    status: "completed",
    attemptNo: 1,
    agent: {
      ...initial.items[0]!.agent!,
      turnCount: 1,
      lastActivityAt: "2026-07-11T00:00:20.900Z",
      context: { used: 26_100, size: 200_000 },
      tokenUsage: { inputTokens: 51_800, outputTokens: 300, totalTokens: 52_100 },
      tools: { totalCallCount: 1, recent: [{ command: "Bash: ls", status: "completed" }] },
      stopReason: "end_turn",
    },
  };
  return {
    initial,
    current,
    changes: [{
      sequence: 7,
      at: "2026-07-11T00:00:21.000Z",
      entity: { kind: "node", id: "observe~abc", nodeId: "observe" },
      subject: "observe",
      itemKey: "observe~abc",
      action: "completed",
      status: "completed",
      message: "lifecycle complete",
    }, {
      progressVersion: 6,
      at: "2026-07-11T00:00:21.100Z",
      entity: { kind: "progress", id: "observe~abc", nodeId: "observe" },
      subject: "observe",
      itemKey: "observe~abc",
      action: "progress",
      status: "completed",
      attemptNo: 1,
      message: "final progress",
    }],
  };
}

function targetDocument(snapshot: RunInspectionSnapshot): RunInspectionTargetDocument {
  return {
    schemaVersion: 1,
    kind: "target",
    cursor: snapshot.cursor,
    run: snapshot.run,
    target: { kind: "static-node", id: "observe" },
    summary: {
      targetKind: "static-node",
      targetId: "observe",
      runStatus: snapshot.run.status,
      runStartedAt: snapshot.run.createdAt,
      nodeId: "observe",
      nodeStatus: "running",
      artifacts: [],
    },
    items: snapshot.items,
    instances: [],
    frames: [],
    attempts: [],
    signalWaits: [],
    executionMetadata: [],
    progress: [],
    artifacts: [],
  };
}
