import { describe, expect, it } from "vitest";
import type { RunInspectionSnapshot } from "@acpus/runtime";
import { applyRunInspectionUpdate, formatRunInspectionChanges, formatRunInspectionCheckpoint, formatRunInspectionDocument, formatTerminalOutput } from "../src/run-inspection-surface.js";

describe("compact run inspection surface", () => {
  it("renders normalized nested structure, folded counts, agent status, and full terminal output", () => {
    const document = snapshot();
    const output = formatRunInspectionDocument(document, Date.parse("2026-07-11T00:00:02.000Z"));

    expect(output).toContain("Run run_1  nested  completed  2s");
    expect(output).toContain("✓ review_loop  [loop]");
    expect(output).toContain("    ✓ round 1  [loop-iteration]");
    expect(output).toContain("      ✓ review~abc  [agent]");
    expect(output).toContain("Agent: observer  turns=2  tools=4");
    expect(output).toContain("Last tools: ✓ Bash: rg · ⠋ Grep · ◆ Write generated release…");
    expect(output).toContain("Context: 12.5k/200k");
    expect(output).not.toContain("acpx");
    expect(output).toContain("… completed rounds  24 folded  completed=24");
    expect(output).toContain("More: acpus runs inspect run_1 --all");
    expect(output).toContain('"field_29": 29');
    expect(output).not.toContain("prompt text must stay out of overview");
    expect(output).not.toContain("artifacts/review/prompt.md");
  });

  it("applies semantic item updates without exposing raw runtime tables", () => {
    const document = snapshot();
    delete document.output;
    const runningItem = { ...document.items[2]! };
    delete runningItem.finishedAt;
    const updated = applyRunInspectionUpdate(document, {
      schemaVersion: 1,
      kind: "update",
      cursor: { eventSequence: 8, progressVersion: 2 },
      run: { ...document.run, status: "running", updatedAt: "2026-07-11T00:00:03.000Z" },
      changes: [],
      patch: {
        counts: { total: 2, running: 1, completed: 1 },
      upsertItems: [{
        ...runningItem,
        status: "running",
      }],
      removeItemKeys: ["fold:old"],
      itemOrder: ["review_loop", "review~abc", "review_loop:0"],
      },
    });

    expect(updated.cursor).toEqual({ eventSequence: 8, progressVersion: 2 });
    expect(updated.items.find(item => item.key === "review~abc")?.status).toBe("running");
    expect(updated.items.some(item => item.key === "fold:old")).toBe(false);
    expect(updated.items.map(item => item.key)).toEqual(["review_loop", "review~abc", "review_loop:0"]);
  });

  it("formats append-only semantic changes and terminal output independently", () => {
    const text = formatRunInspectionChanges([{
      sequence: 7,
      at: "2026-07-11T00:00:01.000Z",
      entity: { kind: "attempt", id: "attempt_2", nodeId: "review" },
      subject: "review",
      action: "started",
      status: "running",
      attemptNo: 2,
    }], {
      run: snapshot().run,
      items: [],
      nowMs: Date.parse("2026-07-11T00:00:02.000Z"),
    });

    expect(text).toBe("+1s  review  running  attempt=2\n");
    expect(formatTerminalOutput({ result: "complete" })).toContain('"result": "complete"');
    expect(formatTerminalOutput({})).toContain("{}");
    expect(formatTerminalOutput(undefined)).toBe("");
  });

  it("renders the same layered acpx failure in compact trees and non-TTY transitions", () => {
    const document = snapshot();
    const failed = {
      ...document.items[2]!,
      status: "failed" as const,
      statusReason: "provider_exit",
      failure: {
        origin: "provider" as const,
        code: "provider_exit",
        message: "failed to reload config",
        upstream: {
          source: "acpx" as const,
          operation: "sessions.ensure",
          exitCode: 1,
          code: "RUNTIME",
          origin: "cli",
          protocol: { name: "json-rpc" as const, code: -32603, message: "Internal error" },
        },
      },
    };
    document.items[2] = failed;

    const tree = formatRunInspectionDocument(document, Date.parse("2026-07-11T00:00:02.000Z"));
    const transcript = formatRunInspectionChanges([{
      sequence: 9,
      at: "2026-07-11T00:00:02.000Z",
      entity: { kind: "node", id: "review~abc", nodeId: "review" },
      subject: "review",
      itemKey: "review~abc",
      action: "failed",
      status: "failed",
      message: "failed to reload config",
    }], { run: document.run, items: [failed], nowMs: Date.parse("2026-07-11T00:00:02.000Z") });

    expect(tree).toContain("Error (provider provider_exit · acpx RUNTIME): failed to reload config");
    expect(tree).not.toContain("failed  1s  provider_exit");
    expect(transcript).toBe("+2s  review  failed  turn=2  tools=4[✓Bash:rg,⠋Grep,◆Write generated release…]  ctx=12.5k/200k  tok=1.5k  Error (provider provider_exit · acpx RUNTIME): failed to reload config\n");
  });

  it("renders rich Agent progress as a compact reconstructable transcript line", () => {
    const document = snapshot();
    const item = {
      ...document.items[2]!,
      status: "running" as const,
      agent: { ...document.items[2]!.agent!, lastActivityAt: "2026-07-11T00:00:01.400Z" },
    };
    const text = formatRunInspectionChanges([{
      progressVersion: 9,
      at: "2026-07-11T00:00:01.500Z",
      entity: { kind: "progress", id: "review~abc", nodeId: "review" },
      subject: "review~abc",
      itemKey: "review~abc",
      action: "progress",
      status: "running",
    }], {
      run: document.run,
      items: [item],
      nowMs: Date.parse("2026-07-11T00:00:02.000Z"),
    });

    expect(text).toBe("+1.5s  review~abc  running  active=<1s  turn=2  tools=4[✓Bash:rg,⠋Grep,◆Write generated release…]  ctx=12.5k/200k  tok=1.5k\n");
  });

  it("caps recent tool commands by count, word count, and visible characters", () => {
    const document = snapshot();
    document.items[2]!.agent!.tools = {
      totalCallCount: 9,
      recent: [
        { command: "hidden oldest", status: "completed" },
        { command: "one two three four", status: "completed" },
        { command: "abcdefghijklmnopqrstuvwxyz1234567890", status: "cancelled" },
        { command: "Bash: rg", status: "running" },
      ],
    };

    const text = formatRunInspectionDocument(document);
    expect(text).toContain("Last tools: ✓ one two three… · ✗ abcdefghijklmnopqrstuvwxyz12345… · ⠋ Bash: rg");
    expect(text).not.toContain("hidden oldest");
  });

  it("bounds text-only checkpoints to three actionable rows", () => {
    const document = snapshot();
    delete document.output;
    const { durationMs: _durationMs, ...run } = document.run;
    document.run = { ...run, status: "running", execution: { state: "active", lastStatus: "running", reason: "daemon_alive" } };
    document.counts = { total: 5, running: 5 };
    document.items = Array.from({ length: 5 }, (_, index) => ({
      key: `work_${index}`,
      role: "instance" as const,
      path: [`work_${index}`],
      label: `work_${index}`,
      kind: "task",
      status: "running" as const,
    }));

    const text = formatRunInspectionCheckpoint(document, Date.parse("2026-07-11T00:00:31.000Z"));
    expect(text).toContain("· checkpoint +31s  running  running=5");
    expect(text).toContain("  work_0  running");
    expect(text).toContain("  … 2 more actionable");
    expect(text).not.toContain("  work_3  running");
  });

  it("renders an actionable awaiting signal without inlining unrelated data", () => {
    const document: RunInspectionSnapshot = {
      ...snapshot(),
      run: { ...snapshot().run, status: "awaiting", execution: { state: "inactive", lastStatus: "awaiting", reason: "daemon_alive" } },
      counts: { total: 1, awaiting: 1 },
      actions: [{ kind: "signal", target: "approve~abc", schemaSummary: "{ ok: boolean }" }],
      items: [{
        key: "approve~abc",
        role: "instance",
        path: ["approve"],
        label: "approve~abc",
        kind: "signal",
        status: "awaiting",
        signal: {
          target: "approve~abc",
          promptPreview: "Approve this release?",
          schemaSummary: "{ ok: boolean }",
        },
      }],
    };
    delete document.output;
    delete document.omitted;

    const output = formatRunInspectionDocument(document, Date.parse("2026-07-11T00:00:02.000Z"));
    expect(output).toContain("⏳ approve~abc  [signal]  awaiting");
    expect(output).toContain("Prompt: Approve this release?");
    expect(output).toContain("Expected payload: { ok: boolean }");
    expect(output).toContain("acpus runs signal run_1 --target approve~abc --payload '<json>'");
  });

  it("renders compact terminal hook history", () => {
    const document = snapshot();
    document.hooks = [{
      runId: "run_1",
      eventSequence: 42,
      triggerOrder: 1,
      event: "run.completed",
      source: "project",
      sourcePath: "/workspace/.acpus/hooks.json",
      handlerId: "notify",
      definitionHash: "hash",
      status: "completed",
      exitCode: 0,
      durationMs: 120,
      triggeredAt: "2026-07-11T00:00:02.000Z",
    }];

    const output = formatRunInspectionDocument(document);
    expect(output).toContain("Hooks:");
    expect(output).toContain("completed  notify  run.completed  #42  120ms  exit=0");
  });
});

function snapshot(): RunInspectionSnapshot {
  return {
    schemaVersion: 1,
    kind: "snapshot",
    cursor: { eventSequence: 7, progressVersion: 1 },
    run: {
      id: "run_1",
      name: "nested",
      status: "completed",
      workflowEntry: "workflow.ts",
      createdAt: "2026-07-11T00:00:00.000Z",
      updatedAt: "2026-07-11T00:00:02.000Z",
      durationMs: 2_000,
      execution: { state: "terminal", lastStatus: "completed", reason: "terminal" },
    },
    counts: { total: 27, completed: 27 },
    items: [{
      key: "review_loop",
      role: "static",
      path: ["review_loop"],
      label: "review_loop",
      kind: "loop",
      status: "completed",
      nodeId: "review_loop",
      composite: { strategy: "loop", currentIteration: 24, counts: { total: 25, completed: 25 } },
    }, {
      key: "review_loop:0",
      role: "context",
      parentKey: "review_loop",
      path: ["review_loop", "round:0"],
      label: "round 1",
      kind: "loop-iteration",
      status: "completed",
    }, {
      key: "review~abc",
      role: "instance",
      parentKey: "review_loop:0",
      path: ["review_loop", "round:0", "review"],
      label: "review~abc",
      kind: "agent",
      status: "completed",
      nodeId: "review",
      nodeKey: "review~abc",
      startedAt: "2026-07-11T00:00:00.000Z",
      finishedAt: "2026-07-11T00:00:01.000Z",
      agent: {
        key: "observer",
        backend: { kind: "use", name: "claude" },
        model: "codex",
        turnCount: 2,
        context: { used: 12_500, size: 200_000 },
        tokenUsage: { inputTokens: 1_000, outputTokens: 500, totalTokens: 1_500 },
        tools: {
          totalCallCount: 4,
          recent: [
            { command: "Read", status: "completed" },
            { command: "Bash: rg", status: "completed" },
            { command: "Grep", status: "running" },
            { command: "Write generated release report", status: "failed" },
          ],
        },
      },
    }, {
      key: "fold:old",
      role: "fold",
      parentKey: "review_loop",
      path: ["review_loop", "fold:old"],
      label: "completed rounds",
      kind: "fold",
      status: "completed",
      fold: { count: 24, counts: { total: 24, completed: 24 } },
    }],
    actions: [{ kind: "inspect-all", omitted: 24 }],
    omitted: { reason: "context-limit", limit: 20, dynamicContexts: 24, counts: { total: 24, completed: 24 } },
    output: Object.fromEntries(Array.from({ length: 30 }, (_, index) => [`field_${index}`, index])),
  };
}
