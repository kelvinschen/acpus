import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ACTIVITY_HOVER_DELAY_MS,
  ActivityStateIcon,
  LeafStatusIcon,
  NodeIcon,
  agentActivityView,
  agentTelemetryView,
  activitySummary,
  chevronClass,
  formatDuration,
  formatObservedDuration,
  hoverEligible,
  hoverPosition,
  nodeDetail,
  occurrenceLabel,
  taskDuration,
  taskHistoryRows,
} from "../src/client/activity-tray.js";
import { sessionConnectionPhase } from "../src/client/state.js";
import type {
  DelegatedTaskActivity,
  DelegatedTaskSummary,
  ResolvedTaskSelector,
} from "../src/remote/types.js";

describe("Acpus activity tray presentation", () => {
  it("uses one shared 700 ms hover intent for Agent and Task details", () => {
    expect(ACTIVITY_HOVER_DELAY_MS).toBe(700);
  });

  it("enables Task hover only after execution starts", () => {
    expect(hoverEligible({ ...node("prepare", "not_started"), kind: "task" })).toBe(false);
    expect(hoverEligible({ ...node("prepare", "pending"), kind: "task" })).toBe(false);
    expect(hoverEligible({ ...node("prepare", "running"), kind: "task" })).toBe(true);
    expect(hoverEligible({ ...node("prepare", "completed"), kind: "task" })).toBe(true);
  });

  it("summarizes one active Agent without adding its identity to the Header", () => {
    const task = activityTask([node("审查架构", "running")]);

    const summary = activitySummary(task);
    expect(summary).toMatchObject({
      title: "正在执行 · 审查架构",
      tone: "running",
    });
    expect(summary).not.toHaveProperty("agent");
    expect(task).not.toHaveProperty("runId");
  });

  it("summarizes parallel leaves and authored input waits", () => {
    const parallel = activityTask([
      node("方案 A", "running"),
      node("方案 B", "running"),
    ]);
    const awaiting = activityTask([node("确认发布方案", "awaiting")], "awaiting");

    expect(activitySummary(parallel).title).toBe("2 个节点并行执行中");
    expect(activitySummary(awaiting).title).toBe("等待你的输入 · 确认发布方案");
    expect(activitySummary(awaiting).tone).toBe("signal");
    expect(activitySummary(activityTask([], "paused")).tone).toBe("waiting");
    expect(activitySummary(activityTask([], "canceled")).tone).toBe("canceled");
    expect(formatDuration(204_000)).toBe("03:24");
  });

  it("computes Header total time from the whole run rather than an active node", () => {
    const task = {
      ...activityTask([{ ...node("active", "running"), durationMs: 1_000 }]),
      startedAt: "2026-08-14T00:00:00.000Z",
    };

    expect(taskDuration(task, Date.parse("2026-08-14T00:00:05.000Z"))).toBe(5_000);
    expect(taskDuration({
      ...task,
      finishedAt: "2026-08-14T00:00:03.500Z",
    }, Date.parse("2026-08-14T00:00:10.000Z"))).toBe(3_500);
  });

  it("uses static and animated Radio icons only for Signal presentation", () => {
    const nodeMarkup = renderToStaticMarkup(createElement(NodeIcon, {
      node: { ...node("人工确认", "awaiting"), kind: "signal" },
    }));
    const awaitingHeader = renderToStaticMarkup(createElement(ActivityStateIcon, {
      state: "signal",
    }));
    const pausedHeader = renderToStaticMarkup(createElement(ActivityStateIcon, {
      state: "waiting",
    }));

    expect(nodeMarkup).toContain('data-acpus-radio="static"');
    expect(awaitingHeader).toContain('data-acpus-radio="animated"');
    expect(pausedHeader).not.toContain("data-acpus-radio");
  });

  it("uses the leaf lifecycle glyphs for settled and waiting run states", () => {
    const icon = (state: Parameters<typeof ActivityStateIcon>[0]["state"]) =>
      renderToStaticMarkup(createElement(ActivityStateIcon, { state }));

    expect(icon("completed")).toContain('data-acpus-icon="circle-check"');
    expect(icon("failed")).toContain('data-acpus-icon="circle-x"');
    expect(icon("canceled")).toContain('data-acpus-icon="ban"');
    expect(icon("waiting")).toContain('data-acpus-icon="circle-ellipsis"');
  });

  it("uses the selected structural and Task icon vocabulary", () => {
    const icon = (kind: string) => renderToStaticMarkup(createElement(NodeIcon, {
      node: { ...node(kind, "running"), kind },
    }));

    expect(icon("task")).toContain('data-acpus-icon="terminal"');
    expect(icon("fanout")).toContain('data-acpus-icon="square-stack"');
    expect(icon("parallel")).toContain('data-acpus-icon="git-fork"');
    expect(icon("if")).toContain('data-acpus-icon="git-branch"');
    expect(icon("switch")).toContain('data-acpus-icon="list-indent-increase"');
  });

  it("uses the bundled icon for the DSH Agent identity", () => {
    const markup = renderToStaticMarkup(createElement(NodeIcon, {
      node: {
        ...node("内建 DSH", "running"),
        agent: { name: "dsh" },
      },
    }));

    expect(markup).toContain('aria-label="Agent: dsh"');
    expect(markup).not.toContain("acpus-agent-fallback-name");
  });

  it("renders leaf lifecycle status at the trailing icon slot", () => {
    const status = (value: Parameters<typeof LeafStatusIcon>[0]["status"]) =>
      renderToStaticMarkup(createElement(LeafStatusIcon, { status: value }));

    expect(status("running")).toContain('data-acpus-icon="loader-circle"');
    expect(status("completed")).toContain('data-acpus-icon="circle-check"');
    expect(status("failed")).toContain('data-acpus-icon="circle-x"');
    expect(status("cancelled")).toContain('data-acpus-icon="ban"');
    expect(status("awaiting")).toContain('data-acpus-icon="circle-ellipsis"');
    expect(status("not_started")).toBe("");
    expect(status("not_selected")).toBe("");
  });

  it("prefers live Agent work over a closed recent tool", () => {
    expect(agentActivityView({
      phase: "responding",
      tool: { name: "read", state: "completed" },
    }, "running")).toEqual({
      kind: "phase",
      state: "running",
      text: "Responding",
      label: "Responding",
    });
    expect(agentActivityView({
      phase: "tool",
      tool: { name: "read", state: "completed" },
    }, "running")).toMatchObject({ kind: "phase", text: "Working" });
    expect(agentActivityView({ phase: "reported-thought" }, "running"))
      .toMatchObject({ kind: "phase", text: "Thinking" });
    expect(agentActivityView({ phase: "planning" }, "running"))
      .toMatchObject({ kind: "phase", text: "Planning" });
    expect(agentActivityView({
      phase: "tool",
      tool: { name: "Tool", state: "running" },
    }, "running")).toMatchObject({ kind: "phase", text: "Working" });
    expect(agentActivityView({ phase: "output-repair" }, "running")).toBeUndefined();
    expect(agentActivityView({ phase: "settling" }, "running")).toBeUndefined();
    expect(agentActivityView({
      phase: "settling",
      tool: { name: "read", state: "completed" },
    }, "running")).toBeUndefined();
    expect(agentActivityView({
      phase: "responding",
      tool: { name: "Search", title: "Search something useful", state: "running" },
    }, "running")).toMatchObject({
      kind: "tool",
      text: "Search · Search something useful",
      label: "正在调用工具 Search · Search something useful",
    });
    expect(agentActivityView({
      phase: "tool",
      tool: { name: "Fetch", title: '"ByteDance Doubao AI 100 million…"', state: "running" },
    }, "running")).toMatchObject({
      kind: "tool",
      text: 'Fetch · "ByteDance Doubao AI 100 million…"',
    });
    expect(agentActivityView({
      phase: "tool",
      tool: { name: "Fetch", state: "running" },
    }, "running")).toMatchObject({ kind: "tool", text: "Fetch" });
    expect(agentActivityView({
      phase: "tool",
      tool: { name: "Tool", title: "tool call", state: "running" },
    }, "running")).toMatchObject({ kind: "phase", text: "Working" });
    expect(agentActivityView({
      tool: { name: "Read", title: "Read the configuration", state: "completed" },
    }, "completed")).toMatchObject({
      kind: "tool",
      state: "completed",
      text: "Read · Read the configuration",
    });
  });

  it("formats only available current-turn telemetry", () => {
    expect(agentTelemetryView({
      inputTokens: 12_000,
      outputTokens: 2_400,
      totalTokens: 14_400,
      contextWindow: { used: 12_000, size: 32_000 },
    }, "running")).toMatchObject({
      text: "↑12k · ↓2.4k · 38% ctx",
      title: "当前或最近一次 Agent turn：输入 12,000 tokens；输出 2,400 tokens；Context 12,000 / 32,000（38%）",
    });
    expect(agentTelemetryView({ outputTokens: 900 }, "running")).toMatchObject({ text: "↓900" });
    expect(agentTelemetryView({ totalTokens: 1_200 }, "running")).toMatchObject({ text: "1.2k tok" });
    expect(agentTelemetryView({ contextWindow: { used: 10, size: 0 } }, "running")).toBeUndefined();
    expect(agentTelemetryView({ contextWindow: { used: 0, size: 200_000 } }, "running")).toBeUndefined();
    expect(agentTelemetryView({
      inputTokens: 400,
      contextWindow: { used: 0, size: 200_000 },
    }, "running")).toMatchObject({ text: "↑400" });
    expect(agentTelemetryView(undefined, "running")).toBeUndefined();
    expect(agentTelemetryView({
      inputTokens: 12_000,
      outputTokens: 2_400,
      contextWindow: { used: 12_000, size: 32_000 },
    }, "completed")).toMatchObject({ text: "↑12k · ↓2.4k" });
    expect(agentTelemetryView({
      contextWindow: { used: 12_000, size: 32_000 },
    }, "completed")).toBeUndefined();
  });

  it("positions hover cards by rendered height while keeping them beside the row and in view", () => {
    expect(hoverPosition(
      { left: 680, right: 1_080, top: 480 },
      { width: 420, height: 64 },
      { width: 1_440, height: 600 },
    )).toEqual({ left: 252, top: 480 });
    expect(hoverPosition(
      { left: 680, right: 1_080, top: 480 },
      { width: 420, height: 480 },
      { width: 1_440, height: 600 },
    )).toEqual({ left: 252, top: 108 });
  });

  it("presents structural metadata as compact tag labels", () => {
    expect(nodeDetail({
      activityId: "parallel",
      label: "parallel_reviews",
      kind: "parallel",
      status: "running",
      children: [],
    })).toBe("Parallel");
    expect(chevronClass(true)).toBe("acpus-chevron");
    expect(chevronClass(false)).toBe("acpus-chevron is-collapsed");
  });

  it("combines composite occurrence type and identity into one label", () => {
    expect(occurrenceLabel({
      activityId: "branch-dsh",
      label: "dsh",
      kind: "branch",
      status: "running",
      children: [],
    })).toBe("Branch · dsh");
    expect(occurrenceLabel({
      activityId: "fanout-0",
      label: "item[0]",
      kind: "fanout_item",
      status: "running",
      children: [],
    })).toBe("Fanout Item · 0");
    expect(occurrenceLabel({
      activityId: "loop-1",
      label: "round 1",
      kind: "loop_iteration",
      status: "running",
      children: [],
    })).toBe("Loop Round · 1");
  });

  it("distinguishes reconnecting from stale and marks uncertain durations", () => {
    const connection = {
      status: "disconnected" as const,
      synchronizedAt: 1_000,
      disconnectedAt: 2_000,
    };

    expect(sessionConnectionPhase(connection, 11_999)).toBe("reconnecting");
    expect(sessionConnectionPhase(connection, 12_000)).toBe("stale");
    expect(sessionConnectionPhase({ status: "connected", synchronizedAt: 12_000 }, 20_000))
      .toBe("connected");
    expect(formatObservedDuration(204_000, true)).toBe("03:24+");
    expect(formatObservedDuration(204_000, false)).toBe("03:24");
  });

  it("places visible fork descendants beneath their source while ordering groups by recent activity", () => {
    const source = taskSummary("review", 1);
    const fork = taskSummary("review", 2, source.task);
    const nestedFork = taskSummary("review", 3, fork.task);
    const standalone = taskSummary("publish", 1);

    expect(taskHistoryRows([nestedFork, standalone, fork, source]).map(({ summary, depth }) => ({
      task: summary.task,
      depth,
    }))).toEqual([
      { task: source.task, depth: 0 },
      { task: fork.task, depth: 1 },
      { task: nestedFork.task, depth: 2 },
      { task: standalone.task, depth: 0 },
    ]);
  });
});

function taskSummary(
  name: string,
  occurrence: number,
  forkedFrom?: ResolvedTaskSelector,
): DelegatedTaskSummary {
  return {
    task: { name, occurrence },
    status: "completed",
    availability: { status: "available" },
    counts: {
      total: 1,
      notStarted: 0,
      pending: 0,
      running: 0,
      awaiting: 0,
      completed: 1,
      failed: 0,
      timedOut: 0,
      canceled: 0,
    },
    startedAt: "2026-08-14T00:00:00.000Z",
    ...(forkedFrom === undefined ? {} : { forkedFrom }),
  };
}

function activityTask(
  tree: DelegatedTaskActivity["tree"],
  status: DelegatedTaskActivity["status"] = "running",
): DelegatedTaskActivity {
  return {
    selector: { name: "review", occurrence: 1 },
    generation: 1,
    status,
    availability: { status: "available" },
    counts: {
      total: tree.length,
      notStarted: 0,
      pending: 0,
      running: tree.length,
      awaiting: status === "awaiting" ? 1 : 0,
      completed: 0,
      failed: 0,
      timedOut: 0,
      canceled: 0,
    },
    startedAt: "2026-08-14T00:00:00.000Z",
    tree,
  };
}

function node(
  label: string,
  status: DelegatedTaskActivity["tree"][number]["status"],
): DelegatedTaskActivity["tree"][number] {
  return {
    activityId: label,
    label,
    kind: "agent",
    status,
    startedAt: "2026-08-14T00:00:00.000Z",
    agent: { name: "codex" },
    children: [],
  };
}
