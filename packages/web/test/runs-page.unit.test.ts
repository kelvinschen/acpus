// @vitest-environment jsdom

import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunRecord } from "../src/api-types.js";
import { RunsPage, type RunsPageProps } from "../src/client/ui/RunsPage.js";
import { sortWorkspaces } from "../src/client/ui/WorkspaceSelector.js";
import { installReactActEnvironment } from "./support/react-act-environment.js";

const completedRun: RunRecord = {
  id: "20260809023423-completed",
  name: "deep-research",
  status: "completed",
  createdAt: "2026-08-09T00:00:00.000Z",
  updatedAt: "2026-08-09T00:00:05.000Z",
};

const runningRun: RunRecord = {
  id: "20260809023501-running",
  name: "publication-preview",
  status: "running",
  createdAt: "2026-08-09T00:00:00.000Z",
  updatedAt: "2026-08-09T00:00:04.000Z",
};

let container: HTMLDivElement;
let root: Root;
let restoreReactActEnvironment = () => {};
const originalScrollIntoView = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollIntoView");

beforeEach(() => {
  restoreReactActEnvironment = installReactActEnvironment();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-09T00:00:10.000Z"));
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  expect(vi.getTimerCount()).toBe(0);
  container.remove();
  if (originalScrollIntoView) Object.defineProperty(HTMLElement.prototype, "scrollIntoView", originalScrollIntoView);
  else Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
  vi.useRealTimers();
  restoreReactActEnvironment();
});

async function render(overrides: Partial<RunsPageProps> = {}): Promise<void> {
  const props: RunsPageProps = {
    runs: [completedRun, runningRun],
    loading: false,
    error: null,
    workspaceCatalog: {
      currentWorkspaceKey: "ws_current",
      workspaces: [{
        key: "ws_current",
        name: "acpus",
        path: "/workspace/acpus",
        runCount: 2,
        lastRunUpdatedAt: runningRun.updatedAt,
      }],
    },
    selectedWorkspaceKey: "ws_current",
    onRetry: vi.fn(),
    onSelectWorkspace: vi.fn(),
    onOpenRun: vi.fn(),
    ...overrides,
  };
  await act(async () => root.render(React.createElement(RunsPage, props)));
}

function card(run: RunRecord): HTMLButtonElement {
  return container.querySelector<HTMLButtonElement>(`button[aria-label="Open ${run.name} run ${run.id} in Run Monitor"]`)!;
}

function metricValue(runCard: HTMLElement, label: string): string | null | undefined {
  const metric = [...runCard.querySelectorAll<HTMLElement>(".run-card-metric")]
    .find(item => item.querySelector("dt")?.textContent === label);
  return metric?.querySelector("dd")?.textContent;
}

describe("Runs page", () => {
  it("renders run cards with terminal duration and live elapsed time", async () => {
    const onOpenRun = vi.fn();
    await render({ onOpenRun });

    const completed = card(completedRun);
    const running = card(runningRun);
    expect(completed.type).toBe("button");
    expect(completed.getAttribute("aria-label")).toContain(completedRun.id);
    expect(running.getAttribute("aria-label")).toContain(runningRun.id);
    expect(completed.getAttribute("aria-label")).not.toBe(running.getAttribute("aria-label"));
    expect(completed.textContent).toContain("completed");
    expect(completed.textContent).toContain(completedRun.id);
    expect(metricValue(completed, "Duration")).toBe("5s");
    expect(metricValue(completed, "Finished")).toBeTruthy();
    expect(running.textContent).toContain("running");
    expect(metricValue(running, "Elapsed")).toBe("10s");
    expect(metricValue(running, "Updated")).toBeTruthy();

    await act(async () => vi.advanceTimersByTime(1_000));
    expect(metricValue(running, "Elapsed")).toBe("11s");
    expect(metricValue(completed, "Duration")).toBe("5s");

    completed.click();
    expect(onOpenRun).toHaveBeenCalledWith(completedRun.id);
  });

  it("keeps duplicate workflow names uniquely accessible through native button activation", async () => {
    const duplicateRun: RunRecord = {
      ...completedRun,
      id: "20260809023424-completed",
      createdAt: "2026-08-09T00:00:06.000Z",
      updatedAt: "2026-08-09T00:00:09.000Z",
    };
    await render({ runs: [completedRun, duplicateRun] });

    const buttons = [...container.querySelectorAll<HTMLButtonElement>(".run-card")];
    expect(buttons).toHaveLength(2);
    expect(new Set(buttons.map(button => button.getAttribute("aria-label"))).size).toBe(2);
  });

  it("renders dedicated loading, error, and empty states", async () => {
    await render({ runs: undefined, loading: true });
    expect(container.querySelector('[role="status"][aria-label="Loading runs"]')).not.toBeNull();

    const onRetry = vi.fn();
    await render({ runs: undefined, loading: true, error: new Error("store unavailable"), onRetry });
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("store unavailable");
    container.querySelector<HTMLButtonElement>(".runs-page-state .primary-button")!.click();
    expect(onRetry).toHaveBeenCalledOnce();

    await render({ runs: [], loading: false, error: null });
    expect(container.textContent).toContain("No runs yet");
    expect(container.textContent).toContain("acpus workflow run");
  });

  it("uses a minute clock for workspace activity metadata", async () => {
    await render({
      runs: [completedRun],
      workspaceCatalog: {
        currentWorkspaceKey: "ws_current",
        workspaces: [{
          key: "ws_current",
          name: "acpus",
          path: "/workspace/acpus",
          runCount: 1,
          lastRunUpdatedAt: "2026-08-08T23:46:00.000Z",
        }],
      },
    });

    const metadata = container.querySelector(".workspace-select-meta")!;
    expect(metadata.textContent).toBe("1 run · Updated 14m ago");
    await act(async () => vi.advanceTimersByTime(59_000));
    expect(metadata.textContent).toBe("1 run · Updated 14m ago");
    await act(async () => vi.advanceTimersByTime(1_000));
    expect(metadata.textContent).toBe("1 run · Updated 15m ago");
  });

  it("surfaces safe catalog state when a workspace run count is unavailable", async () => {
    await render({
      runs: [],
      workspaceCatalog: {
        currentWorkspaceKey: "ws_current",
        workspaces: [{
          key: "ws_current",
          name: "acpus",
          path: "/workspace/acpus",
        }],
      },
    });

    expect(container.querySelector(".workspace-select-meta")?.textContent)
      .toBe("Run count unavailable");
    expect(container.querySelector<HTMLButtonElement>('button[aria-label^="Workspace:"]')?.getAttribute("aria-label"))
      .toContain("last updated Unavailable");
  });

  it("returns the actual Runs scroll container to the top when workspace scope changes", async () => {
    const catalog = {
      currentWorkspaceKey: "ws_current",
      workspaces: [
        { key: "ws_current", name: "acpus", path: "/workspace/acpus", runCount: 2 },
        { key: "ws_remote", name: "reports", path: "/workspace/reports", runCount: 0 },
      ],
    };
    await render({ workspaceCatalog: catalog, selectedWorkspaceKey: "ws_current" });
    const content = container.querySelector<HTMLElement>(".runs-page-content")!;
    content.scrollTop = 240;

    await render({ workspaceCatalog: catalog, selectedWorkspaceKey: "ws_remote", runs: [] });
    expect(content.scrollTop).toBe(0);
  });

  it("sorts current first, then recent activity, with inactive workspaces last", () => {
    const sorted = sortWorkspaces([
      { key: "empty", name: "Alpha", path: "/alpha", runCount: 0 },
      { key: "recent", name: "Reports", path: "/reports", runCount: 2, lastRunUpdatedAt: "2026-08-09T00:00:00.000Z" },
      { key: "current", name: "Current", path: "/current", runCount: 1, lastRunUpdatedAt: "2026-08-08T00:00:00.000Z" },
      { key: "older", name: "Research", path: "/research", runCount: 3, lastRunUpdatedAt: "2026-08-07T00:00:00.000Z" },
    ], "current");

    expect(sorted.map(workspace => workspace.key)).toEqual(["current", "recent", "older", "empty"]);
  });

  it("freezes option ordering while the workspace selector is open", async () => {
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
    const initial = {
      currentWorkspaceKey: "current",
      workspaces: [
        { key: "current", name: "Current", path: "/current", runCount: 1 },
        { key: "alpha", name: "Alpha", path: "/alpha", runCount: 1, lastRunUpdatedAt: "2026-08-09T00:00:00.000Z" },
        { key: "beta", name: "Beta", path: "/beta", runCount: 1, lastRunUpdatedAt: "2026-08-08T00:00:00.000Z" },
      ],
    };
    await render({ workspaceCatalog: initial, selectedWorkspaceKey: "current" });
    const trigger = container.querySelector<HTMLButtonElement>('button[aria-label^="Workspace:"]')!;
    await act(async () => trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));

    const optionNames = () => [...document.body.querySelectorAll<HTMLElement>('[role="option"]')]
      .map(option => option.getAttribute("aria-label")?.split(",")[0]);
    expect(optionNames()).toEqual(["Current", "Alpha", "Beta"]);

    await render({
      workspaceCatalog: {
        ...initial,
        workspaces: initial.workspaces.map(workspace => workspace.key === "beta"
          ? { ...workspace, lastRunUpdatedAt: "2026-08-09T00:00:05.000Z" }
          : workspace),
      },
      selectedWorkspaceKey: "current",
    });
    expect(optionNames()).toEqual(["Current", "Alpha", "Beta"]);

    await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    await act(async () => trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
    expect(optionNames()).toEqual(["Current", "Beta", "Alpha"]);
    await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    await act(async () => vi.runOnlyPendingTimers());
  });
});
