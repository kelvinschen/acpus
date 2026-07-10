import { describe, expect, it } from "vitest";
import { evaluateExpr, ExpressionEvaluationError, renderTemplate } from "@acpus/expression/evaluator";
import { fmap, lift, lift2, lift3 } from "@acpus/expression";
import { refExpr } from "@acpus/expression/ir";

describe("expression evaluator", () => {
  const adapter = {
    resolveRef: (path: string[]) => {
      const key = path.join(".");
      if (key === "input.count") return 2;
      if (key === "input.title") return "  Ship   now  ";
      if (key === "input.ready") return true;
      if (key === "input.kind") return "release";
      if (key === "input.maxItems") return 5;
      if (key === "input.items") return [{ id: "a", done: true }, { id: "b", done: false }];
      if (key === "input.issue") return { title: "  Ship  ", labels: ["urgent"] };
      return undefined;
    },
  };

  it("evaluates literal expressions through the evaluator seam", () => {
    expect(evaluateExpr({ kind: "literal", value: true }, { resolveRef: () => undefined })).toBe(true);
  });

  it("formats template expression values", () => {
    expect(renderTemplate({
      kind: "template",
      parts: [
        { kind: "text", value: "value=" },
        { kind: "expr", expr: { kind: "object", fields: { ok: { kind: "literal", value: true } } } },
      ],
    }, { resolveRef: () => undefined })).toBe("value={\"ok\":true}");
  });

  it("evaluates fmap over JSON values", () => {
    expect(evaluateExpr(fmap(refExpr<number>(["input", "count"]), value => value + 1).__ir, adapter)).toBe(3);
    expect(evaluateExpr(fmap(refExpr<number>(["input", "count"]), value => {
      const next = value + 1;
      return next;
    }).__ir, adapter)).toBe(3);
    expect(evaluateExpr(fmap(refExpr<string>(["input", "title"]), value => value.trim().replace(/\s+/g, " ")).__ir, adapter)).toBe("Ship now");
    expect(evaluateExpr(fmap(refExpr<readonly { id: string; done: boolean }[]>(["input", "items"]), items => items.filter(item => item.done).map(item => item.id)).__ir, adapter))
      .toEqual(["a"]);
  });

  it("evaluates lift variants over explicit dependencies", () => {
    const ready = refExpr<boolean>(["input", "ready"]);
    const kind = refExpr<string>(["input", "kind"]);
    const maxItems = refExpr<number>(["input", "maxItems"]);
    expect(evaluateExpr(lift2(ready, kind, (ready, kind) => ready && kind === "release").__ir, adapter)).toBe(true);
    expect(evaluateExpr(lift2(ready, kind, (ready, kind) => {
      const matches = ready && kind === "release";
      return matches;
    }).__ir, adapter)).toBe(true);
    expect(evaluateExpr(lift3(ready, kind, maxItems, (ready, kind, maxItems) => ready && kind === "release" && maxItems > 0).__ir, adapter)).toBe(true);
    expect(evaluateExpr(lift3(ready, kind, maxItems, (ready, kind, maxItems) => {
      const matches = ready && kind === "release";
      return matches && maxItems > 0;
    }).__ir, adapter)).toBe(true);
    expect(evaluateExpr(lift({ ready, kind, maxItems }, ({ ready, kind, maxItems }) => {
      const matches = ready && kind === "release";
      return matches && maxItems > 0;
    }).__ir, adapter)).toBe(true);
  });

  it("allows runtime globals and nondeterministic Math.random", () => {
    expect(evaluateExpr(fmap(refExpr<number>(["input", "count"]), value => Math.floor(value + Math.random() * 0)).__ir, adapter)).toBe(2);
    expect(evaluateExpr(fmap(refExpr<{ title: string }>(["input", "issue"]), value => JSON.stringify({ title: value.title.trim() })).__ir, adapter)).toBe("{\"title\":\"Ship\"}");
    expect(typeof evaluateExpr(fmap(refExpr<number>(["input", "count"]), _value => Date.now()).__ir, adapter)).toBe("number");
  });

  it("evaluates internal access and preserves missing projection semantics", () => {
    const transformed = fmap(refExpr<{ title: string; labels: readonly string[] }>(["input", "issue"]), issue => ({
      title: issue.title.trim(),
      meta: { labels: issue.labels },
    }));
    expect(evaluateExpr(transformed.title.__ir, adapter)).toBe("Ship");
    expect(evaluateExpr(transformed.meta.labels[0]!.__ir, adapter)).toBe("urgent");
    expect(evaluateExpr(transformed.meta.labels[10]!.__ir, adapter)).toBeUndefined();
  });

  it("passes missing callback dependencies as undefined", () => {
    expect(evaluateExpr(fmap(refExpr<string | undefined>(["input", "missing"]), value => value ?? "fallback").__ir, adapter))
      .toBe("fallback");
    expect(evaluateExpr(fmap(refExpr<readonly string[]>(["input", "empty"])[0], value => value ?? "fallback").__ir, adapter))
      .toBe("fallback");
    expect(evaluateExpr(lift({ maybe: refExpr<string | undefined>(["input", "missing"]) }, ({ maybe }) => maybe ?? "fallback").__ir, adapter))
      .toBe("fallback");
    expect(evaluateExpr(lift({ nested: { maybe: refExpr<string | undefined>(["input", "missing"]) } }, ({ nested }) => nested.maybe ?? "fallback").__ir, adapter))
      .toBe("fallback");
  });

  it("deep clones callback inputs before invocation", () => {
    const source = {
      kind: "call" as const,
      fn: "fmap",
      args: [
        { kind: "ref" as const, path: ["input", "items"] },
        { kind: "literal" as const, value: "items => (items[0].id = 'changed', items)" },
      ],
    };
    const items = [{ id: "a", done: true }];
    const localAdapter = { resolveRef: () => items };
    expect(evaluateExpr(source, localAdapter)).toEqual([{ id: "changed", done: true }]);
    expect(items).toEqual([{ id: "a", done: true }]);
  });

  it("rejects invalid callbacks and outputs", () => {
    const evaluateSource = (source: string) => evaluateExpr({
      kind: "call" as const,
      fn: "fmap",
      args: [{ kind: "literal" as const, value: 1 }, { kind: "literal" as const, value: source }],
    }, adapter);

    expect(() => evaluateSource("1")).toThrow("fmap(...) callback source must be an arrow function.");
    expect(evaluateSource("value => { return value; }")).toBe(1);
    expect(evaluateSource("value => /* comment */ { return value; }")).toBe(1);
    expect(() => evaluateExpr({ kind: "call", fn: "fmap", args: [{ kind: "literal", value: 1 }, { kind: "ref", path: ["input", "source"] }] }, adapter))
      .toThrow("fmap(...) expected callback source string.");
    expect(() => evaluateExpr(fmap(1, _value => Promise.resolve(1) as any).__ir, adapter))
      .toThrow("fmap(...) callback must return synchronously.");
    for (const source of [
      "_value => new Date(0)",
      "_value => { return new Date(0); }",
      "_value => () => 1",
      "_value => new (class View {})()",
      "_value => new Map()",
      "_value => new Set()",
      "_value => Symbol('x')",
      "_value => 1n",
      "_value => ({ nested: { bad: Number.POSITIVE_INFINITY } })",
      "_value => ([, 'x'])",
      "_value => undefined",
      "_value => ({ bad: undefined })",
    ]) {
      expect(() => evaluateSource(source)).toThrow("fmap(...) expected JSON-compatible values.");
    }
    expect(() => evaluateSource("_value => (() => { throw new Error('boom'); })()"))
      .toThrow("fmap(...) callback threw: boom");
    expect(() => evaluateSource("_value => (() => { throw new Error('boom'); })()"))
      .toThrow(ExpressionEvaluationError);
  });

  it.each([
    ["lift2", () => lift2(1, 2, (_a, _b) => undefined as any).__ir],
    ["lift3", () => lift3(1, 2, 3, (_a, _b, _c) => undefined as any).__ir],
    ["lift", () => lift({ value: 1 }, (_deps) => undefined as any).__ir],
  ])("rejects non-admissible callback output from %s", (_name, build) => {
    expect(() => evaluateExpr(build(), adapter)).toThrow("expected JSON-compatible values");
  });
});
