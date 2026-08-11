import { describe, expect, it } from "vitest";
import type { InspectionCandidates, InspectionView } from "@acpus/runtime";
import {
  formatInspectionCandidates,
  formatInspectionChanges,
  formatTimelineEntries,
  formatInspectionView,
  inspectionRecoveryCommand,
} from "../src/runs/inspection-surface.js";

type RunInspectionView = Extract<InspectionView, { kind: "run" }>;

describe("inspection text surface", () => {
  it("renders Runtime's semantic tree without exposing controls or raw identities", () => {
    const text = formatInspectionView(runView());

    expect(text).toContain("Run run_1  design  running  1m36s");
    expect(text).toContain("Counts total=3  not-started=1  running=1  completed=1");
    expect(text).toContain("┌─ ✓ seed_blackboard · task · completed");
    expect(text).toContain("├─ ⠋ design_cycle · loop · @e6bacaf847b3 · running · 1/2 · tool: Searching the Web");
    expect(text).toContain("└─ ○ publish_blackboard · task · not started");
    expect(text).not.toContain("publish_blackboard · task · publish_blackboard");
    expect(text).toContain("└┄ … round 1–4 ×4 · ⠋ · running");
    expect(text).toContain("Await: acpus runs inspect run_1 --await-decision");
    expect(text).not.toContain("Retry:");
    expect(text).not.toContain("Fork:");
    expect(text).not.toContain("Cancel:");
    expect(text).not.toContain("Steer:");
    expect(text).not.toContain("attempt_internal");
  });

  it("distinguishes a true Agent start from the interval between activities", () => {
    const starting = formatInspectionView(agentActivityView({ phase: "starting", turn: 1 }));
    const repairing = formatInspectionView(agentActivityView({ phase: "output-repair", turn: 2, headline: "output repair" }));
    const between = formatInspectionView(agentActivityView());

    expect(starting).toContain("┌─ ⠋ write_report · agent · @3f19e12fc389#1 · running · starting");
    expect(starting).not.toContain("turn 1");
    expect(repairing).toContain("┌─ ⠋ write_report · agent · @3f19e12fc389#1 · running · turn 2 · output repair");
    expect(repairing).not.toContain("output repair: output repair");
    expect(between).toContain("┌─ ⠋ write_report · agent · @3f19e12fc389#1 · running\n");
    expect(between).not.toContain("starting");
  });

  it("renders Agent current activity from turn context through phase detail", () => {
    const text = formatInspectionView({
      kind: "target",
      detail: "timeline",
      run: { id: "run_1", status: "running" },
      subject: { label: "research", kind: "agent", selector: "@1a2b3c4d5e6f#1" },
      state: { status: "running" },
      current: { kind: "agent", phase: "tool", turn: 1, headline: "Searching the Web" },
      recent: [],
    } satisfies InspectionView);

    expect(text).toContain("Current:\n  tool: Searching the Web");
    expect(text).not.toContain("turn 1");
    expect(text).not.toContain("Current:\n  agent");
  });

  it("shows only activity that adds information beyond target state", () => {
    const ordinary = formatInspectionView({
      kind: "target",
      detail: "timeline",
      run: { id: "run_1", status: "running" },
      subject: { label: "prepare", kind: "task", selector: "prepare" },
      state: { status: "running" },
      current: { kind: "task", phase: "running" },
      recent: [],
    } satisfies InspectionView);
    const repaired = formatInspectionView({
      kind: "target",
      detail: "timeline",
      run: { id: "run_1", status: "completed" },
      subject: { label: "research", kind: "agent", selector: "@1a2b3c4d5e6f#2" },
      state: { status: "completed" },
      current: { kind: "agent", phase: "settled", turn: 2 },
      recent: [],
    } satisfies InspectionView);

    expect(ordinary).not.toContain("Current:");
    expect(repaired).toContain("Last:\n  turn 2");
    expect(repaired).not.toContain("settled");
  });

  it("labels useful terminal Agent activity as Last", () => {
    const normal = formatInspectionView({
      kind: "target",
      detail: "summary",
      run: { id: "run_1", status: "completed" },
      subject: { label: "research", kind: "agent", selector: "@1a2b3c4d5e6f#1" },
      state: { status: "completed" },
      pulse: { phase: "settled", turn: 1, headline: "Plan: Verify the report." },
    } satisfies InspectionView);
    const empty = formatInspectionView({
      kind: "target",
      detail: "summary",
      run: { id: "run_1", status: "completed" },
      subject: { label: "research", kind: "agent", selector: "@1a2b3c4d5e6f#1" },
      state: { status: "completed" },
      pulse: { phase: "settled", turn: 1 },
    } satisfies InspectionView);

    expect(normal).toContain("Last Plan: Verify the report.");
    expect(normal).not.toContain("turn 1");
    expect(normal).not.toContain("settled");
    expect(empty).not.toContain("Pulse ");
    expect(empty).not.toContain("Last ");
  });

  it("keeps a repaired turn but omits settled from a terminal Tree pulse", () => {
    const text = formatInspectionView({
      kind: "run",
      run: { id: "run_1", name: "research", status: "completed" },
      counts: { total: 1, completed: 1 },
      tree: [{
        type: "item",
        subject: { label: "write_report", kind: "agent", selector: "@1a2b3c4d5e6f#2" },
        state: { status: "completed" },
        pulse: { phase: "settled", turn: 2 },
        children: [],
      }],
    } satisfies InspectionView);

    expect(text).toContain("write_report · agent · @1a2b3c4d5e6f#2 · completed · turn 2");
    expect(text).not.toContain("settled");
  });

  it("renders a pruned completed run as shared repeat shapes without skipped branches", () => {
    const text = formatInspectionView(prunedDesignForgeView());

    expect(text).toBe([
      "Run run_1  design-forge  completed  39m21s",
      "Counts total=18  completed=18",
      "",
      "Tree:",
      "┌─ ✓ seed_blackboard · task · @b1ac9dc8e1c8#1 · completed · 244ms",
      "├─ ✓ design_cycle · loop · @e6bacaf847b3 · completed",
      "│  ├┄ … round 1–3 ×3 · ✓ · completed",
      "│  │  ├─ ✓ design_board · agent · completed",
      "│  │  └─ ✓ challenge_panel · parallel · completed · 3/3",
      "│  │     ├─ ✓ challenge_fitness · agent · completed",
      "│  │     ├─ ✓ challenge_failure · agent · completed",
      "│  │     └─ ✓ challenge_simplicity · agent · completed",
      "│  └┄ … round 4–5 ×2 · ✓ · completed",
      "│     ├─ ✓ design_board · agent · completed",
      "│     └─ ✓ challenge_panel · parallel · completed · 3/3",
      "│        ├─ ✓ fitness_gate · if · completed",
      "│        ├─ ✓ challenge_failure · agent · completed",
      "│        └─ ✓ simplicity_gate · if · completed",
      "└─ ✓ publish_blackboard · task · @4b326bcc34ef#1 · completed · 235ms",
      "",
      "Output:",
      "  {",
      "    \"rounds\": 5,",
      "    \"settled\": true",
      "  }",
      "",
    ].join("\n"));
    expect(text).not.toContain("not selected");
  });

  it("renders exact Signal navigation at an input boundary instead of an await recommendation", () => {
    const text = formatInspectionView({
      kind: "target",
      detail: "summary",
      run: { id: "run_1", status: "running" },
      subject: { label: "approve", kind: "signal", selector: "@1a2b3c4d5e6f" },
      state: { status: "awaiting" },
      attention: {
        kind: "awaiting-input",
        summary: "Approve the proposal?",
        signal: "@ab12cd34ef56",
        prompt: "Approve the proposal?",
        expected: "{ approved: boolean }",
      },
    } satisfies InspectionView);

    expect(text).toContain("Signal: acpus runs signal run_1 --target @ab12cd34ef56 --payload '<json>'");
    expect(text).toContain("Timeline: acpus runs inspect run_1 --target @1a2b3c4d5e6f --timeline");
    expect(text.match(/Approve the proposal\?/g)).toHaveLength(1);
    expect(text).not.toContain("Prompt Approve the proposal?");
    expect(text).not.toContain("--await-decision");
  });

  it("suppresses only recursive Await navigation for an attached target", () => {
    const text = formatInspectionView({
      kind: "target",
      detail: "summary",
      run: { id: "run_1", status: "running" },
      subject: { label: "review", kind: "agent", selector: "@1a2b3c4d5e6f" },
      state: { status: "running" },
    } satisfies InspectionView, { showAwait: false });

    expect(text).toContain("Timeline: acpus runs inspect run_1 --target @1a2b3c4d5e6f --timeline");
    expect(text).not.toContain("Await:");
  });

  it("renders only the ACP silence duration without policy or countdown detail", () => {
    const text = formatInspectionView({
      kind: "target",
      detail: "summary",
      run: { id: "run_1", status: "running" },
      subject: { label: "review", kind: "agent", selector: "@1a2b3c4d5e6f" },
      state: { status: "running" },
      acp: { silentForMs: 840_000 },
    } satisfies InspectionView, { showAwait: false });

    expect(text).toContain("ACP silent for 14m0s");
    expect(text).not.toContain("failure in");
    expect(text).not.toContain("threshold");
  });

  it("uses the exact blocking Signal rather than a selected composite in Timeline", () => {
    const text = formatInspectionView({
      kind: "target",
      detail: "timeline",
      run: { id: "run_1", status: "running" },
      subject: { label: "review_parallel", kind: "parallel", selector: "@parent000000" },
      state: { status: "awaiting" },
      current: {
        kind: "signal",
        phase: "awaiting",
        signal: "@signal000000",
        prompt: "Approve the review?",
      },
      recent: [],
    } satisfies InspectionView, { showAwait: false });

    expect(text).toContain("Signal: acpus runs signal run_1 --target @signal000000 --payload '<json>'");
    expect(text).toContain("Current:\n  signal · awaiting · Approve the review?");
    expect(text).not.toContain("signal run_1 --target @parent000000");
    expect(text).not.toContain("--await-decision");
  });

  it("does not offer Await after the owning run is paused", () => {
    const views: InspectionView[] = [{
      kind: "run",
      run: { id: "run_1", name: "design", status: "paused" },
      counts: { total: 1, running: 1 },
      tree: [],
    }, {
      kind: "target",
      detail: "summary",
      run: { id: "run_1", status: "paused" },
      subject: { label: "review", kind: "agent", selector: "@1a2b3c4d5e6f" },
      state: { status: "running" },
    }, {
      kind: "target",
      detail: "timeline",
      run: { id: "run_1", status: "paused" },
      subject: { label: "review", kind: "agent", selector: "@1a2b3c4d5e6f" },
      state: { status: "running" },
      recent: [],
    }];

    for (const view of views) {
      expect(formatInspectionView(view)).not.toContain("Await:");
      expect(formatInspectionView(view)).not.toContain("--forensics");
    }
  });

  it("makes every ambiguous candidate selection executable and preserves Timeline detail", () => {
    const text = formatInspectionCandidates(candidates(), "timeline");

    expect(text).toContain("Target review  matches=13");
    expect(text).toContain("Select: acpus runs inspect run_1 --target @000000000001 --timeline");
    expect(text).toContain("Select: acpus runs inspect run_1 --target @000000000007 --timeline");
    expect(text).toContain("Select: acpus runs inspect run_1 --target @00000000000d --timeline");
    expect(text).not.toContain("Next:");
    expect(text).not.toContain("page=");
    expect(text).not.toContain("--follow");
    expect(text).not.toContain("--await-decision");
  });

  it("renders complete Forensics sections and preserves detail in candidate navigation", () => {
    const prompt = "Review all facts.\nReturn the final answer.";
    const value = "x".repeat(4_000);
    const text = formatInspectionView({
      kind: "target",
      detail: "forensics",
      run: { id: "run_1", status: "completed" },
      subject: { label: "review", kind: "agent", selector: "@1a2b3c4d5e6f#2" },
      state: { status: "completed", durationMs: 25 },
      definition: {
        kind: "agent",
        agent: "reviewer",
        profile: { kind: "agent_definition", use: "codex" },
        prompt: "input.prompt",
      },
      invocation: {
        status: "resolved",
        kind: "agent",
        attempt: 2,
        promptOrigin: "authored",
        prompt,
        cwd: "/workspace",
        env: { MANAGED: value },
        permissionMode: "approve-all",
      },
      result: { status: "accepted", value: { value } },
    } satisfies InspectionView);
    const candidatesText = formatInspectionCandidates(candidates(), "forensics");

    expect(text).toContain("Forensics review  @1a2b3c4d5e6f#2 · agent");
    expect(text).toContain("Definition:\n");
    expect(text).toContain("Invocation:\n");
    expect(text).toContain("Result:\n");
    expect(text).toContain('"prompt": "<multiline:prompt>"');
    expect(text).toContain("prompt: |\n    Review all facts.\n    Return the final answer.");
    expect(text).toContain(value);
    expect(text).not.toContain("Timeline:");
    expect(text).not.toContain("Await:");
    expect(candidatesText).toContain("Select: acpus runs inspect run_1 --target @000000000001 --forensics");
    expect(candidatesText).toContain("Select: acpus runs inspect run_1 --target @00000000000d --forensics");
    expect(candidatesText).not.toContain("Next:");
  });

  it("escapes terminal and bidirectional controls without losing their forensic representation", () => {
    const prompt = "raw:\u001b[31m\u009b2J\u202e literal:\\u009b\nnext\rline";
    const text = formatInspectionView({
      kind: "target",
      detail: "forensics",
      run: { id: "run_1", status: "running" },
      subject: { label: "review", kind: "agent", selector: "@1a2b3c4d5e6f" },
      state: { status: "running" },
      definition: {
        kind: "agent",
        agent: "reviewer",
        profile: { kind: "agent_definition", use: "codex" },
        prompt: "\"review\"",
      },
      invocation: {
        status: "resolved",
        kind: "agent",
        attempt: 1,
        promptOrigin: "authored",
        prompt,
        cwd: "/workspace",
        env: {},
        permissionMode: "approve-all",
      },
      result: { status: "pending" },
    } satisfies InspectionView);

    expect(text).not.toMatch(/[\u001b\u009b\u202e\r]/u);
    expect(text).toContain("raw:\\u001b[31m\\u009b2J\\u202e literal:\\\\u009b");
    expect(text).toContain("next\\u000dline");
  });

  it("omits only implied Timeline ordinals and transition statuses", () => {
    const text = formatTimelineEntries([{
      kind: "transition",
      at: "2026-07-30T00:00:01.000Z",
      action: "started",
      status: "running",
      attempt: 1,
    }, {
      kind: "activity",
      at: "2026-07-30T00:00:02.000Z",
      channel: "tool",
      attempt: 1,
      turn: 1,
      summary: "Read",
    }, {
      kind: "transition",
      at: "2026-07-30T00:00:03.000Z",
      action: "completed",
      status: "failed",
      attempt: 2,
    }, {
      kind: "activity",
      at: "2026-07-30T00:00:04.000Z",
      channel: "tool",
      attempt: 2,
      turn: 2,
      summary: "Write",
    }]);

    expect(text).toBe([
      "  Attempt 1:",
      "    2026-07-30T00:00:01.000Z  started",
      "    2026-07-30T00:00:02.000Z  tool  Read",
      "  Attempt 2:",
      "    2026-07-30T00:00:03.000Z  completed/failed",
      "    2026-07-30T00:00:04.000Z  tool  turn=2  Write",
    ].join("\n"));

    const retried = formatTimelineEntries([{
      kind: "activity",
      at: "2026-07-30T00:00:05.000Z",
      channel: "reported-thought",
      attempt: 2,
      summary: "Inspect",
    }, {
      kind: "activity",
      at: "2026-07-30T00:00:06.000Z",
      channel: "response",
      attempt: 2,
      summary: "Done",
    }]);
    expect(retried).toBe([
      "  Attempt 2:",
      "    2026-07-30T00:00:05.000Z  reported-thought  Inspect",
      "    2026-07-30T00:00:06.000Z  response  Done",
    ].join("\n"));
  });

  it("uses an exact Timeline selector as the attempt context", () => {
    const text = formatInspectionView({
      kind: "target",
      detail: "timeline",
      run: { id: "run_1", status: "running" },
      subject: { label: "review", kind: "agent", selector: "@1a2b3c4d5e6f#2" },
      state: { status: "running" },
      recent: [{
        kind: "transition",
        at: "2026-07-30T00:00:01.000Z",
        action: "started",
        status: "running",
        attempt: 2,
      }, {
        kind: "activity",
        at: "2026-07-30T00:00:02.000Z",
        channel: "reported-thought",
        attempt: 2,
        turn: 1,
        summary: "Inspect the evidence.",
      }, {
        kind: "activity",
        at: "2026-07-30T00:00:03.000Z",
        channel: "response",
        attempt: 1,
        turn: 1,
        summary: "Late mismatched evidence.",
      }],
    } satisfies InspectionView);

    expect(text).toContain("Timeline review  @1a2b3c4d5e6f#2 · agent");
    expect(text).not.toContain("attempt=2");
    expect(text).not.toContain("Attempt 2:");
    expect(text).toContain("response  attempt=1  Late mismatched evidence.");
  });

  it("deduplicates Attention text without removing recovery navigation", () => {
    const run = formatInspectionView({
      kind: "run",
      run: { id: "run_1", name: "review", status: "failed" },
      counts: { total: 1, failed: 1 },
      tree: [{
        type: "item",
        subject: { label: "review", kind: "agent", selector: "@fedcba987654#1" },
        state: { status: "failed", failure: { origin: "runtime", message: "Review failed." } },
        attention: { kind: "failure", summary: "Review failed." },
        children: [],
      }],
    } satisfies InspectionView);
    const target = formatInspectionView({
      kind: "target",
      detail: "summary",
      run: { id: "run_1", status: "failed" },
      subject: { label: "review", kind: "agent", selector: "@fedcba987654#1" },
      state: { status: "failed", failure: { origin: "runtime", message: "Review failed." } },
      attention: { kind: "failure", summary: "Review failed." },
    } satisfies InspectionView);
    const update = formatInspectionChanges([{
      subject: { label: "approve", kind: "signal", selector: "@ab12cd34ef56" },
      state: { status: "awaiting" },
      attention: {
        kind: "awaiting-input",
        summary: "Approve the proposal?",
        prompt: "Approve the proposal?",
        signal: "@ab12cd34ef56",
      },
    }], "run_1");

    expect(run.match(/Review failed\./g)).toHaveLength(1);
    expect(run).toContain("Attention:\n  ◆ review  @fedcba987654#1\n     Timeline: acpus runs inspect run_1 --target '@fedcba987654#1' --timeline");
    expect(target.match(/Review failed\./g)).toHaveLength(1);
    expect(target).toContain("Timeline: acpus runs inspect run_1 --target '@fedcba987654#1' --timeline");
    expect(update.match(/Approve the proposal\?/g)).toHaveLength(1);
    expect(update).not.toContain("Prompt Approve the proposal?");
    expect(update).toContain("Signal: acpus runs signal run_1 --target @ab12cd34ef56 --payload '<json>'");
  });

  it("renders every decision facet carried by an update", () => {
    const text = formatInspectionChanges([{
      subject: { label: "design_board", kind: "agent", selector: "@2771ef6ac8e9" },
      state: { status: "completed" },
    }, {
      subject: { label: "challenge_panel", kind: "parallel" },
      state: { status: "running" },
      progress: { completed: 1, total: 3 },
      reason: "race-selected",
    }, {
      subject: { label: "approve", kind: "signal", selector: "@1a2b3c4d5e6f" },
      state: { status: "awaiting" },
      occurrences: { total: 3, awaiting: 1, completed: 2 },
      attention: {
        kind: "awaiting-input",
        summary: "Approval required.",
        signal: "@ab12cd34ef56",
        prompt: "Approve the proposal?",
        expected: "{ approved: boolean }",
      },
      visibility: { state: "degraded", reason: "observation-gap" },
    }, {
      subject: { label: "failed_review", kind: "agent", selector: "@fedcba987654" },
      state: {
        status: "failed",
        failure: { origin: "runtime", message: "Review failed." },
      },
      attention: { kind: "failure", summary: "Review failed." },
    }], "run_1");

    expect(text).toBe([
      "  ✓ design_board  @2771ef6ac8e9 · completed",
      "  ⠋ challenge_panel · running · 1/3 · race selected",
      "  ⏳ approve  @1a2b3c4d5e6f · awaiting · occurrences total=3  awaiting=1  completed=2",
      "     Attention Approval required.",
      "     Prompt Approve the proposal?",
      "     Expected { approved: boolean }",
      "     Signal: acpus runs signal run_1 --target @ab12cd34ef56 --payload '<json>'",
      "     Visibility degraded/observation-gap  Inspection may be incomplete.",
      "  ◆ failed_review  @fedcba987654 · failed · Error (runtime): Review failed.",
    ].join("\n"));
  });

  it("builds recovery commands from the fixed target and selected detail", () => {
    expect(inspectionRecoveryCommand({ kind: "run", runId: "run_1" })).toBe("acpus runs inspect run_1");
    expect(inspectionRecoveryCommand({
      kind: "target",
      runId: "run_1",
      target: "@1a2b3c4d5e6f#2",
      detail: "timeline",
    })).toBe("acpus runs inspect run_1 --target '@1a2b3c4d5e6f#2' --timeline");
    expect(inspectionRecoveryCommand({
      kind: "target",
      runId: "run_1",
      target: "root",
      detail: "forensics",
    })).toBe("acpus runs inspect run_1 --target root --forensics");
  });
});

function runView(): RunInspectionView {
  return {
    kind: "run",
    run: { id: "run_1", name: "design", status: "running", durationMs: 96_000 },
    counts: { total: 3, notStarted: 1, running: 1, completed: 1 },
    tree: [{
      type: "item",
      subject: { label: "seed_blackboard", kind: "task" },
      state: { status: "completed" },
      children: [],
    }, {
      type: "item",
      subject: { label: "design_cycle", kind: "loop", selector: "@e6bacaf847b3" },
      state: { status: "running" },
      progress: { completed: 1, total: 2 },
      pulse: { phase: "tool", turn: 1, headline: "Searching the Web" },
      children: [{
        type: "fold",
        scope: "loop-rounds",
        range: { start: 1, end: 4 },
        count: 4,
        state: { status: "running" },
        children: [],
      }],
    }, {
      type: "item",
      subject: { label: "publish_blackboard", kind: "task", selector: "publish_blackboard" },
      state: { status: "not_started" },
      children: [],
    }],
  };
}

function agentActivityView(
  pulse?: Extract<RunInspectionView["tree"][number], { type: "item" }>["pulse"],
): RunInspectionView {
  return {
    kind: "run",
    run: { id: "run_1", name: "deep-research", status: "running" },
    counts: { total: 1, running: 1 },
    tree: [{
      type: "item",
      subject: { label: "write_report", kind: "agent", selector: "@3f19e12fc389#1" },
      state: { status: "running" },
      ...(pulse ? { pulse } : {}),
      children: [],
    }],
  };
}

function prunedDesignForgeView(): RunInspectionView {
  const agent = (label: string): RunInspectionView["tree"][number] => ({
    type: "item",
    subject: { label, kind: "agent" },
    state: { status: "completed" },
    pulse: { phase: "settled" },
    children: [],
  });
  const panel = (children: RunInspectionView["tree"]): RunInspectionView["tree"][number] => ({
    type: "item",
    subject: { label: "challenge_panel", kind: "parallel" },
    state: { status: "completed" },
    progress: { completed: 3, total: 3 },
    children,
  });
  const gate = (label: string): RunInspectionView["tree"][number] => ({
    type: "item",
    subject: { label, kind: "if" },
    state: { status: "completed" },
    children: [],
  });
  return {
    kind: "run",
    run: { id: "run_1", name: "design-forge", status: "completed", durationMs: 2_361_000 },
    counts: { total: 18, completed: 18 },
    tree: [{
      type: "item",
      subject: { label: "seed_blackboard", kind: "task", selector: "@b1ac9dc8e1c8#1" },
      state: { status: "completed", durationMs: 244 },
      children: [],
    }, {
      type: "item",
      subject: { label: "design_cycle", kind: "loop", selector: "@e6bacaf847b3" },
      state: { status: "completed" },
      children: [{
        type: "fold",
        scope: "loop-rounds",
        range: { start: 1, end: 3 },
        count: 3,
        state: { status: "completed" },
        children: [
          agent("design_board"),
          panel([agent("challenge_fitness"), agent("challenge_failure"), agent("challenge_simplicity")]),
        ],
      }, {
        type: "fold",
        scope: "loop-rounds",
        range: { start: 4, end: 5 },
        count: 2,
        state: { status: "completed" },
        children: [
          agent("design_board"),
          panel([gate("fitness_gate"), agent("challenge_failure"), gate("simplicity_gate")]),
        ],
      }],
    }, {
      type: "item",
      subject: { label: "publish_blackboard", kind: "task", selector: "@4b326bcc34ef#1" },
      state: { status: "completed", durationMs: 235 },
      children: [],
    }],
    output: { rounds: 5, settled: true },
  };
}

function candidates(): InspectionCandidates {
  return {
    kind: "candidates",
    run: { id: "run_1", status: "running" },
    target: "review",
    entries: Array.from({ length: 13 }, (_, index) => ({
      selector: `@${(index + 1).toString(16).padStart(12, "0")}`,
      status: index === 12 ? "completed" : "running",
      breadcrumb: `batch[${index}] › review`,
    })),
  };
}
