import { describe, expect, it } from "vitest";
import { runPickerAction } from "../src/components/RunPicker.js";

describe("runPickerAction", () => {
  it("maps vim navigation keys to run selection movement", () => {
    expect(runPickerAction("k", {})).toBe("up");
    expect(runPickerAction("j", {})).toBe("down");
  });

  it("keeps arrow key navigation as a compatibility fallback", () => {
    expect(runPickerAction("", { upArrow: true })).toBe("up");
    expect(runPickerAction("", { downArrow: true })).toBe("down");
  });

  it("maps enter and quit controls", () => {
    expect(runPickerAction("", { return: true })).toBe("select");
    expect(runPickerAction("q", {})).toBe("quit");
    expect(runPickerAction("c", { ctrl: true })).toBe("quit");
  });

  it("ignores unrelated keys", () => {
    expect(runPickerAction("x", {})).toBeUndefined();
  });
});
