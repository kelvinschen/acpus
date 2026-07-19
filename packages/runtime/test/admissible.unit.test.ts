import { describe, expect, it } from "vitest";
import { normalizeWorkflowData, tryNormalizeWorkflowData } from "../src/evaluation/admissible.js";

describe("workflow data normalization", () => {
  it("omits undefined object properties recursively", () => {
    expect(normalizeWorkflowData({
      keep: true,
      omitted: undefined,
      nested: { keep: "value", omitted: undefined },
    }, "Output")).toEqual({
      keep: true,
      nested: { keep: "value" },
    });
  });

  it("preserves own __proto__ data without mutating the normalized prototype", () => {
    const input = JSON.parse('{"__proto__":{"safe":true},"value":1}') as unknown;
    const normalized = tryNormalizeWorkflowData(input, "Output")._unsafeUnwrap() as Record<string, unknown>;

    expect(Object.getPrototypeOf(normalized)).toBe(Object.prototype);
    expect(Object.prototype.hasOwnProperty.call(normalized, "__proto__")).toBe(true);
    expect(JSON.stringify(normalized)).toBe('{"__proto__":{"safe":true},"value":1}');
  });

  it("allows only explicit top-level undefined", () => {
    expect(normalizeWorkflowData(undefined, "Task output", { allowTopLevelUndefined: true })).toBeUndefined();
    expect(() => normalizeWorkflowData(undefined, "Output")).toThrow("Output is not workflow-admissible: $ is undefined.");
  });

  it("rejects undefined arrays and non-durable runtime values", () => {
    class DataRecord {
      value = "plain-looking";
    }

    expect(() => normalizeWorkflowData(["ok", undefined], "Output")).toThrow("$[1] is undefined");
    expect(() => normalizeWorkflowData(new Date(), "Output")).toThrow("$ is Date");
    expect(() => normalizeWorkflowData(new DataRecord(), "Output")).toThrow("$ is Object");
    expect(() => normalizeWorkflowData(Number.POSITIVE_INFINITY, "Output")).toThrow("$ is non-finite number");
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => normalizeWorkflowData(cyclic, "Output")).toThrow("$.self is cyclic");
  });

  it("returns a tagged path and reason for expected invalid workflow data", () => {
    const invalid = tryNormalizeWorkflowData(["ok", undefined], "Node output");

    expect(invalid.isErr() && invalid.error).toEqual({
      type: "workflow-data-invalid",
      label: "Node output",
      path: "$[1]",
      reason: "undefined",
      message: "Node output is not workflow-admissible: $[1] is undefined.",
    });
  });

  it.each([
    { name: "top-level undefined", value: () => undefined, path: "$", reason: "undefined" },
    { name: "non-finite number", value: () => Number.NaN, path: "$", reason: "non-finite-number" },
    { name: "unsupported primitive", value: () => 1n, path: "$", reason: "unsupported-type" },
    { name: "cycle", value: () => { const item: Record<string, unknown> = {}; item.self = item; return item; }, path: "$.self", reason: "cyclic" },
    { name: "sparse array", value: () => { const item = ["first", "second"]; delete item[1]; return item; }, path: "$[1]", reason: "sparse-array-hole" },
    { name: "non-plain object", value: () => new Date(0), path: "$", reason: "non-plain-object" },
  ] as const)("classifies $name precisely", ({ value, path, reason }) => {
    const normalized = tryNormalizeWorkflowData(value(), "Node output");

    expect(normalized.isErr()).toBe(true);
    if (normalized.isErr()) expect(normalized.error).toMatchObject({ type: "workflow-data-invalid", path, reason });
  });

  it("does not turn an unexpected object inspection failure into invalid workflow data", () => {
    const sentinel = { type: "inspection-failed" };
    const value = new Proxy({}, { getPrototypeOf: () => { throw sentinel; } });
    let caught: unknown;

    try {
      tryNormalizeWorkflowData(value, "Node output");
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(sentinel);
  });

  it("preserves an unexpected enumerable getter failure", () => {
    const sentinel = { type: "getter-failed" };
    const value = Object.defineProperty({}, "field", {
      enumerable: true,
      get: () => { throw sentinel; },
    });
    let caught: unknown;

    try {
      tryNormalizeWorkflowData(value, "Node output");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(sentinel);
  });
});
