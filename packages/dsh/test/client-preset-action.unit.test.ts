// @vitest-environment jsdom

import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AcpusBrandLabel,
  AcpusPresetAction,
  type AcpusBrandLabelProps,
  type AcpusPresetActionProps,
} from "../src/client/preset-action.js";
import type { AgentPresetView } from "../src/remote/types.js";

let container: HTMLDivElement;
let root: Root;
let originalActEnvironment: PropertyDescriptor | undefined;

beforeEach(() => {
  originalActEnvironment = Object.getOwnPropertyDescriptor(
    globalThis,
    "IS_REACT_ACT_ENVIRONMENT",
  );
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
    configurable: true,
    value: true,
    writable: true,
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  if (originalActEnvironment === undefined) {
    Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  } else {
    Object.defineProperty(
      globalThis,
      "IS_REACT_ACT_ENVIRONMENT",
      originalActEnvironment,
    );
  }
});

describe("Acpus Agent Presets header action", () => {
  it("replaces the Acpus preset label with a non-interactive co-brand lockup", async () => {
    await renderBrand("default");
    expect(container.childElementCount).toBe(0);

    await renderBrand();
    const brand = container.querySelector<HTMLImageElement>('img[alt="Acpus × DSH"]');
    expect(brand).not.toBeNull();
    expect(brand?.classList.contains("acpus-header-brand")).toBe(true);
    expect(brand?.title).toContain("Acpus 持久化编排、调度与恢复");
    expect(brand?.closest("button")).toBeNull();
  });

  it("renders only for Acpus sessions and shows the complete read-only catalog", async () => {
    const readAgentPresets = vi.fn(async () => presets());
    await renderAction(readAgentPresets, "default");
    expect(container.childElementCount).toBe(0);

    await renderAction(readAgentPresets);
    const trigger = button("Agent Presets");
    expect(trigger).toBeDefined();
    expect(trigger?.querySelector("svg")).not.toBeNull();
    expect(trigger?.getAttribute("aria-haspopup")).toBe("dialog");

    await act(async () => trigger?.click());
    const dialog = container.querySelector<HTMLElement>('[role="dialog"]');
    expect(readAgentPresets).toHaveBeenCalledOnce();
    expect(dialog?.textContent).toContain("dsh");
    expect(dialog?.textContent).toContain("内置");
    expect(dialog?.textContent).toContain("codex-review");
    expect(dialog?.textContent).toContain("Review implementation details.");
    expect(dialog?.textContent).toContain("codex");
    expect(dialog?.textContent).toContain("gpt-test");
    expect(dialog?.textContent).toContain('"reasoning_effort":"high"');
    const dshRow = [...dialog?.querySelectorAll<HTMLElement>(".acpus-preset-row") ?? []]
      .find(row => row.textContent?.includes("Built-in DSH fallback."));
    const modelRow = [...dshRow?.querySelectorAll<HTMLElement>(".acpus-preset-meta > span") ?? []]
      .find(row => row.querySelector("b")?.textContent === "Model");
    expect(modelRow?.textContent).toBe("Model—");
    expect(document.activeElement).toBe(dialog);
    const dshIcon = dialog?.querySelector<HTMLImageElement>(
      '.acpus-preset-agent-icon[title="dsh"] img',
    );
    const codexIcon = dialog?.querySelector<HTMLImageElement>(
      '.acpus-preset-agent-icon[title="codex"] img',
    );
    expect(dshIcon).not.toBeNull();
    expect(codexIcon).not.toBeNull();
    expect(codexIcon?.src).not.toBe(dshIcon?.src);
    expect(dialog?.querySelectorAll("button")).toHaveLength(0);
  });

  it("reloads on every open, retries failures, and ignores a closed read", async () => {
    const first = deferred<AgentPresetView[]>();
    const readAgentPresets = vi.fn(async () => presets())
      .mockReturnValueOnce(first.promise)
      .mockRejectedValueOnce(new Error("unavailable"));
    await renderAction(readAgentPresets);

    await act(async () => button("Agent Presets")?.click());
    expect(container.querySelector('[role="status"]')?.textContent)
      .toContain("加载 Agent Presets");
    await act(async () => button("Agent Presets")?.click());
    await act(async () => button("Agent Presets")?.click());
    expect(container.querySelector('[role="alert"]')?.textContent)
      .toContain("加载失败");

    const stale = [{ ...presets()[0]!, id: "stale" }];
    await act(async () => first.resolve(stale));
    expect(container.textContent).not.toContain("stale");

    await act(async () => button("重试")?.click());
    expect(readAgentPresets).toHaveBeenCalledTimes(3);
    expect(container.textContent).toContain("codex-review");

    await act(async () => button("Agent Presets")?.click());
    await act(async () => button("Agent Presets")?.click());
    expect(readAgentPresets).toHaveBeenCalledTimes(4);
  });

  it("dismisses outside and restores trigger focus after Escape", async () => {
    await renderAction(vi.fn(async () => presets()));
    const trigger = button("Agent Presets")!;
    trigger.focus();
    await act(async () => trigger.click());

    await act(async () => {
      container.firstElementChild?.dispatchEvent(new KeyboardEvent("keydown", {
        bubbles: true,
        key: "Escape",
      }));
      await Promise.resolve();
    });
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);

    await act(async () => trigger.click());
    await act(async () => {
      document.body.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    });
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });
});

async function renderAction(
  readAgentPresets: () => Promise<AgentPresetView[]>,
  agentPreset = "acpus",
) {
  const props = {
    acpus: { readAgentPresets },
    sessionId: "session-1",
    useSessions: (selector: (state: unknown) => unknown) => selector({
      byId: { "session-1": { agentPreset } },
    }),
  } as unknown as AcpusPresetActionProps;
  await act(async () => root.render(React.createElement(AcpusPresetAction, props)));
}

async function renderBrand(agentPreset = "acpus") {
  const props = {
    sessionId: "session-1",
    useSessions: (selector: (state: unknown) => unknown) => selector({
      byId: { "session-1": { agentPreset } },
    }),
  } as unknown as AcpusBrandLabelProps;
  await act(async () => root.render(React.createElement(AcpusBrandLabel, props)));
}

function button(label: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll<HTMLButtonElement>("button")]
    .find(candidate => candidate.textContent?.trim() === label);
}

function presets(): AgentPresetView[] {
  return [{
    id: "dsh",
    guidance: "Built-in DSH fallback.",
    scope: "host",
    agent: { use: "dsh" },
  }, {
    id: "codex-review",
    guidance: "Review implementation details.",
    scope: "global",
    agent: {
      use: "codex",
      model: "gpt-test",
      config: [{ key: "reasoning_effort", value: "high" }],
    },
  }];
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => {
    resolve = done;
  });
  return { promise, resolve };
}
