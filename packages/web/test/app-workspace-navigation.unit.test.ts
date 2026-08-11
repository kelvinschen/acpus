// @vitest-environment jsdom

import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import {
  appNavigationApi,
  container,
  installViewTransitions,
  multiWorkspaceCatalog,
  queryClient,
  remoteRun,
  renderApp,
  runCard,
  runs,
  selectWorkspace,
  workspaceCatalog,
} from "./support/app-navigation-harness.js";
import { waitForReact } from "./support/react-act-environment.js";

const api = appNavigationApi();

describe("App workspace navigation", () => {
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

});
