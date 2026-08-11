// @vitest-environment jsdom

import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import {
  appNavigationApi,
  buttonByText,
  container,
  installViewTransitions,
  renderApp,
  runCard,
  runs,
  workspaceCatalog,
} from "./support/app-navigation-harness.js";
import { waitForReact } from "./support/react-act-environment.js";

const api = appNavigationApi();

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
