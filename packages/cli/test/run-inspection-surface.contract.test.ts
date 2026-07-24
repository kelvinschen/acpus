import { describe, expect, it } from "vitest";
import type { RunInspectionSnapshot, RunInspectionTargetDocument } from "@acpus/runtime";
import { applyRunInspectionUpdate, formatRunInspectionChanges, formatRunInspectionCheckpoint, formatRunInspectionDocument, formatTerminalOutput } from "../src/run-inspection-surface.js";

describe("compact run inspection surface", () => {
  it("renders direct fork lineage and aggregate Agent usage in the run header", () => {
    const document = snapshot();
    document.run.fork = { sourceRunId: "run_source", target: "review~abc", unsafeReuse: true };
    document.run.agentUsage = { instances: 3, attempts: 4, turns: 9 };

    const output = formatRunInspectionDocument(document);

    expect(output).toContain("Fork: source=run_source  target=review~abc  unsafe-reuse");
    expect(output).toContain("Agent usage: instances=3  attempts=4  turns=9");
  });

  it("renders a static multi-instance target only as an aggregate plus discoverable instances", () => {
    const base = snapshot();
    const document: RunInspectionTargetDocument = {
      schemaVersion: 1,
      kind: "target",
      cursor: base.cursor,
      run: base.run,
      target: { kind: "static-node", id: "review" },
      summary: {
        targetKind: "static-node",
        targetId: "review",
        runStatus: "running",
        runStartedAt: base.run.createdAt,
        nodeId: "review",
        nodeStatus: "mixed",
        counts: { total: 2, running: 1, failed: 1 },
        artifacts: [],
      },
      items: [{ ...base.items[2]!, status: "running" }, { ...base.items[2]!, key: "review~def", nodeKey: "review~def", status: "failed" }],
      instances: [
        { nodeKey: "review~abc", nodeId: "review", parentFrameKey: "frame~a", status: "running", createdAt: base.run.createdAt, updatedAt: base.run.updatedAt },
        { nodeKey: "review~def", nodeId: "review", parentFrameKey: "frame~b", status: "failed", createdAt: base.run.createdAt, updatedAt: base.run.updatedAt },
      ],
      frames: [],
      attempts: [],
      signalWaits: [],
      executionMetadata: [],
      progress: [],
      artifacts: [],
    };

    const output = formatRunInspectionDocument(document);

    expect(output).toContain("Target review  [static-node]  mixed");
    expect(output).toContain("Aggregate: total=2  running=1  failed=1");
    expect(output).toContain("review~abc  running");
    expect(output).toContain("review~def  failed");
    expect(output).not.toContain("Agent: observer");
  });

  it("shows Agent identity without unavailable telemetry in the tree", () => {
    const document = snapshot();
    document.items[2]!.agent = {
      key: "observer",
      backend: { kind: "use", name: "claude" },
      availability: { context: "unavailable", tokenUsage: "unavailable" },
    };

    const output = formatRunInspectionDocument(document);

    expect(output).toContain("✓ review · agent(observer)");
    expect(output).not.toContain("unavailable");
    expect(output).not.toContain("Context:");
    expect(output).not.toContain("Tokens:");
  });

  it("renders a topology-first tree, folded contexts, and full terminal output", () => {
    const document = snapshot();
    const output = formatRunInspectionDocument(document, Date.parse("2026-07-11T00:00:02.000Z"));

    expect(output).toContain("Run run_1  nested  completed  2s");
    expect(output).toContain("Tree:\n┌─ ✓ review_loop · loop · 25 rounds");
    expect(output).toContain("├┄ ✓ round 1");
    expect(output).toContain("└─ ✓ review · agent(observer)");
    expect(output).toContain("└┄ … 24 completed rounds");
    expect(output).not.toContain("Last tools:");
    expect(output).not.toContain("Context:");
    expect(output).not.toContain("Tokens:");
    expect(output).not.toContain("acpx");
    expect(output).toContain("└┄ … 24 completed rounds");
    expect(output).toContain("More: acpus runs inspect run_1 --all");
    expect(output).toContain('"field_29": 29');
    expect(output).not.toContain("prompt text must stay out of overview");
    expect(output).not.toContain("artifacts/review/turn-001.json");
  });

  it("renders only the public absolute artifact path", () => {
    const path = "/home/user/.acpus/workspaces/0123456789abcdef0123456789abcdef/runtime/runs/run_1/artifacts/output.txt";
    const document = {
      schemaVersion: 1,
      kind: "target",
      cursor: { eventSequence: 1, progressVersion: 0 },
      run: snapshot().run,
      target: { kind: "static-node", id: "task" },
      summary: {
        targetKind: "static-node",
        targetId: "task",
        runStatus: "completed",
        runStartedAt: "2026-07-11T00:00:00.000Z",
        artifacts: [],
      },
      items: [],
      instances: [],
      frames: [],
      attempts: [],
      signalWaits: [],
      executionMetadata: [],
      progress: [],
      artifacts: [{
        id: "artifact_1",
        runId: "run_1",
        nodeKey: "task",
        attempt: 1,
        digest: "sha256:test",
        size: 4,
        path,
      }],
    } as RunInspectionTargetDocument;

    const output = formatRunInspectionDocument(document);
    expect(output).toContain(`artifact_1  ${path}`);
    expect(output).not.toContain("relativePath");
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

  it("keeps Agent tool activity out of overview trees", () => {
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
    expect(text).not.toContain("Last tools:");
    expect(text).not.toContain("one two three");
    expect(text).not.toContain("hidden oldest");
  });

  it("retains full Agent telemetry in target inspection", () => {
    const base = snapshot();
    const item = base.items[2]!;
    const document: RunInspectionTargetDocument = {
      schemaVersion: 1,
      kind: "target",
      cursor: base.cursor,
      run: base.run,
      target: { kind: "dynamic-node", id: item.nodeKey! },
      summary: {
        targetKind: "dynamic-node",
        targetId: item.nodeKey!,
        runStatus: base.run.status,
        runStartedAt: base.run.createdAt,
        nodeId: item.nodeId!,
        nodeKey: item.nodeKey!,
        nodeStatus: item.status,
        artifacts: [],
      },
      items: [item],
      instances: [],
      frames: [],
      attempts: [],
      signalWaits: [],
      executionMetadata: [],
      progress: [],
      artifacts: [],
    };

    const text = formatRunInspectionDocument(document);
    expect(text).toContain("Agent: observer  turns=2  tools=4");
    expect(text).toContain("Last tools: ✓ Bash: rg · ⠋ Grep · ◆ Write generated release…");
    expect(text).toContain("Context: 12.5k/200k");
    expect(text).toContain("Tokens: in 1k, out 500, total 1.5k");
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

  it("uses the compact Agent pulse in target checkpoints", () => {
    const base = snapshot();
    const item = {
      ...base.items[2]!,
      status: "running" as const,
      agent: {
        ...base.items[2]!.agent!,
        lastActivityAt: "2026-07-11T00:00:01.000Z",
      },
    };
    const document: RunInspectionTargetDocument = {
      schemaVersion: 1,
      kind: "target",
      cursor: base.cursor,
      run: { ...base.run, status: "running" },
      target: { kind: "dynamic-node", id: item.nodeKey! },
      summary: {
        targetKind: "dynamic-node",
        targetId: item.nodeKey!,
        runStatus: "running",
        runStartedAt: base.run.createdAt,
        nodeId: item.nodeId!,
        nodeKey: item.nodeKey!,
        nodeStatus: "running",
        artifacts: [],
      },
      items: [item],
      instances: [],
      frames: [],
      attempts: [],
      signalWaits: [],
      executionMetadata: [],
      progress: [],
      artifacts: [],
    };

    const text = formatRunInspectionCheckpoint(document, Date.parse("2026-07-11T00:00:31.000Z"));
    expect(text).toBe("· checkpoint +31s  running\n  review  turn 2 · ⠋ Grep · updated 30s ago\n");
    expect(text).not.toContain("Context:");
    expect(text).not.toContain("Tokens:");
    expect(text).not.toContain("Write generated release");
  });

  it("bounds Active to three stable tree-order leaves", () => {
    const document = snapshot();
    delete document.output;
    delete document.omitted;
    document.actions = [];
    document.items = Array.from({ length: 5 }, (_, index) => ({
      key: `node:work_${index}`,
      role: "instance" as const,
      path: [`work_${index}`],
      label: `work_${index}`,
      kind: "task",
      status: "running" as const,
    }));

    const text = formatRunInspectionDocument(document);
    const active = text.slice(text.indexOf("Active:"));
    expect(active).toContain("⠋ work_0 · task");
    expect(active).toContain("⠋ work_2 · task");
    expect(active).not.toContain("⠋ work_3 · task");
    expect(active).toContain("… 2 more running");
  });

  it("falls back to the latest Agent tool and reports missing telemetry", () => {
    const document = snapshot();
    delete document.output;
    delete document.omitted;
    document.actions = [];
    document.items = [{
      ...document.items[2]!,
      status: "running",
      agent: {
        key: "observer",
        availability: { context: "unavailable", tokenUsage: "unavailable" },
        tools: { totalCallCount: 2, recent: [{ command: "Read", status: "completed" }, { command: "Write", status: "failed" }] },
      },
    }];

    expect(formatRunInspectionDocument(document)).toContain("Active:\n  ⠋ review · agent(observer) · ◆ Write");
    document.items[0]!.agent = { key: "observer", availability: { context: "unavailable", tokenUsage: "unavailable" } };
    expect(formatRunInspectionDocument(document)).toContain("Active:\n  ⠋ review · agent(observer) · no update yet");
  });

  it("includes omitted active occurrences in the Active remainder", () => {
    const document = snapshot();
    delete document.output;
    document.items = [{
      key: "node:work",
      role: "instance",
      path: ["work"],
      label: "work",
      kind: "task",
      status: "running",
    }];
    document.omitted = { reason: "context-limit", limit: 20, dynamicContexts: 4, counts: { total: 4, running: 4 } };
    document.actions = [{ kind: "inspect-all", omitted: 4 }];

    const text = formatRunInspectionDocument(document);
    expect(text).toContain("Active:\n  ⠋ work · task\n  … 4 more running");
  });

  it("keeps scheduler cancellation reasons out of structural scope rows", () => {
    const document = snapshot();
    delete document.output;
    delete document.omitted;
    document.actions = [];
    document.items = [{
      key: "node:race",
      role: "frame",
      path: ["race"],
      label: "race",
      kind: "parallel",
      status: "completed",
    }, {
      key: "scope:race:slow",
      role: "context",
      parentKey: "node:race",
      path: ["race", "slow"],
      label: "slow",
      kind: "branch",
      status: "cancelled",
      statusReason: "race_lost",
      scope: { kind: "branch", ownerKind: "parallel", branchId: "slow", empty: false },
    }];

    const output = formatRunInspectionDocument(document);
    expect(output).toContain("└┄ ✗ slow · canceled");
    expect(output).not.toContain("race lost");
  });

  it("renders an actionable awaiting signal without inlining unrelated data", () => {
    const document: RunInspectionSnapshot = {
      ...snapshot(),
      run: { ...snapshot().run, status: "awaiting", execution: { state: "inactive", lastStatus: "awaiting", reason: "daemon_alive" } },
      counts: { total: 1, awaiting: 1 },
      actions: [{ kind: "signal", target: "approve~abc", itemKey: "approve~abc", schemaSummary: "{ ok: boolean }" }],
      items: [{
        key: "approve~abc",
        role: "instance",
        path: ["approve"],
        label: "approve",
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
    expect(output).toContain("Tree:\n┌─ ⏳ approve · signal · awaiting");
    expect(output.slice(output.indexOf("Tree:"), output.indexOf("Attention:"))).not.toContain("approve~abc");
    expect(output).toContain("Attention:\n  ⏳ approve — waiting for input");
    expect(output).toContain("Prompt: Approve this release?");
    expect(output).toContain("Expected payload: { ok: boolean }");
    expect(output).toContain("acpus runs signal run_1 --target approve~abc --payload '<json>'");
  });

  it("renders nested branch, fanout, active, and attention structure without inline telemetry", () => {
    const document: RunInspectionSnapshot = {
      ...snapshot(),
      run: {
        ...snapshot().run,
        status: "running",
        execution: { state: "active", lastStatus: "running", reason: "daemon_alive" },
      },
      counts: { total: 5, notStarted: 1, running: 2, awaiting: 1, completed: 1 },
      items: [{
        key: "node:route",
        role: "static",
        path: ["route"],
        label: "route",
        kind: "if",
        status: "completed",
      }, {
        key: "scope:route:then",
        role: "context",
        parentKey: "node:route",
        path: ["route", "then"],
        label: "then",
        kind: "branch",
        status: "completed",
        scope: { kind: "branch", ownerKind: "if", branchId: "then", selection: "selected", empty: false },
      }, {
        key: "node:primary",
        role: "instance",
        parentKey: "scope:route:then",
        path: ["route", "then", "primary_route"],
        label: "primary_route",
        kind: "task",
        status: "completed",
      }, {
        key: "scope:route:else",
        role: "context",
        parentKey: "node:route",
        path: ["route", "else"],
        label: "else",
        kind: "branch",
        status: "not_selected",
        scope: { kind: "branch", ownerKind: "if", branchId: "else", selection: "not_selected", empty: false },
      }, {
        key: "node:batch",
        role: "static",
        path: ["batch"],
        label: "batch",
        kind: "fanout",
        status: "running",
        composite: { strategy: "all", counts: { total: 2, completed: 1, running: 1 } },
      }, {
        key: "scope:batch:0",
        role: "context",
        parentKey: "node:batch",
        path: ["batch", "item[0]"],
        label: "item[0]",
        kind: "fanout-item",
        status: "completed",
        scope: { kind: "fanout_item", itemIndex: 0, empty: true },
      }, {
        key: "scope:batch:1",
        role: "context",
        parentKey: "node:batch",
        path: ["batch", "item[1]"],
        label: "item[1]",
        kind: "fanout-item",
        status: "running",
        scope: { kind: "fanout_item", itemIndex: 1, empty: false },
      }, {
        key: "node:review",
        role: "instance",
        parentKey: "scope:batch:1",
        path: ["batch", "item[1]", "review"],
        label: "review",
        kind: "agent",
        status: "running",
        agent: {
          key: "observer",
          availability: { context: "available", tokenUsage: "available" },
          turnCount: 3,
          lastActivityAt: "2026-07-11T00:00:01.400Z",
          context: { used: 90_000, size: 200_000 },
          tokenUsage: { totalTokens: 12_000 },
          tools: { totalCallCount: 8, recent: [{ command: "Read", status: "running" }, { command: "Write", status: "completed" }] },
        },
      }, {
        key: "node:approval",
        role: "instance",
        path: ["approval"],
        label: "approval",
        kind: "signal",
        status: "awaiting",
        signal: { target: "approval~abc", promptPreview: "Approve deployment?", schemaSummary: "{ ok: boolean }" },
      }, {
        key: "node:assert",
        role: "static",
        path: ["require_approval"],
        label: "require_approval",
        kind: "assert",
        status: "not_started",
      }],
      actions: [{ kind: "signal", target: "approval~abc", itemKey: "node:approval", schemaSummary: "{ ok: boolean }" }],
    };
    delete document.output;
    delete document.omitted;

    expect(formatRunInspectionDocument(document, Date.parse("2026-07-11T00:00:02.000Z"))).toBe(`Run run_1  nested  running  2s

Tree:
┌─ ✓ route · if
│  ├┄ ✓ then · selected
│  │  └─ ✓ primary_route · task
│  └┄ · else · not selected
├─ ⠋ batch · fanout · running · 2 items
│  ├┄ ✓ item[0] · empty
│  └┄ ⠋ item[1] · running
│     └─ ⠋ review · agent(observer) · running
├─ ⏳ approval · signal · awaiting
└─ ○ require_approval · assert · not started

Active:
  ⠋ batch › item[1] › review · agent(observer) · turn 3 · ⠋ Read · updated <1s ago

Attention:
  ⏳ approval — waiting for input
     Prompt: Approve deployment?
     Expected payload: { ok: boolean }
     Signal: acpus runs signal run_1 --target approval~abc --payload '<json>'
`);
  });

  it("renders terminal Signal timeout evidence with retry and fork recovery", () => {
    const document: RunInspectionSnapshot = {
      ...snapshot(),
      run: { ...snapshot().run, status: "failed", execution: { state: "terminal", lastStatus: "failed", reason: "terminal" } },
      counts: { total: 1, timedOut: 1 },
      actions: [
        { kind: "inspect-target", target: "approve~abc", itemKey: "approve~abc" },
        { kind: "retry", target: "approve~abc", itemKey: "approve~abc" },
        { kind: "fork" },
      ],
      items: [{
        key: "approve~abc",
        role: "instance",
        path: ["approve"],
        label: "approve",
        kind: "signal",
        status: "timed_out",
        statusReason: "signal_timeout",
        failure: { origin: "scheduler", code: "signal_timeout", message: "Approval timed out." },
        signal: {
          target: "approve~abc",
          deadlineAt: "2026-07-11T00:01:00.000Z",
          promptPreview: "Approve this release?",
          schemaSummary: "{ ok: boolean }",
        },
      }],
    };
    delete document.output;
    delete document.omitted;

    const output = formatRunInspectionDocument(document, Date.parse("2026-07-11T00:01:01.000Z"));
    expect(output).toContain("Error (scheduler signal_timeout): Approval timed out.");
    expect(output).toContain("Attention:");
    expect(output).not.toContain("Deadline:");
    expect(output).not.toContain("Signal wait is closed.");
    expect(output).toContain("Inspect: acpus runs inspect run_1 --target approve~abc");
    expect(output).toContain("Retry: acpus runs retry run_1 --target approve~abc");
    expect(output).toContain("Fork: acpus runs fork run_1");
    expect(output).toContain("\n  Fork: acpus runs fork run_1\n");
    expect(output).not.toContain("\n     Fork: acpus runs fork run_1\n");
    expect(output).not.toContain("Expected payload:");
    expect(output).not.toContain("acpus runs signal");
  });

  it("keeps failed context rows from suppressing the actionable owning node", () => {
    const document: RunInspectionSnapshot = {
      ...snapshot(),
      counts: { total: 1, failed: 1 },
      items: [{
        key: "node:batch",
        role: "frame",
        path: ["batch"],
        label: "batch",
        kind: "fanout",
        status: "failed",
        frameKey: "batch~abc",
        failure: { origin: "scheduler", code: "group_failed", message: "One item failed." },
      }, {
        key: "scope:batch:0",
        role: "context",
        parentKey: "node:batch",
        path: ["batch", "item[0]"],
        label: "item[0]",
        kind: "fanout_item",
        status: "failed",
        scope: { kind: "fanout_item", itemIndex: 0, empty: true },
      }],
      actions: [{ kind: "inspect-target", target: "batch~abc", itemKey: "node:batch" }],
    };
    delete document.output;
    delete document.omitted;

    const output = formatRunInspectionDocument(document);
    expect(output).toContain("◆ batch — Error (scheduler group_failed): One item failed.");
    expect(output).toContain("Inspect: acpus runs inspect run_1 --target batch~abc");
    expect(output).not.toContain("◆ batch › item[0] —");
  });

  it("surfaces a failed scope frame as the deepest actionable root cause", () => {
    const document: RunInspectionSnapshot = {
      ...snapshot(),
      counts: { total: 1, failed: 1 },
      items: [{
        key: "node:batch",
        role: "frame",
        path: ["batch"],
        label: "batch",
        kind: "fanout",
        status: "failed",
        frameKey: "batch~abc",
        failure: { origin: "scheduler", code: "group_failed", message: "An item failed." },
      }, {
        key: "scope:batch:0",
        role: "context",
        parentKey: "node:batch",
        path: ["batch", "item[0]"],
        label: "item[0]",
        kind: "fanout_item",
        status: "failed",
        frameKey: "batch~abc:item:0",
        failure: { origin: "scheduler", code: "expression_failed", message: "Item output failed." },
        scope: { kind: "fanout_item", itemIndex: 0, empty: true },
      }],
      actions: [{ kind: "inspect-target", target: "batch~abc:item:0", itemKey: "scope:batch:0" }],
    };
    delete document.output;
    delete document.omitted;

    const output = formatRunInspectionDocument(document);
    const attention = output.slice(output.indexOf("Attention:"));
    expect(attention).toContain("◆ batch › item[0] — Error (scheduler expression_failed): Item output failed.");
    expect(attention).toContain("Inspect: acpus runs inspect run_1 --target batch~abc:item:0");
    expect(attention).not.toContain("◆ batch — Error (scheduler group_failed)");
  });

  it("bounds failure previews and strips terminal control sequences from text output", () => {
    const document = snapshot();
    delete document.output;
    delete document.omitted;
    const message = `\u001b[31m${"x".repeat(300)}\u001b[0m\nnext`;
    document.items = [{
      key: "node:work",
      role: "instance",
      path: ["work"],
      label: "work",
      kind: "task",
      status: "failed",
      failure: { origin: "task", code: "task_failed", message },
    }];
    document.actions = [{ kind: "inspect-target", target: "work~abc", itemKey: "node:work" }];

    const output = formatRunInspectionDocument(document);
    const detail = output.split("\n").find(line => line.includes(" — Error (task task_failed):"))?.split(" — ")[1];
    expect(output).not.toContain("\u001b");
    expect(output).not.toContain("[31m");
    expect(detail).toBeDefined();
    expect(Array.from(detail!).length).toBeLessThanOrEqual(240);

    const transcript = formatRunInspectionChanges([{
      sequence: 9,
      at: "2026-07-11T00:00:02.000Z",
      entity: { kind: "node", id: "work~abc", nodeId: "work" },
      subject: "work",
      itemKey: "node:work",
      action: "failed",
      status: "failed",
      message,
    }], { run: document.run, items: document.items });
    expect(transcript).not.toContain("\u001b");
    expect(transcript).not.toContain("[31m");
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
    expect(output.indexOf("Output:")).toBeLessThan(output.indexOf("Hooks:"));
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
      scope: { kind: "loop_iteration", iteration: 0, round: 1, empty: false },
    }, {
      key: "review~abc",
      role: "instance",
      parentKey: "review_loop:0",
      path: ["review_loop", "round:0", "review"],
      label: "review",
      kind: "agent",
      status: "completed",
      nodeId: "review",
      nodeKey: "review~abc",
      startedAt: "2026-07-11T00:00:00.000Z",
      finishedAt: "2026-07-11T00:00:01.000Z",
      agent: {
        key: "observer",
        backend: { kind: "use", name: "claude" },
        availability: { context: "available", tokenUsage: "available" },
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
