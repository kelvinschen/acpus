import { describe, expect, it } from "vitest";
import type { InspectionCandidates, InspectionView } from "@acpus/runtime";
import {
  formatInspectionCandidates,
  formatInspectionChanges,
  formatInspectionView,
  inspectionRecoveryCommand,
} from "../src/run-inspection-surface.js";

type RunInspectionView = Extract<InspectionView, { kind: "run" }>;

describe("inspection text surface", () => {
  it("renders Runtime's semantic tree without exposing controls or raw identities", () => {
    const text = formatInspectionView(runView());

    expect(text).toContain("Run run_1  design  running  1m36s");
    expect(text).toContain("Counts total=3  not-started=1  running=1  completed=1");
    expect(text).toContain("┌─ ✓ seed_blackboard · task · completed");
    expect(text).toContain("├─ ⠋ design_cycle · loop · @e6bacaf847b3 · running · 1/2 · tool · turn 1");
    expect(text).toContain("└┄ … round 1–4 ×4 · ⠋ · running");
    expect(text).toContain("Await: acpus runs inspect run_1 --await-decision");
    expect(text).not.toContain("Retry:");
    expect(text).not.toContain("Fork:");
    expect(text).not.toContain("Cancel:");
    expect(text).not.toContain("Steer:");
    expect(text).not.toContain("attempt_internal");
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
      "│  │  ├─ ✓ design_board · agent · completed · settled",
      "│  │  └─ ✓ challenge_panel · parallel · completed · 3/3",
      "│  │     ├─ ✓ challenge_fitness · agent · completed · settled",
      "│  │     ├─ ✓ challenge_failure · agent · completed · settled",
      "│  │     └─ ✓ challenge_simplicity · agent · completed · settled",
      "│  └┄ … round 4–5 ×2 · ✓ · completed",
      "│     ├─ ✓ design_board · agent · completed · settled",
      "│     └─ ✓ challenge_panel · parallel · completed · 3/3",
      "│        ├─ ✓ fitness_gate · if · completed",
      "│        ├─ ✓ challenge_failure · agent · completed · settled",
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
        summary: "waiting for approval",
        signal: "@ab12cd34ef56",
        prompt: "Approve the proposal?",
        expected: "{ approved: boolean }",
      },
    } satisfies InspectionView);

    expect(text).toContain("Signal: acpus runs signal run_1 --target @ab12cd34ef56 --payload '<json>'");
    expect(text).toContain("Timeline: acpus runs inspect run_1 --target @1a2b3c4d5e6f --timeline");
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

    for (const view of views) expect(formatInspectionView(view)).not.toContain("Await:");
  });

  it("makes every ambiguous candidate selection executable and preserves Timeline detail", () => {
    const text = formatInspectionCandidates(candidates(), { timeline: true });

    expect(text).toContain("Target review  matches=13  page=1");
    expect(text).toContain("Select: acpus runs inspect run_1 --target @1a2b3c4d5e6f --timeline");
    expect(text).toContain("Select: acpus runs inspect run_1 --target @6f5e4d3c2b1a --timeline");
    expect(text).toContain("Next: acpus runs inspect run_1 --target review --timeline --page 2");
    expect(text).not.toContain("--follow");
    expect(text).not.toContain("--await-decision");
  });

  it("renders only the current visible state in compact update lines", () => {
    const text = formatInspectionChanges([{
      subject: { label: "design_board", selector: "@2771ef6ac8e9" },
      state: { status: "completed" },
    }, {
      subject: { label: "challenge_panel" },
      state: { status: "running" },
      progress: { completed: 1, total: 3 },
      reason: "race-selected",
    }]);

    expect(text).toBe([
      "  ✓ design_board  @2771ef6ac8e9 · completed",
      "  ⠋ challenge_panel · running · 1/3 · race selected",
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
      pulse: { phase: "tool", turn: 1 },
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
      subject: { label: "publish_blackboard", kind: "task" },
      state: { status: "not_started" },
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
    entries: [{
      selector: "@1a2b3c4d5e6f",
      status: "running",
      breadcrumb: "batch[0] › review",
    }, {
      selector: "@6f5e4d3c2b1a",
      status: "completed",
      breadcrumb: "batch[1] › review",
    }],
    page: 1,
    total: 13,
    nextPage: 2,
  };
}
