import { describe, expect, it } from "vitest";
import { evaluateExpr, ExpressionEvaluationError, loadSerializedFunction, renderTemplate } from "@acpus/expression/evaluator";
import { and, eq, gt, gte, lift, lt, lte, ne, not, or } from "@acpus/expression";
import { refExpr, type ExprIR } from "@acpus/expression/ir";

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

  it("omits missing object fields while preserving missing top-level and array values", () => {
    const missing: ExprIR = { kind: "ref", path: ["input", "missing"] };
    expect(evaluateExpr({ kind: "object", fields: { optional: missing } }, adapter)).toEqual({});
    expect(evaluateExpr(missing, adapter)).toBeUndefined();
    expect(() => evaluateExpr({ kind: "array", items: [missing] }, adapter)).toThrow("array(...) received missing value.");
  });

  it("preserves evaluated object fields named __proto__", () => {
    const value = evaluateExpr({
      kind: "object",
      fields: Object.fromEntries([["__proto__", { kind: "literal", value: "safe" }]]),
    }, adapter) as Record<string, unknown>;

    expect(Object.hasOwn(value, "__proto__")).toBe(true);
    expect(value.__proto__).toBe("safe");
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

  it("lets an adapter format direct interpolation values without rewriting nested values", () => {
    const artifact = { kind: "artifact", uri: "artifact://run/artifact_1", mediaType: "text/plain" };
    expect(renderTemplate({
      kind: "template",
      parts: [
        { kind: "expr", expr: refExpr(["input", "artifact"]).__ir },
        { kind: "text", value: "|" },
        { kind: "expr", expr: refExpr(["input", "artifact", "uri"]).__ir },
        { kind: "text", value: "|" },
        { kind: "expr", expr: { kind: "object", fields: { artifact: refExpr(["input", "artifact"]).__ir } } },
      ],
    }, {
      resolveRef: path => path.at(-1) === "uri" ? artifact.uri : artifact,
      formatTemplateValue: value => value === artifact ? "/workspace/artifact.txt" : undefined,
    })).toBe(`/workspace/artifact.txt|${artifact.uri}|{\"artifact\":${JSON.stringify(artifact)}}`);
  });

  it("validates template values before invoking an adapter formatter", () => {
    const template = {
      kind: "template" as const,
      parts: [{ kind: "expr" as const, expr: { kind: "ref" as const, path: ["input", "value"] } }],
    };
    const formatTemplateValue = () => "bypassed";

    expect(() => renderTemplate(template, { resolveRef: () => undefined, formatTemplateValue }))
      .toThrow("template(...) received missing value.");
    expect(() => renderTemplate(template, { resolveRef: () => new Date(0), formatTemplateValue }))
      .toThrow("template(...) expected JSON-compatible values.");
    expect(() => renderTemplate(template, { resolveRef: () => Number.NaN, formatTemplateValue }))
      .toThrow("template(...) expected JSON-compatible values.");
  });

  it("evaluates unary lift over JSON values", () => {
    expect(evaluateExpr(lift(refExpr<number>(["input", "count"]), value => value + 1).__ir, adapter)).toBe(3);
    expect(evaluateExpr(lift(refExpr<number>(["input", "count"]), value => {
      const next = value + 1;
      return next;
    }).__ir, adapter)).toBe(3);
    expect(evaluateExpr(lift(refExpr<string>(["input", "title"]), value => value.trim().replace(/\s+/g, " ")).__ir, adapter)).toBe("Ship now");
    expect(evaluateExpr(lift(refExpr<readonly { id: string; done: boolean }[]>(["input", "items"]), items => items.filter(item => item.done).map(item => item.id)).__ir, adapter))
      .toEqual(["a"]);
  });

  it("restores callbacks containing the supported transpiler name helper", () => {
    const expression: ExprIR = {
      kind: "call",
      fn: "lift",
      args: [
        { kind: "literal", value: "  Ship  " },
        {
          kind: "literal",
          value: `value => {
            const normalize = __name(text => text.trim(), "normalize");
            return normalize(value);
          }`,
        },
      ],
    };

    expect(evaluateExpr(expression, adapter)).toBe("Ship");
  });

  it("rejects serialized sources that do not evaluate to functions", () => {
    expect(() => loadSerializedFunction("42")).toThrow("Serialized source did not evaluate to a function.");
    expect(() => evaluateExpr({
      kind: "call",
      fn: "lift",
      args: [
        { kind: "literal", value: 1 },
        { kind: "literal", value: "value => value, 42" },
      ],
    }, adapter)).toThrow("lift(...) source did not evaluate to a function.");
  });

  it("evaluates every lift overload over explicit dependencies", () => {
    const ready = refExpr<boolean>(["input", "ready"]);
    const kind = refExpr<string>(["input", "kind"]);
    const maxItems = refExpr<number>(["input", "maxItems"]);
    expect(evaluateExpr(lift(ready, kind, (ready, kind) => ready && kind === "release").__ir, adapter)).toBe(true);
    expect(evaluateExpr(lift(ready, kind, (ready, kind) => {
      const matches = ready && kind === "release";
      return matches;
    }).__ir, adapter)).toBe(true);
    expect(evaluateExpr(lift(ready, kind, maxItems, (ready, kind, maxItems) => ready && kind === "release" && maxItems > 0).__ir, adapter)).toBe(true);
    expect(evaluateExpr(lift(ready, kind, maxItems, (ready, kind, maxItems) => {
      const matches = ready && kind === "release";
      return matches && maxItems > 0;
    }).__ir, adapter)).toBe(true);
    expect(evaluateExpr(lift({ ready, kind, maxItems }, ({ ready, kind, maxItems }) => {
      const matches = ready && kind === "release";
      return matches && maxItems > 0;
    }).__ir, adapter)).toBe(true);
  });

  it("evaluates scalar comparison and boolean predicate helpers", () => {
    const count = refExpr<number>(["input", "count"]);
    const ready = refExpr<boolean>(["input", "ready"]);
    const kind = refExpr<string>(["input", "kind"]);

    expect(evaluateExpr(eq(kind, "release").__ir, adapter)).toBe(true);
    expect(evaluateExpr(eq<any>(1, "1").__ir, adapter)).toBe(false);
    expect(evaluateExpr(ne(kind, "draft").__ir, adapter)).toBe(true);
    expect(evaluateExpr(lt(count, 3).__ir, adapter)).toBe(true);
    expect(evaluateExpr(lte(count, 2).__ir, adapter)).toBe(true);
    expect(evaluateExpr(gt(count, 1).__ir, adapter)).toBe(true);
    expect(evaluateExpr(gte(count, 2).__ir, adapter)).toBe(true);
    expect(evaluateExpr(not(ready).__ir, adapter)).toBe(false);
    expect(evaluateExpr(and(ready, eq(kind, "release"), gte(count, 2)).__ir, adapter)).toBe(true);
    expect(evaluateExpr(or(false, ne(kind, "release"), ready).__ir, adapter)).toBe(true);
  });

  it("evaluates every and/or dependency eagerly", () => {
    const throws = lift(true, _value => (() => { throw new Error("eager"); })());
    expect(() => evaluateExpr(or(true, throws).__ir, adapter)).toThrow("eager");
  });

  it("allows runtime globals and nondeterministic Math.random", () => {
    expect(evaluateExpr(lift(refExpr<number>(["input", "count"]), value => Math.floor(value + Math.random() * 0)).__ir, adapter)).toBe(2);
    expect(evaluateExpr(lift(refExpr<{ title: string }>(["input", "issue"]), value => JSON.stringify({ title: value.title.trim() })).__ir, adapter)).toBe("{\"title\":\"Ship\"}");
    expect(typeof evaluateExpr(lift(refExpr<number>(["input", "count"]), _value => Date.now()).__ir, adapter)).toBe("number");
  });

  it("evaluates internal access and preserves missing projection semantics", () => {
    const transformed = lift(refExpr<{ title: string; labels: readonly string[] }>(["input", "issue"]), issue => ({
      title: issue.title.trim(),
      meta: { labels: issue.labels },
    }));
    expect(evaluateExpr(transformed.title.__ir, adapter)).toBe("Ship");
    expect(evaluateExpr(transformed.meta.labels[0]!.__ir, adapter)).toBe("urgent");
    expect(evaluateExpr(transformed.meta.labels[10]!.__ir, adapter)).toBeUndefined();
  });

  it("passes missing callback dependencies as undefined", () => {
    expect(evaluateExpr(lift(refExpr<string | undefined>(["input", "missing"]), value => value ?? "fallback").__ir, adapter))
      .toBe("fallback");
    expect(evaluateExpr(lift(refExpr<readonly string[]>(["input", "empty"])[0]!, value => value ?? "fallback").__ir, adapter))
      .toBe("fallback");
    expect(evaluateExpr(lift({ maybe: refExpr<string | undefined>(["input", "missing"]) }, ({ maybe }) => maybe ?? "fallback").__ir, adapter))
      .toBe("fallback");
    expect(evaluateExpr(lift({ nested: { maybe: refExpr<string | undefined>(["input", "missing"]) } }, ({ nested }) => nested.maybe ?? "fallback").__ir, adapter))
      .toBe("fallback");
  });

  it("deep clones callback inputs before invocation", () => {
    const source = {
      kind: "call" as const,
      fn: "lift",
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

  it("rejects cyclic callback inputs and clones shared subgraphs once", () => {
    const expression = {
      kind: "call" as const,
      fn: "lift",
      args: [
        { kind: "ref" as const, path: ["input", "value"] },
        { kind: "literal" as const, value: "value => value.left === value.right" },
      ],
    };
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => evaluateExpr(expression, { resolveRef: () => cyclic }))
      .toThrow("lift(...) expected JSON-compatible values.");
    expect(() => evaluateExpr(expression, { resolveRef: () => cyclic }))
      .toThrow(ExpressionEvaluationError);

    let reads = 0;
    const shared = Object.defineProperty({}, "value", {
      enumerable: true,
      get() {
        reads += 1;
        return 1;
      },
    });
    expect(evaluateExpr(expression, { resolveRef: () => ({ left: shared, right: shared }) })).toBe(true);
    expect(reads).toBe(2);
  });

  it("rejects invalid callbacks and outputs", () => {
    const evaluateSource = (source: string) => evaluateExpr({
      kind: "call" as const,
      fn: "lift",
      args: [{ kind: "literal" as const, value: 1 }, { kind: "literal" as const, value: source }],
    }, adapter);

    expect(() => evaluateSource("1")).toThrow("lift(...) callback source must be an arrow function.");
    expect(evaluateSource("value => { return value; }")).toBe(1);
    expect(evaluateSource("value => /* comment */ { return value; }")).toBe(1);
    expect(() => evaluateExpr({ kind: "call", fn: "lift", args: [{ kind: "literal", value: 1 }, { kind: "ref", path: ["input", "source"] }] }, adapter))
      .toThrow("lift(...) expected callback source string.");
    expect(() => evaluateExpr((lift as any)(1, (_value: number) => Promise.resolve(1)).__ir, adapter))
      .toThrow("lift(...) callback must return synchronously.");
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
      expect(() => evaluateSource(source)).toThrow("lift(...) expected JSON-compatible values.");
    }
    expect(() => evaluateSource("_value => (() => { throw new Error('boom'); })()"))
      .toThrow("lift(...) callback threw: boom");
    expect(() => evaluateSource("_value => { throw 'string failure'; }"))
      .toThrow("lift(...) callback threw: string failure");
    expect(() => evaluateSource("_value => (() => { throw new Error('boom'); })()"))
      .toThrow(ExpressionEvaluationError);
  });

  it.each([
    ["unary", () => (lift as any)(1, (_value: number) => undefined).__ir],
    ["binary", () => (lift as any)(1, 2, (_a: number, _b: number) => undefined).__ir],
    ["ternary", () => (lift as any)(1, 2, 3, (_a: number, _b: number, _c: number) => undefined).__ir],
  ])("rejects non-admissible callback output from %s", (_name, build) => {
    expect(() => evaluateExpr(build(), adapter)).toThrow("expected JSON-compatible values");
  });

  it("rejects unknown operators", () => {
    expect(() => evaluateExpr({ kind: "call", fn: "unknown", args: [] }, adapter))
      .toThrow("Unsupported expression operator: unknown.");
  });
});
