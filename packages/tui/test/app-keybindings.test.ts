import { describe, expect, it } from "vitest";
import {
  detailSectionKeyForNumberInput,
  jsonDisplayResetKey,
  nextJsonCursor,
  scrollOffsetForCursor
} from "../src/components/App.js";
import { CONTROL_KEY_TO_ACTION, READ_ONLY_DISABLED_CONTROL_KEYS, isReadOnlyControlKey } from "../src/controls.js";
import type { DetailSection } from "../src/components/DetailsPane.js";

const sections: DetailSection[] = [
  { key: "summary", label: "Summary", lines: [] },
  { key: "prompt", label: "Prompt", lines: [] },
  { key: "output", label: "Output", lines: [] }
];

describe("App detail keybindings", () => {
  it("maps number keys to available detail tabs", () => {
    expect(detailSectionKeyForNumberInput("1", sections)).toBe("summary");
    expect(detailSectionKeyForNumberInput("2", sections)).toBe("prompt");
    expect(detailSectionKeyForNumberInput("3", sections)).toBe("output");
  });

  it("ignores non-number and out-of-range detail tab keys", () => {
    expect(detailSectionKeyForNumberInput("j", sections)).toBeUndefined();
    expect(detailSectionKeyForNumberInput("0", sections)).toBeUndefined();
    expect(detailSectionKeyForNumberInput("4", sections)).toBeUndefined();
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
