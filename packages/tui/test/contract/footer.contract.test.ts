import { describe, expect, it } from "vitest";
import { footerHintGroups } from "../../src/components/Footer.js";

describe("Footer hints", () => {
  it("shows graph navigation and global controls", () => {
    const hints = footerHintGroups("graph", 0);
    expect(hints.nav).toContainEqual({ key: "j/k", label: "select" });
    expect(hints.nav).toContainEqual({ key: "g/G", label: "top/bottom" });
    expect(hints.global).toContainEqual({ key: "s", label: "signal" });
  });

  it("hides mutating controls in read-only mode", () => {
    const hints = footerHintGroups("graph", 0, true);
    expect(hints.global).toContainEqual({ key: "read-only", label: "controls disabled" });
    expect(hints.global).toContainEqual({ key: "q", label: "quit" });
    expect(hints.global.some((hint) => hint.key === "p")).toBe(false);
    expect(hints.global.some((hint) => hint.key === "r")).toBe(false);
    expect(hints.global.some((hint) => hint.key === "c")).toBe(false);
    expect(hints.global.some((hint) => hint.key === "R")).toBe(false);
    expect(hints.global.some((hint) => hint.key === "s")).toBe(false);
  });

  it("shows details navigation with tab count", () => {
    const hints = footerHintGroups("details", 4);
    expect(hints.nav).toContainEqual({ key: "j/k", label: "scroll" });
    expect(hints.nav).toContainEqual({ key: "Space", label: "expand" });
    expect(hints.nav).toContainEqual({ key: "1-9", label: "tabs (4)" });
    expect(hints.nav).toContainEqual({ key: "y", label: "copy all" });
  });

  it("omits tab navigation when there are no detail sections", () => {
    const hints = footerHintGroups("details", 0);
    expect(hints.nav.some((hint) => hint.key === "1-9")).toBe(false);
  });
});
