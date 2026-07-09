import { describe, expect, it } from "vitest";
import { fmap, lift, lift2, lift3, md, template } from "@acpus/expression";
import { refExpr } from "@acpus/expression/ir";

describe("expression operators", () => {
  it("lowers fmap and lift calls to canonical operators", () => {
    const title = refExpr<string>(["input", "title"]);
    const ready = refExpr<boolean>(["input", "ready"]);
    const kind = refExpr<string>(["input", "kind"]);
    const count = refExpr<number>(["input", "count"]);
    const trim = (value: string) => value.trim();
    const release = (isReady: boolean, releaseKind: string) => isReady && releaseKind === "release";
    const releaseWithCount = (isReady: boolean, releaseKind: string, itemCount: number) => isReady && releaseKind === "release" && itemCount > 0;
    const releaseNamed = ({ ready, kind }: { ready: boolean; kind: string }) => ready && kind === "release";

    expect(fmap(title, trim).__ir).toEqual({
      kind: "call",
      fn: "fmap",
      args: [
        title.__ir,
        { kind: "literal", value: trim.toString() },
      ],
    });

    expect(lift2(ready, kind, release).__ir).toEqual({
      kind: "call",
      fn: "lift2",
      args: [
        ready.__ir,
        kind.__ir,
        { kind: "literal", value: release.toString() },
      ],
    });

    expect(lift3(ready, kind, count, releaseWithCount).__ir).toEqual({
      kind: "call",
      fn: "lift3",
      args: [
        ready.__ir,
        kind.__ir,
        count.__ir,
        { kind: "literal", value: releaseWithCount.toString() },
      ],
    });

    expect(lift({ ready, kind }, releaseNamed).__ir).toEqual({
      kind: "call",
      fn: "lift",
      args: [
        { kind: "object", fields: { ready: ready.__ir, kind: kind.__ir } },
        { kind: "literal", value: releaseNamed.toString() },
      ],
    });
  });

  it("lowers templates as expression nodes", () => {
    const length = (items: readonly string[]) => items.length;
    expect(template`count=${fmap(refExpr<readonly string[]>(["input", "items"]), length)}`.__ir).toEqual({
      kind: "template",
      template: {
        kind: "template",
        parts: [
          { kind: "text", value: "count=" },
          {
            kind: "expr",
            expr: {
              kind: "call",
              fn: "fmap",
              args: [
                { kind: "ref", path: ["input", "items"] },
                { kind: "literal", value: length.toString() },
              ],
            },
          },
          { kind: "text", value: "" },
        ],
      },
    });
  });

  it("dedents markdown templates while preserving expressions and Markdown structure", () => {
    expect(md`
      # Review

      Subject:
      ${refExpr<string>(["input", "subject"])}

      - keep item indentation
        - keep nested item indentation
    `.__ir).toEqual({
      kind: "template",
      template: {
        kind: "template",
        parts: [
          { kind: "text", value: "# Review\n\nSubject:\n" },
          { kind: "expr", expr: { kind: "ref", path: ["input", "subject"] } },
          { kind: "text", value: "\n\n- keep item indentation\n  - keep nested item indentation" },
        ],
      },
    });
  });
});
