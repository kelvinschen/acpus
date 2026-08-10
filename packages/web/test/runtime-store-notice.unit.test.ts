// @vitest-environment jsdom

import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeStoreStatus } from "../src/api-types.js";
import { RuntimeStoreNotice } from "../src/client/ui/RuntimeStoreNotice.js";
import { installReactActEnvironment } from "./support/react-act-environment.js";

let container: HTMLDivElement;
let root: Root;
let restoreReactActEnvironment = () => {};

beforeEach(() => {
  restoreReactActEnvironment = installReactActEnvironment();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  restoreReactActEnvironment();
});

async function renderNotice(
  status: RuntimeStoreStatus | undefined,
  overrides: Partial<React.ComponentProps<typeof RuntimeStoreNotice>> = {},
) {
  const props: React.ComponentProps<typeof RuntimeStoreNotice> = {
    status,
    loadError: null,
    repairError: null,
    repairing: false,
    onFix: vi.fn(),
    onRetry: vi.fn(),
    ...overrides,
  };
  await act(async () => root.render(React.createElement(RuntimeStoreNotice, props)));
  return props;
}

function button(label: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll<HTMLButtonElement>("button")]
    .find(candidate => candidate.textContent?.trim() === label);
}

describe("Runtime store notice", () => {
  it("stays hidden while loading and when Runtime is ready", async () => {
    await renderNotice(undefined);
    expect(container.childElementCount).toBe(0);

    await renderNotice({ state: "ready" });
    expect(container.childElementCount).toBe(0);
  });

  it("fixes a repairable Runtime with one click and no confirmation", async () => {
    const props = await renderNotice({ state: "needs-fix", message: "Runtime data needs an update." });

    expect(container.textContent).toContain("Runtime data needs an update.");
    await act(async () => button("Fix")!.click());

    expect(props.onFix).toHaveBeenCalledOnce();
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  });

  it("keeps the fix action available after a failed attempt", async () => {
    const props = await renderNotice(
      { state: "needs-fix", message: "Runtime data needs an update." },
      { repairError: new Error("Runtime is busy.") },
    );

    expect(container.textContent).toContain("Runtime is busy.");
    await act(async () => button("Retry")!.click());
    expect(props.onFix).toHaveBeenCalledOnce();
  });

  it("shows unavailable Runtime without offering a fix", async () => {
    const props = await renderNotice({ state: "unavailable", message: "Use a compatible Acpus version." });

    expect(container.textContent).toContain("Use a compatible Acpus version.");
    expect(button("Fix")).toBeUndefined();
    expect(props.onFix).not.toHaveBeenCalled();
  });
});
