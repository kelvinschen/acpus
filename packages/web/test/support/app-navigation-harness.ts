import * as React from "react";
import { act } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, type Mock, vi } from "vitest";
import { App } from "../../src/client/ui/App.js";
import { installReactActEnvironment } from "./react-act-environment.js";

type AppNavigationApi = Record<
  | "getArtifactPreview"
  | "getConfig"
  | "getHealth"
  | "getNodeExecutionInspection"
  | "getNodeInspection"
  | "getNodeRuntimeValues"
  | "getRunRuntimeSnapshot"
  | "getRuntimeStore"
  | "listRuns"
  | "listWorkspaces"
  | "listWorkflowCatalog"
  | "listWorkflowFiles"
  | "repairRuntimeStore"
  | "submitRunCommand"
  | "visualizeWorkflow",
  Mock
>;

const api: AppNavigationApi = vi.hoisted(() => ({
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

vi.mock("../../src/client/api.js", async importOriginal => ({
  ...await importOriginal<typeof import("../../src/client/api.js")>(),
  ...api,
}));

vi.mock("../../src/client/ui/GraphWorkspace.js", async () => {
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

export function appNavigationApi(): typeof api {
  return api;
}

export const runs = [
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

export const workspaceCatalog = {
  currentWorkspaceKey: "ws_current",
  workspaces: [{
    key: "ws_current",
    name: "workspace",
    path: "/workspace",
    runCount: runs.length,
    lastRunUpdatedAt: runs.at(-1)!.updatedAt,
  }],
};

export const remoteRun = {
  id: "run_remote",
  name: "Remote Workflow",
  status: "completed",
  createdAt: "2026-08-08T23:00:00.000Z",
  updatedAt: "2026-08-08T23:00:12.000Z",
};

export const multiWorkspaceCatalog = {
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

export let container: HTMLDivElement;
let root: Root;
export let queryClient: QueryClient;
let restoreReactActEnvironment = () => {};

beforeEach(() => {
  restoreReactActEnvironment = installReactActEnvironment();
  window.history.replaceState(null, "", "/");
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
  window.history.replaceState(null, "", "/");
  restoreReactActEnvironment();
});

export async function renderApp(): Promise<void> {
  await act(async () => {
    root.render(React.createElement(QueryClientProvider, { client: queryClient }, React.createElement(App)));
    await new Promise(resolve => setTimeout(resolve, 0));
  });
}

export function buttonByText(label: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll<HTMLButtonElement>("button")]
    .find(button => button.textContent === label);
}

export function runCard(runId: string): HTMLButtonElement | null {
  return container.querySelector<HTMLButtonElement>(`button[aria-label*="run ${runId} in Run Monitor"]`);
}

export async function selectWorkspace(workspaceName: string): Promise<void> {
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

export function installViewTransitions({ reducedMotion = false, updateImmediately = true } = {}): {
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
