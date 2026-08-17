// @vitest-environment jsdom

import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AcpusActivityTray,
  type AcpusActivityTrayProps,
} from "../src/client/activity-tray.js";
import {
  AcpusClientState,
  type AcpusRemote,
} from "../src/client/state.js";
import type { SessionActivityProjection } from "../src/remote/types.js";

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
  vi.restoreAllMocks();
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

describe("Acpus activity tray interactions", () => {
  it("reveals and dismisses cancellation confirmation through a collapsible region", async () => {
    const acpus = await renderTray();

    const reveal = container.querySelector<HTMLElement>(".acpus-cancel-reveal")!;
    expect(reveal.getAttribute("aria-hidden")).toBe("true");
    expect(reveal.classList.contains("is-expanded")).toBe(false);

    await act(async () => button("Cancel")?.click());
    expect(reveal.getAttribute("aria-hidden")).toBe("false");
    expect(reveal.classList.contains("is-expanded")).toBe(true);

    await act(async () => button("返回")?.click());
    expect(reveal.getAttribute("aria-hidden")).toBe("true");
    expect(reveal.classList.contains("is-expanded")).toBe(false);
    acpus.dispose();
  });

  it("places whole-run total time immediately after the task title", async () => {
    const acpus = await renderTray();

    expect([...container.querySelector(".acpus-tray-summary")!.children]
      .map(element => element.textContent)).toEqual([
        "review",
        "总耗时 00:05",
        "正在执行 · active",
      ]);
    acpus.dispose();
  });

  it("shows retained activity as unavailable without offering a recovery action", async () => {
    const acpus = await renderTray(true);

    expect(container.querySelector(".acpus-activity-tray")?.getAttribute("data-status"))
      .toBe("running");
    expect(container.querySelector(".acpus-activity-tray")?.getAttribute("data-availability"))
      .toBe("unavailable");
    expect(container.querySelector(".acpus-availability")?.textContent).toContain("工作目录不可用");
    expect(container.querySelector(".acpus-availability")?.textContent).toContain("/missing/workspace");
    expect(container.querySelector(".acpus-tray-total-time")?.textContent).toBe("总耗时 00:02");
    expect(button("Cancel")).toBeUndefined();
    expect(button("重新检查")).toBeUndefined();
    acpus.dispose();
  });

});

async function renderTray(unavailable = false): Promise<AcpusClientState> {
  vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-08-14T00:00:05.000Z"));
  const acpus = new AcpusClientState({} as AcpusRemote);
  vi.spyOn(acpus, "watchSession").mockReturnValue(() => {});
  acpus.projections.set(projection(unavailable));

  await act(async () => root.render(React.createElement(AcpusActivityTray, {
    acpus,
    sessionId: "session-1",
    useSessions: (selector: (state: unknown) => unknown) => selector({
      byId: { "session-1": { agentPreset: "acpus" } },
    }),
  } as unknown as AcpusActivityTrayProps)));
  return acpus;
}

function button(label: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll<HTMLButtonElement>("button")]
    .find(candidate => candidate.textContent?.trim() === label);
}

function projection(unavailable = false): {
  sessions: Record<string, SessionActivityProjection>;
  connections: Record<string, { status: "connected"; synchronizedAt: number }>;
  selections: Record<string, undefined>;
} {
  const selector = { name: "review", occurrence: 1 };
  const counts = {
    total: 1,
    notStarted: 0,
    pending: 0,
    running: 1,
    awaiting: 0,
    completed: 0,
    failed: 0,
    timedOut: 0,
    canceled: 0,
  };
  const startedAt = "2026-08-14T00:00:00.000Z";
  const availability = unavailable
    ? {
        status: "unavailable" as const,
        reason: "workspace-unavailable" as const,
        workspace: "/missing/workspace",
        detail: "Restore the original path and retry.",
        detectedAt: "2026-08-14T00:00:02.000Z",
      }
    : { status: "available" as const };
  return {
    sessions: {
      "session-1": {
        sessionId: "session-1",
        revision: 1,
        tasks: [{
          task: selector,
          status: "running",
          availability,
          counts,
          startedAt,
        }],
        tasksTruncated: false,
        task: {
          selector,
          generation: 1,
          status: "running",
          availability,
          counts,
          startedAt,
          tree: [{
            activityId: "active",
            label: "active",
            kind: "agent",
            status: "running",
            startedAt,
            durationMs: 1_000,
            agent: { name: "codex" },
            children: [],
          }],
        },
      },
    },
    connections: {
      "session-1": { status: "connected", synchronizedAt: 1_000 },
    },
    selections: { "session-1": undefined },
  };
}
