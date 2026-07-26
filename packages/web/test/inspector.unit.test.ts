// @vitest-environment jsdom

import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentOverview } from "../src/client/ui/App.js";
import { InspectorPanel, InspectorSection, JsonSection, KeyValue } from "../src/client/ui/Inspector.js";
import { useInspectorPresence } from "../src/client/ui/useInspectorPresence.js";
import { installReactActEnvironment } from "./support/react-act-environment.js";

type Target = { id: string };
type Presence = ReturnType<typeof useInspectorPresence<Target>>;

const originalMatchMedia = Object.getOwnPropertyDescriptor(window, "matchMedia");
const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");

let container: HTMLDivElement;
let root: Root | undefined;
let presence: Presence | undefined;
let restoreReactActEnvironment = () => {};

function PresenceHarness({ target, onExited }: { target: Target | undefined; onExited(): void }) {
  presence = useInspectorPresence(target, onExited);
  return null;
}

async function render(element: React.ReactNode): Promise<void> {
  root ??= createRoot(container);
  await act(async () => {
    root!.render(element);
  });
}

async function unmount(): Promise<void> {
  if (!root) return;
  const mountedRoot = root;
  root = undefined;
  await act(async () => {
    mountedRoot.unmount();
  });
}

function setReducedMotion(matches: boolean): void {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn().mockReturnValue({
      matches,
      media: "(prefers-reduced-motion: reduce)",
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }),
  });
}

function restoreProperty(target: object, key: PropertyKey, descriptor: PropertyDescriptor | undefined): void {
  if (descriptor) Object.defineProperty(target, key, descriptor);
  else Reflect.deleteProperty(target, key);
}

beforeEach(() => {
  restoreReactActEnvironment = installReactActEnvironment();
  vi.useFakeTimers();
  setReducedMotion(false);
  container = document.createElement("div");
  document.body.append(container);
  presence = undefined;
});

afterEach(async () => {
  await unmount();
  container.remove();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  restoreProperty(window, "matchMedia", originalMatchMedia);
  restoreProperty(navigator, "clipboard", originalClipboard);
  restoreReactActEnvironment();
});

describe("Inspector presence", () => {
  it("cancels an old close when the selected target changes", async () => {
    const onExited = vi.fn();
    await render(React.createElement(PresenceHarness, { target: { id: "a" }, onExited }));

    await act(async () => presence!.close());
    expect(presence).toMatchObject({ exiting: true, layoutState: "closing" });

    await render(React.createElement(PresenceHarness, { target: { id: "b" }, onExited }));
    expect(presence).toMatchObject({ exiting: false, layoutState: "open" });
    expect(vi.getTimerCount()).toBe(0);

    await act(async () => vi.runAllTimers());
    expect(onExited).not.toHaveBeenCalled();
    expect(presence).toMatchObject({ exiting: false, layoutState: "open" });
  });

  it("closes immediately when reduced motion is requested", async () => {
    const onExited = vi.fn();
    setReducedMotion(true);
    await render(React.createElement(PresenceHarness, { target: { id: "a" }, onExited }));

    await act(async () => presence!.close());

    expect(onExited).toHaveBeenCalledOnce();
    expect(presence?.exiting).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not invoke the exit callback after unmount", async () => {
    const onExited = vi.fn();
    await render(React.createElement(PresenceHarness, { target: { id: "a" }, onExited }));
    await act(async () => presence!.close());
    expect(vi.getTimerCount()).toBe(1);

    await unmount();
    await act(async () => vi.runAllTimers());

    expect(onExited).not.toHaveBeenCalled();
  });
});

describe("Inspector primitives", () => {
  it("keeps resource telemetry out of the Agent overview", async () => {
    vi.setSystemTime(new Date("2026-07-01T00:00:06.000Z"));
    await render(React.createElement(AgentOverview, {
      agent: {
        key: "observer",
        backend: { kind: "command" },
        availability: { context: "available", tokenUsage: "available" },
        model: "opus",
        turnCount: 2,
        lastObservedAt: "2026-07-01T00:00:04.000Z",
        context: { used: 26_100, size: 200_000 },
        tokenUsage: { inputTokens: 51_800, outputTokens: 205, totalTokens: 52_005 },
        tools: {
          totalCallCount: 3,
          recent: [
            { command: "Read", status: "completed" },
            { command: "Bash: rg", status: "in_progress" },
            { command: "Write", status: "failed" },
          ],
        },
      },
    }));

    expect(container.querySelector("h3")?.textContent).toBe("Agent State");
    expect([...container.querySelectorAll(".key-value")].map(row => row.textContent)).toEqual([
      "Agentobserver",
      "Modelopus",
      "Last observed2s ago",
    ]);
    expect(container.textContent).not.toContain("command");
  });

  it("keeps dialog, heading, key-value, Escape, and cleanup behavior", async () => {
    const onClose = vi.fn();
    await render(React.createElement(
      InspectorPanel,
      {
        title: "Node A",
        eyebrow: "Node",
        subtitle: "jobs item[2]",
        status: React.createElement("span", { className: "status-pill completed" }, "completed"),
        onClose,
        children: React.createElement(InspectorSection, {
          title: "Identity",
          children: React.createElement(KeyValue, { label: "Node ID", value: "node-a" }),
        }),
      },
    ));

    const dialog = container.querySelector<HTMLElement>("[role='dialog']")!;
    const keyValue = container.querySelector<HTMLElement>(".key-value")!;
    expect(dialog.getAttribute("aria-label")).toBe("Node A");
    expect(dialog.querySelector(".inspector-card-head span")?.textContent).toBe("Node");
    expect(dialog.querySelector(".inspector-card-head strong")?.textContent).toBe("Node A");
    expect(dialog.querySelector(".inspector-card-head small")?.textContent).toBe("jobs item[2]");
    expect(dialog.querySelector(".inspector-card-status .status-pill")?.textContent).toBe("completed");
    expect(dialog.querySelector(".inspector-card-body .status-pill")).toBeNull();
    expect(dialog.querySelector("h3")?.textContent).toBe("Identity");
    expect(keyValue.tabIndex).toBe(0);
    expect(keyValue.title).toBe("Node ID: node-a");
    expect(keyValue.getAttribute("aria-label")).toBe("Node ID: node-a");
    expect(keyValue.querySelector("span")?.textContent).toBe("Node ID");
    expect(keyValue.querySelector("strong")?.textContent).toBe("node-a");

    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    expect(onClose).toHaveBeenCalledOnce();
    await unmount();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("copies exact pretty JSON and resets success feedback", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const value = { zeta: 2, alpha: 1 };
    await render(React.createElement(JsonSection, { title: "Definition", value }));

    const button = container.querySelector<HTMLButtonElement>(".json-copy-button")!;
    await act(async () => {
      button.click();
      await Promise.resolve();
    });

    expect(writeText).toHaveBeenCalledWith(JSON.stringify(value, null, 2));
    expect(button.textContent).toContain("Copied");
    expect(container.querySelector(".json-viewer")).not.toBeNull();

    await act(async () => vi.advanceTimersByTime(1_400));
    expect(button.textContent).toContain("Copy JSON");
  });

  it("keeps nested JSON collapsed until the operator asks for detail", async () => {
    await render(React.createElement(JsonSection, { title: "Payload", value: { outer: { inner: 1 } } }));

    expect(container.querySelector(".json-viewer")?.textContent).toContain("outer");
    expect(container.querySelector(".json-viewer")?.textContent).not.toContain("inner");
    expect(container.querySelector(".json-ink-container")).not.toBeNull();
    expect(container.querySelector(".json-ink-label")).not.toBeNull();
  });

  it("can expose nested authored definitions immediately", async () => {
    await render(React.createElement(JsonSection, {
      title: "Definition",
      value: { kind: "switch", cases: ["input.mode === auto"] },
      expandNested: true,
    }));

    expect(container.querySelector(".json-viewer")?.textContent).toContain("input.mode === auto");
  });

  it("shows and resets failed clipboard feedback", async () => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn().mockRejectedValue(new Error("denied")) },
    });
    await render(React.createElement(JsonSection, { title: "Definition", value: { ok: true } }));

    const button = container.querySelector<HTMLButtonElement>(".json-copy-button")!;
    await act(async () => {
      button.click();
      await Promise.resolve();
    });
    expect(button.textContent).toContain("Copy failed");

    await act(async () => vi.advanceTimersByTime(1_800));
    expect(button.textContent).toContain("Copy JSON");
  });
});
