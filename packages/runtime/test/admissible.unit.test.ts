import { describe, expect, it } from "vitest";
import { normalizeWorkflowData } from "../src/evaluation/admissible.js";

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
});
