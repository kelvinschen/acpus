// @vitest-environment jsdom

import * as React from "react";
import { act } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/client/ui/App.js";
import { installReactActEnvironment, waitForReact } from "./support/react-act-environment.js";

const api = vi.hoisted(() => ({
  getArtifactPreview: vi.fn(),
  getConfig: vi.fn(),
  getHealth: vi.fn(),
  getNodeExecutionInspection: vi.fn(),
  getNodeInspection: vi.fn(),
  getNodeRuntimeValues: vi.fn(),
  getRunRuntimeSnapshot: vi.fn(),
  getRuntimeStore: vi.fn(),
  listRuns: vi.fn(),
  listWorkspaces: vi.fn(),
  listWorkflowCatalog: vi.fn(),
  listWorkflowFiles: vi.fn(),
  repairRuntimeStore: vi.fn(),
  submitRunCommand: vi.fn(),
  visualizeWorkflow: vi.fn(),
}));

vi.mock("../src/client/api.js", async importOriginal => ({
  ...await importOriginal<typeof import("../src/client/api.js")>(),
  ...api,
}));

vi.mock("../src/client/ui/GraphWorkspace.js", async () => {
  const ReactModule = await import("react");
  return {
    GraphWorkspace: ({ target, onTargetChange, children }: any) => ReactModule.createElement(
      "section",
      { "aria-label": "Graph workspace" },
      ReactModule.createElement("span", { "data-testid": "graph-target" }, target?.kind ?? "none"),
      ReactModule.createElement("button", {
        type: "button",
        onClick: () => onTargetChange({
          kind: "node",
          node: {
            id: "selected",
            nodeId: "selected",
            target: "@selected",
            label: "selected",
            kind: "task",
            context: [],
            displayStatus: "running",
            detail: { kind: "task", target: "inline", input: "input" },
          },
        }),
      }, "Select test node"),
      children({ kind: "workflow" }),
    ),
  };
});

const runs = [
  {
    id: "run_alpha",
    name: "Shared Workflow",
    status: "completed",
    createdAt: "2026-08-09T00:00:00.000Z",
    updatedAt: "2026-08-09T00:00:05.000Z",
  },
  {
    id: "run_beta",
    name: "Shared Workflow",
    status: "completed",
    createdAt: "2026-08-09T00:01:00.000Z",
    updatedAt: "2026-08-09T00:01:08.000Z",
  },
];

const workspaceCatalog = {
  currentWorkspaceKey: "ws_current",
  workspaces: [{
    key: "ws_current",
    name: "workspace",
    path: "/workspace",
    runCount: runs.length,
    lastRunUpdatedAt: runs.at(-1)!.updatedAt,
  }],
};

const remoteRun = {
  id: "run_remote",
  name: "Remote Workflow",
  status: "completed",
  createdAt: "2026-08-08T23:00:00.000Z",
  updatedAt: "2026-08-08T23:00:12.000Z",
};

const multiWorkspaceCatalog = {
  ...workspaceCatalog,
  workspaces: [
    ...workspaceCatalog.workspaces,
    {
      key: "ws_remote",
      name: "reports",
      path: "/workspace/reports",
      runCount: 1,
      lastRunUpdatedAt: remoteRun.updatedAt,
    },
  ],
};

const originalScrollIntoView = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollIntoView");
const originalMatchMedia = Object.getOwnPropertyDescriptor(window, "matchMedia");
const originalStartViewTransition = Object.getOwnPropertyDescriptor(document, "startViewTransition");

let container: HTMLDivElement;
let root: Root;
let queryClient: QueryClient;
let restoreReactActEnvironment = () => {};

beforeEach(() => {
  restoreReactActEnvironment = installReactActEnvironment();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  queryClient = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity, retry: false }, mutations: { retry: false } } });

  api.listWorkspaces.mockReset().mockResolvedValue(workspaceCatalog);
  api.getRuntimeStore.mockReset().mockResolvedValue({ state: "ready" });
  api.repairRuntimeStore.mockReset().mockResolvedValue(undefined);
  api.listRuns.mockReset().mockResolvedValue(runs);
  api.getHealth.mockReset().mockResolvedValue({ checks: [] });
  api.getConfig.mockReset().mockResolvedValue({ cwd: "/workspace", access: "open" });
  api.getRunRuntimeSnapshot.mockReset().mockImplementation(async (_workspaceKey: string, runId: string) => snapshot(runId));
  api.getNodeInspection.mockReset().mockResolvedValue({
    nodeId: "selected",
    status: "running",
    timing: {},
    artifacts: [],
  });
  api.getArtifactPreview.mockReset();
  api.getNodeExecutionInspection.mockReset();
  api.getNodeRuntimeValues.mockReset();
  api.listWorkflowCatalog.mockReset().mockResolvedValue([]);
  api.listWorkflowFiles.mockReset().mockResolvedValue({ dir: "", entries: [] });
  api.submitRunCommand.mockReset().mockResolvedValue(undefined);
  api.visualizeWorkflow.mockReset();
});

afterEach(async () => {
  await act(async () => root.unmount());
  queryClient.clear();
  container.remove();
  vi.restoreAllMocks();
  if (originalScrollIntoView) Object.defineProperty(HTMLElement.prototype, "scrollIntoView", originalScrollIntoView);
  else Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
  restoreProperty(window, "matchMedia", originalMatchMedia);
  restoreProperty(document, "startViewTransition", originalStartViewTransition);
  delete document.documentElement.dataset.runTransition;
  restoreReactActEnvironment();
});

async function renderApp(): Promise<void> {
  await act(async () => {
    root.render(React.createElement(QueryClientProvider, { client: queryClient }, React.createElement(App)));
    await new Promise(resolve => setTimeout(resolve, 0));
  });
}

function buttonByText(label: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll<HTMLButtonElement>("button")]
    .find(button => button.textContent === label);
}

function runCard(runId: string): HTMLButtonElement | null {
  return container.querySelector<HTMLButtonElement>(`button[aria-label*="run ${runId} in Run Monitor"]`);
}

async function selectWorkspace(workspaceName: string): Promise<void> {
  const trigger = container.querySelector<HTMLButtonElement>('button[aria-label^="Workspace:"]')!;
  trigger.focus();
  await act(async () => {
    trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    await new Promise(resolve => setTimeout(resolve, 0));
  });
  const option = [...document.body.querySelectorAll<HTMLElement>('[role="option"]')]
    .find(candidate => candidate.getAttribute("aria-label")?.startsWith(`${workspaceName},`));
  expect(option).toBeDefined();
  await act(async () => {
    option!.click();
    await new Promise(resolve => setTimeout(resolve, 0));
  });
}

function snapshot(runId: string) {
  const run = runs.find(candidate => candidate.id === runId)!;
  return {
    run: { ...run, input: {} },
    workflow: { name: run.name, agents: {} },
    graph: undefined,
    controls: { canCancelRun: false, retryTargets: [] },
  };
}

type FakeViewTransition = {
  direction: string | undefined;
  finished: Promise<void>;
  finish(): void;
  runUpdate(): void;
  skipTransition: ReturnType<typeof vi.fn>;
};

function installViewTransitions({ reducedMotion = false, updateImmediately = true } = {}): {
  start: ReturnType<typeof vi.fn>;
  transitions: FakeViewTransition[];
} {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn().mockImplementation((media: string) => ({
      matches: reducedMotion && media === "(prefers-reduced-motion: reduce)",
      media,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
  const transitions: FakeViewTransition[] = [];
  const start = vi.fn().mockImplementation((update: () => void) => {
    let resolveFinished = () => {};
    const finished = new Promise<void>(resolve => {
      resolveFinished = resolve;
    });
    let updated = false;
    const transition: FakeViewTransition = {
      direction: document.documentElement.dataset.runTransition,
      finished,
      finish: resolveFinished,
      runUpdate: () => {
        if (updated) return;
        updated = true;
        update();
      },
      skipTransition: vi.fn(() => resolveFinished()),
    };
    transitions.push(transition);
    if (updateImmediately) transition.runUpdate();
    return transition;
  });
  Object.defineProperty(document, "startViewTransition", { configurable: true, value: start });
  return { start, transitions };
}

function restoreProperty(target: object, key: PropertyKey, descriptor: PropertyDescriptor | undefined): void {
  if (descriptor) Object.defineProperty(target, key, descriptor);
  else Reflect.deleteProperty(target, key);
}

describe("App run navigation", () => {
  it("fixes a repairable Runtime store with one action", async () => {
    api.getRuntimeStore
      .mockResolvedValueOnce({ state: "needs-fix", message: "Runtime data needs an update." })
      .mockResolvedValue({ state: "ready" });

    await renderApp();
    await waitForReact(() => expect(buttonByText("Fix")).toBeDefined());
    expect(document.querySelector('[role="dialog"]')).toBeNull();

    await act(async () => buttonByText("Fix")!.click());

    await waitForReact(() => expect(api.repairRuntimeStore).toHaveBeenCalledOnce());
    await waitForReact(() => expect(container.textContent).toContain("Runtime fixed"));
    expect(api.getRuntimeStore.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(api.listWorkspaces.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(api.listRuns.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(api.getHealth.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("opens on Runs without selecting a run, then enters and leaves Run Monitor", async () => {
    await renderApp();
    await waitForReact(() => expect(runCard("run_alpha")).not.toBeNull());

    expect(container.querySelector(".runs-page-header h2")?.textContent).toBe("Runs");
    expect(container.querySelector('.nav-button[aria-label="Runs"]')?.getAttribute("aria-current")).toBe("page");
    expect(api.getRunRuntimeSnapshot).not.toHaveBeenCalled();

    await act(async () => {
      runCard("run_alpha")!.click();
      await new Promise(resolve => setTimeout(resolve, 0));
    });
    expect(buttonByText("Select test node")).toBeDefined();
    expect(api.getRunRuntimeSnapshot).toHaveBeenCalledWith("ws_current", "run_alpha");
    expect(container.querySelector('.nav-button[aria-label="Runs"]')?.getAttribute("aria-current")).toBe("page");

    await act(async () => buttonByText("Select test node")!.click());
    expect(container.querySelector('[data-testid="graph-target"]')?.textContent).toBe("node");

    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Back to Runs"]')!.click());
    expect(container.querySelector(".runs-page-header h2")?.textContent).toBe("Runs");

    await act(async () => {
      runCard("run_beta")!.click();
      await new Promise(resolve => setTimeout(resolve, 0));
    });
    expect(api.getRunRuntimeSnapshot).toHaveBeenCalledWith("ws_current", "run_beta");
    expect(container.querySelector('[data-testid="graph-target"]')?.textContent).toBe("none");
  });

  it("switches runs from Run Monitor without keeping the old graph selection", async () => {
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
    await renderApp();
    await waitForReact(() => expect(runCard("run_alpha")).not.toBeNull());
    await act(async () => {
      runCard("run_alpha")!.click();
      await new Promise(resolve => setTimeout(resolve, 0));
    });
    await act(async () => buttonByText("Select test node")!.click());
    expect(container.querySelector('[data-testid="graph-target"]')?.textContent).toBe("node");

    const trigger = container.querySelector<HTMLButtonElement>('button[aria-label="Select run"]')!;
    trigger.focus();
    await act(async () => {
      trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
      await new Promise(resolve => setTimeout(resolve, 0));
    });
    const betaOption = [...document.body.querySelectorAll<HTMLElement>('[role="option"]')]
      .find(option => option.getAttribute("aria-label")?.includes("run run_beta"));
    expect(betaOption).toBeDefined();
    const optionLabels = [...document.body.querySelectorAll<HTMLElement>('[role="option"]')]
      .map(option => option.getAttribute("aria-label"));
    expect(new Set(optionLabels).size).toBe(runs.length);
    await act(async () => {
      betaOption!.click();
      await new Promise(resolve => setTimeout(resolve, 0));
      await new Promise(resolve => setTimeout(resolve, 0));
    });

    expect(api.getRunRuntimeSnapshot).toHaveBeenCalledWith("ws_current", "run_beta");
    expect(container.querySelector('[data-testid="graph-target"]')?.textContent).toBe("none");
    await waitForReact(() => expect(container.querySelector(".run-meta")?.textContent).toContain("run_beta"));
  });

  it("animates forward and back while safely interrupting the prior transition", async () => {
    const viewTransitions = installViewTransitions();
    await renderApp();
    await waitForReact(() => expect(runCard("run_alpha")).not.toBeNull());
    expect(viewTransitions.start).not.toHaveBeenCalled();

    await act(async () => {
      runCard("run_alpha")!.click();
      await new Promise(resolve => setTimeout(resolve, 0));
    });
    expect(viewTransitions.transitions[0]?.direction).toBe("forward");
    expect(container.querySelector('[aria-label="Run Monitor"]')).not.toBeNull();

    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[aria-label="Back to Runs"]')!.click();
      await Promise.resolve();
    });
    expect(viewTransitions.transitions[0]?.skipTransition).toHaveBeenCalledOnce();
    expect(viewTransitions.transitions[1]?.direction).toBe("back");
    expect(document.documentElement.dataset.runTransition).toBe("back");
    expect(container.querySelector(".runs-page")).not.toBeNull();

    viewTransitions.transitions[1]!.finish();
    await act(async () => Promise.resolve());
    expect(document.documentElement.dataset.runTransition).toBeUndefined();
  });

  it("switches immediately without the animation API when reduced motion is requested", async () => {
    const viewTransitions = installViewTransitions({ reducedMotion: true });
    await renderApp();
    await waitForReact(() => expect(runCard("run_alpha")).not.toBeNull());

    await act(async () => runCard("run_alpha")!.click());
    expect(container.querySelector('[aria-label="Run Monitor"]')).not.toBeNull();
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Back to Runs"]')!.click());
    expect(container.querySelector(".runs-page")).not.toBeNull();
    expect(viewTransitions.start).not.toHaveBeenCalled();
  });

  it("ignores a superseded transition update callback", async () => {
    const viewTransitions = installViewTransitions({ updateImmediately: false });
    await renderApp();
    await waitForReact(() => expect(runCard("run_alpha")).not.toBeNull());

    await act(async () => runCard("run_alpha")!.click());
    expect(viewTransitions.transitions).toHaveLength(1);
    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[aria-label="Workflows"]')!.click();
      await new Promise(resolve => setTimeout(resolve, 0));
    });
    expect(viewTransitions.transitions[0]?.skipTransition).toHaveBeenCalledOnce();
    expect(container.querySelector(".workflow-viz-grid")).not.toBeNull();

    await act(async () => viewTransitions.transitions[0]!.runUpdate());
    expect(container.querySelector('[aria-label="Run Monitor"]')).toBeNull();
    expect(container.querySelector(".workflow-viz-grid")).not.toBeNull();
  });

  it("switches workspace scope without a page animation and keeps remote Run Monitor read only", async () => {
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
    const viewTransitions = installViewTransitions();
    api.listWorkspaces.mockResolvedValue(multiWorkspaceCatalog);
    api.listRuns.mockImplementation(async (workspaceKey: string) => workspaceKey === "ws_remote" ? [remoteRun] : runs);
    api.getRunRuntimeSnapshot.mockImplementation(async (workspaceKey: string, runId: string) => {
      const run = workspaceKey === "ws_remote" ? remoteRun : runs.find(candidate => candidate.id === runId)!;
      return {
        run: { ...run, input: {} },
        workflow: { name: run.name, agents: {} },
        graph: undefined,
        controls: { canCancelRun: false, retryTargets: [] },
      };
    });

    await renderApp();
    await waitForReact(() => expect(runCard("run_alpha")).not.toBeNull());
    await selectWorkspace("reports");

    await waitForReact(() => expect(runCard(remoteRun.id)).not.toBeNull());
    expect(runCard("run_alpha")).toBeNull();
    expect(api.listRuns).toHaveBeenCalledWith("ws_remote");
    expect(viewTransitions.start).not.toHaveBeenCalled();

    await act(async () => {
      runCard(remoteRun.id)!.click();
      await new Promise(resolve => setTimeout(resolve, 0));
    });
    await waitForReact(() => expect(api.getRunRuntimeSnapshot).toHaveBeenCalledWith("ws_remote", remoteRun.id));
    expect(container.querySelector(".run-workspace-identity")?.textContent).toContain("reports");
    expect(container.querySelector(".workspace-access-state")?.textContent).toContain("Read only");
    expect(container.querySelector(".control-strip")).toBeNull();

    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Back to Runs"]')!.click());
    expect(container.querySelector<HTMLButtonElement>('button[aria-label^="Workspace:"]')?.getAttribute("aria-label")).toContain("reports");
    expect(runCard(remoteRun.id)).not.toBeNull();
  });

  it("keeps a lost monitor workspace on an explicit error surface with Back and no controls", async () => {
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
    api.listWorkspaces.mockResolvedValue(multiWorkspaceCatalog);
    api.listRuns.mockImplementation(async (workspaceKey: string) => workspaceKey === "ws_remote" ? [remoteRun] : runs);
    api.getRunRuntimeSnapshot.mockResolvedValue({
      run: { ...remoteRun, input: {} },
      workflow: { name: remoteRun.name, agents: {} },
      graph: undefined,
      controls: { canCancelRun: true, retryTargets: [] },
    });

    await renderApp();
    await waitForReact(() => expect(runCard("run_alpha")).not.toBeNull());
    await selectWorkspace("reports");
    await waitForReact(() => expect(runCard(remoteRun.id)).not.toBeNull());
    await act(async () => {
      runCard(remoteRun.id)!.click();
      await new Promise(resolve => setTimeout(resolve, 0));
    });
    await waitForReact(() => expect(container.querySelector('[aria-label="Run Monitor"]')).not.toBeNull());

    api.listWorkspaces.mockResolvedValue(workspaceCatalog);
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ["workspaces"] });
    });

    await waitForReact(() => expect(container.querySelector(".workspace-unavailable-state")).not.toBeNull());
    expect(container.querySelector(".workspace-unavailable-state")?.textContent).toContain("Workspace unavailable");
    expect(container.querySelector<HTMLButtonElement>('button[aria-label="Back to Runs"]')).not.toBeNull();
    expect(container.querySelector(".workspace-access-state")?.textContent).toContain("Unavailable");
    expect(container.querySelector('[aria-label="Select run"]')).toBeNull();
    expect(container.querySelector(".control-strip")).toBeNull();
  });

  it("falls back to the current workspace with a toast when a selected Runs workspace disappears", async () => {
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
    api.listWorkspaces.mockResolvedValue(multiWorkspaceCatalog);
    api.listRuns.mockImplementation(async (workspaceKey: string) => workspaceKey === "ws_remote" ? [remoteRun] : runs);
    await renderApp();
    await waitForReact(() => expect(runCard("run_alpha")).not.toBeNull());
    await selectWorkspace("reports");
    await waitForReact(() => expect(runCard(remoteRun.id)).not.toBeNull());

    api.listWorkspaces.mockResolvedValue(workspaceCatalog);
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ["workspaces"] });
    });

    await waitForReact(() => expect(runCard("run_alpha")).not.toBeNull());
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Returned to the current workspace");
    expect(container.querySelector<HTMLButtonElement>('button[aria-label^="Workspace:"]')?.getAttribute("aria-label")).toContain("workspace");
  });

  it("retries a failed initial catalog before requesting scoped runs", async () => {
    api.listWorkspaces
      .mockRejectedValueOnce(new Error("catalog unavailable"))
      .mockResolvedValueOnce(workspaceCatalog);

    await renderApp();
    await waitForReact(() => expect(container.querySelector('[role="alert"]')?.textContent).toContain("catalog unavailable"));
    expect(api.listRuns).not.toHaveBeenCalled();

    await act(async () => {
      container.querySelector<HTMLButtonElement>(".runs-page-retry")!.click();
      await new Promise(resolve => setTimeout(resolve, 0));
    });

    await waitForReact(() => expect(api.listRuns).toHaveBeenCalledWith("ws_current"));
    expect(api.listRuns).not.toHaveBeenCalledWith(undefined);
  });
});
