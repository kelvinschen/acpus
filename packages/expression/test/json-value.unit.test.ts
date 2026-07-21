import { describe, expect, it } from "vitest";
import { isJsonValue } from "@acpus/expression/ir";

describe("JSON value guard", () => {
  it("accepts finite primitives, dense arrays, and plain objects", () => {
    const nullPrototype = Object.assign(Object.create(null) as Record<string, unknown>, { enabled: true });

    expect(isJsonValue({ name: "run", nested: [null, 1, false, nullPrototype] })).toBe(true);
  });

  it("accepts shared references that are not cyclic", () => {
    const shared = { count: 2 };

    expect(isJsonValue({ left: shared, right: shared })).toBe(true);
  });

  it("validates a shared subgraph only once", () => {
    let reads = 0;
    const leaf = Object.defineProperty({}, "value", {
      enumerable: true,
      get: () => {
        reads += 1;
        return 1;
      },
    });
    let dag: unknown = leaf;
    for (let depth = 0; depth < 30; depth += 1) dag = { left: dag, right: dag };

    expect(isJsonValue(dag)).toBe(true);
    expect(reads).toBe(1);
  });

  it.each([
    ["undefined", undefined],
    ["function", () => undefined],
    ["symbol", Symbol("value")],
    ["bigint", 1n],
    ["NaN", Number.NaN],
    ["positive infinity", Number.POSITIVE_INFINITY],
    ["negative infinity", Number.NEGATIVE_INFINITY],
    ["date", new Date(0)],
    ["map", new Map()],
    ["set", new Set()],
  ])("rejects %s", (_name, value) => {
    expect(isJsonValue(value)).toBe(false);
  });

  it("rejects class instances, sparse arrays, symbol fields, and cycles", () => {
    class RecordLike {
      value = 1;
    }
    const sparse = Array<number>(1);
    const withSymbol = { [Symbol("value")]: true };
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    expect(isJsonValue(new RecordLike())).toBe(false);
    expect(isJsonValue(sparse)).toBe(false);
    expect(isJsonValue(withSymbol)).toBe(false);
    expect(isJsonValue(cyclic)).toBe(false);
  });

  it("returns false for objects that cannot be inspected", () => {
    const value = new Proxy({}, { getPrototypeOf: () => { throw new Error("unreachable"); } });

    expect(isJsonValue(value)).toBe(false);
  });
});
