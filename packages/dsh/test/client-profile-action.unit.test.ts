// @vitest-environment jsdom

import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@deepseek-ai/dsh-client-ui-primitives", () => ({
  IconUserOutline16: ({ size = 16 }: { size?: number }) =>
    React.createElement("svg", { height: size, width: size }),
}));

import {
  AcpusBrandLabel,
  AcpusProfileAction,
  type AcpusBrandLabelProps,
  type AcpusProfileActionProps,
} from "../src/client/profile-action.js";
import type { AgentProfileView } from "../src/remote/types.js";

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

describe("Acpus Agent Profiles header action", () => {
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
    const readAgentProfiles = vi.fn(async () => profiles());
    await renderAction(readAgentProfiles, "default");
    expect(container.childElementCount).toBe(0);

    await renderAction(readAgentProfiles);
    const trigger = button("Agent Profiles");
    expect(trigger).toBeDefined();
    expect(trigger?.querySelector("svg")).not.toBeNull();
    expect(trigger?.getAttribute("aria-haspopup")).toBe("dialog");

    await act(async () => trigger?.click());
    const dialog = container.querySelector<HTMLElement>('[role="dialog"]');
    expect(readAgentProfiles).toHaveBeenCalledOnce();
    expect(dialog?.textContent).toContain("dsh");
    expect(dialog?.textContent).toContain("内置");
    expect(dialog?.textContent).toContain("codex-review");
    expect(dialog?.textContent).toContain("gpt-5.6-sol");
    expect(dialog?.textContent).toContain("Review implementation details.");
    expect(dialog?.querySelector('[aria-label="Agent: codex"]')).not.toBeNull();
    expect(dialog?.querySelectorAll("button")).toHaveLength(0);
  });

  it("reloads on every open, retries failures, and ignores a closed read", async () => {
    const first = deferred<AgentProfileView[]>();
    const readAgentProfiles = vi.fn(async () => profiles())
      .mockReturnValueOnce(first.promise)
      .mockRejectedValueOnce(new Error("unavailable"));
    await renderAction(readAgentProfiles);

    await act(async () => button("Agent Profiles")?.click());
    expect(container.querySelector('[role="status"]')?.textContent)
      .toContain("加载 Agent Profiles");
    await act(async () => button("Agent Profiles")?.click());
    await act(async () => button("Agent Profiles")?.click());
    expect(container.querySelector('[role="alert"]')?.textContent)
      .toContain("加载失败");

    const stale = [{ ...profiles()[0]!, id: "stale" }];
    await act(async () => first.resolve(stale));
    expect(container.textContent).not.toContain("stale");

    await act(async () => button("重试")?.click());
    expect(readAgentProfiles).toHaveBeenCalledTimes(3);
    expect(container.textContent).toContain("codex-review");

    await act(async () => button("Agent Profiles")?.click());
    await act(async () => button("Agent Profiles")?.click());
    expect(readAgentProfiles).toHaveBeenCalledTimes(4);
  });

  it("dismisses outside and restores trigger focus after Escape", async () => {
    await renderAction(vi.fn(async () => profiles()));
    const trigger = button("Agent Profiles")!;
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
  readAgentProfiles: () => Promise<AgentProfileView[]>,
  agentPreset = "acpus",
) {
  const props = {
    acpus: { readAgentProfiles },
    sessionId: "session-1",
    useSessions: (selector: (state: unknown) => unknown) => selector({
      byId: { "session-1": { agentPreset } },
    }),
  } as unknown as AcpusProfileActionProps;
  await act(async () => root.render(React.createElement(AcpusProfileAction, props)));
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

function profiles(): AgentProfileView[] {
  return [{
    id: "dsh",
    use: "dsh",
    guidance: "Built-in DSH fallback.",
    builtIn: true,
  }, {
    id: "codex-review",
    use: "codex",
    model: "gpt-5.6-sol",
    guidance: "Review implementation details.",
    builtIn: false,
  }];
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => {
    resolve = done;
  });
  return { promise, resolve };
}
