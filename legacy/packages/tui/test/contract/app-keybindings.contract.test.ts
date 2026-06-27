import { describe, expect, it } from "vitest";
import {
  TUI_REFRESH_INTERVAL_MS,
  controlConfirmationMessage,
  detailSectionKeyForNumberInput,
  jsonDisplayResetKey,
  nextJsonCursor,
  runElapsedMs,
  scrollOffsetForCursor
} from "../../src/components/App.js";
import { CONTROL_KEY_TO_ACTION, READ_ONLY_DISABLED_CONTROL_KEYS, isReadOnlyControlKey } from "../../src/controls.js";
import type { DetailSection } from "../../src/components/DetailsPane.js";

const sections: DetailSection[] = [
  { key: "summary", label: "Summary", lines: [] },
  { key: "execution", label: "Execution", lines: [] },
  { key: "prompt", label: "Prompt", lines: [] },
  { key: "output", label: "Output", lines: [] }
];

describe("App detail keybindings", () => {
  it("uses normal and low refresh cadences for terminal and served visualizers", () => {
    expect(TUI_REFRESH_INTERVAL_MS.normal).toBe(1000);
    expect(TUI_REFRESH_INTERVAL_MS.low).toBe(3000);
  });

  it("builds confirmation prompts for important controls", () => {
    expect(controlConfirmationMessage({ action: "cancel", scope: "run", targetLabel: "run_1" })).toBe("Cancel run run_1?");
    expect(controlConfirmationMessage({ action: "retry", scope: "node", targetLabel: "workflow/task" })).toBe("Retry node workflow/task?");
    expect(controlConfirmationMessage({ action: "signal", scope: "node", targetLabel: "workflow/gate", signalBoolField: "approved" })).toBe("Signal node workflow/gate: set approved?");
  });

  it("computes live elapsed from the ticker clock and terminal elapsed from updatedAt", () => {
    const run = {
      status: "running",
      createdAt: "2026-06-12T00:00:00.000Z",
      updatedAt: "2026-06-12T00:00:01.000Z"
    };
    expect(runElapsedMs(run, Date.parse("2026-06-12T00:00:05.000Z"))).toBe(5000);
    expect(runElapsedMs({ ...run, status: "completed" }, Date.parse("2026-06-12T00:00:05.000Z"))).toBe(1000);
  });

  it("maps number keys to available detail tabs", () => {
    expect(detailSectionKeyForNumberInput("1", sections)).toBe("summary");
    expect(detailSectionKeyForNumberInput("2", sections)).toBe("execution");
    expect(detailSectionKeyForNumberInput("3", sections)).toBe("prompt");
    expect(detailSectionKeyForNumberInput("4", sections)).toBe("output");
  });

  it("ignores non-number and out-of-range detail tab keys", () => {
    expect(detailSectionKeyForNumberInput("j", sections)).toBeUndefined();
    expect(detailSectionKeyForNumberInput("0", sections)).toBeUndefined();
    expect(detailSectionKeyForNumberInput("5", sections)).toBeUndefined();
  });

  it("moves a JSON cursor inside visible row bounds", () => {
    expect(nextJsonCursor(0, -1, 4)).toBe(0);
    expect(nextJsonCursor(0, 1, 4)).toBe(1);
    expect(nextJsonCursor(3, 1, 4)).toBe(3);
    expect(nextJsonCursor(3, 1, 0)).toBe(0);
  });

  it("keeps the selected JSON row inside the details scroll window", () => {
    expect(scrollOffsetForCursor(0, 3, 5)).toBe(0);
    expect(scrollOffsetForCursor(7, 3, 5)).toBe(3);
    expect(scrollOffsetForCursor(8, 3, 5)).toBe(4);
  });

  it("keeps the JSON display identity stable across live data refreshes", () => {
    const first = { matched: true, action: "continue" };
    const refreshed = { matched: true, action: "continue" };

    expect(jsonDisplayResetKey("workflow/check", "output", first)).toBe(
      jsonDisplayResetKey("workflow/check", "output", refreshed)
    );
  });

  it("derives read-only disabled keys from the control key map", () => {
    expect([...READ_ONLY_DISABLED_CONTROL_KEYS].sort()).toEqual(Object.keys(CONTROL_KEY_TO_ACTION).sort());
    for (const key of Object.keys(CONTROL_KEY_TO_ACTION)) {
      expect(isReadOnlyControlKey(key)).toBe(true);
    }
    expect(isReadOnlyControlKey("j")).toBe(false);
  });
});
