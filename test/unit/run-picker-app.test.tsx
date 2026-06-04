import React from "react";
import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { RunPickerApp } from "../../src/tui/run-picker-app.js";
import type { RunSummaryList } from "../../src/run-index/run-summary.js";

describe("RunPickerApp", () => {
  it("renders run summaries and selects the highlighted run", async () => {
    let selected: string | undefined;
    const list = runList([
      { runId: "run-new", workflowName: "new-workflow", status: "running" },
      { runId: "run-old", workflowName: "old-workflow", status: "completed" }
    ]);
    const { lastFrame, stdin } = render(<RunPickerApp
      title="Select a run"
      initialList={list}
      loadRuns={async () => list}
      pollMs={60_000}
      onSelect={(runId) => {
        selected = runId;
      }}
    />);

    expect(lastFrame()).toContain("Select a run");
    expect(lastFrame()).toContain("new-workflow");
    stdin.write("\r");
    await flushPromises();

    expect(selected).toBe("run-new");
  });

  it("renders an empty state", () => {
    const list = runList([]);
    const { lastFrame } = render(<RunPickerApp
      title="Select a run"
      initialList={list}
      loadRuns={async () => list}
      pollMs={60_000}
      onSelect={() => undefined}
    />);

    expect(lastFrame()).toContain("No runs found.");
  });

  it("renders invalid rows without a failure status mark", () => {
    const list: RunSummaryList = {
      kind: "runs",
      dir: "/tmp/.acpus/runs",
      entries: [{
        runId: "bad-run",
        runDir: "/tmp/.acpus/runs/bad-run",
        invalid: true,
        error: "cannot read run",
        sortTime: "2026-06-04T00:00:00.000Z"
      }]
    };
    const { lastFrame } = render(<RunPickerApp
      title="Select a run"
      initialList={list}
      loadRuns={async () => list}
      pollMs={60_000}
      onSelect={() => undefined}
    />);

    expect(lastFrame()).toContain("bad-run");
    expect(lastFrame()).toContain("invalid");
    expect(lastFrame()).not.toContain("! bad-run");
  });
});

function runList(entries: Array<{ runId: string; workflowName?: string; status?: RunSummaryList["entries"][number]["status"] }>): RunSummaryList {
  return {
    kind: "runs",
    dir: "/tmp/.acpus/runs",
    entries: entries.map((entry, index) => ({
      runId: entry.runId,
      runDir: `/tmp/.acpus/runs/${entry.runId}`,
      workflowName: entry.workflowName,
      status: entry.status,
      progress: { completedStages: index, totalStages: 2, label: `${index}/2 stages` },
      createdAt: "2026-06-04T00:00:00.000Z",
      updatedAt: "2026-06-04T00:00:00.000Z",
      sortTime: "2026-06-04T00:00:00.000Z"
    }))
  };
}

async function flushPromises(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}
