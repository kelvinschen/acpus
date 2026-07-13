import { describe, expect, it } from "vitest";
import type { SchemaIR } from "@acpus/core/ir";
import { conformAgentOutput } from "../src/execution/agent-node.js";

const booleanObject: SchemaIR = {
  kind: "object",
  fields: { ok: { kind: "boolean" } },
  required: ["ok"],
  additionalProperties: false,
};

describe("agent output processing metadata", () => {
  it.each([
    ["{\"ok\":true}", { recovery: "direct", conformance: "accepted", projectionChanged: false }],
    ["result: {\"ok\":true}", { recovery: "extracted", conformance: "accepted", projectionChanged: false }],
    ["{\"ok\":true,}", { recovery: "repaired", conformance: "accepted", projectionChanged: false }],
    ["{\"ok\":true,\"extra\":1}", { recovery: "direct", conformance: "accepted", projectionChanged: true }],
    ["{\"ok\":\"yes\"}", { recovery: "direct", conformance: "rejected", projectionChanged: false }],
  ] as const)("describes recovery and conformance for %s", (text, outputProcessing) => {
    expect(conformAgentOutput(booleanObject, text, "review").outputProcessing).toEqual(outputProcessing);
  });

  it("distinguishes empty and unrecoverable responses", () => {
    expect(conformAgentOutput(booleanObject, "  ", "review").outputProcessing).toEqual({
      recovery: "empty",
      conformance: "rejected",
    });
    expect(conformAgentOutput(booleanObject, "not json", "review").outputProcessing).toEqual({
      recovery: "unrecoverable",
      conformance: "rejected",
    });
  });

  it("ignores object key order when detecting schema projection changes", () => {
    const schema: SchemaIR = {
      kind: "object",
      fields: { first: { kind: "boolean" }, second: { kind: "boolean" } },
      required: ["first", "second"],
      additionalProperties: false,
    };

    expect(conformAgentOutput(schema, "{\"second\":false,\"first\":true}", "review")).toMatchObject({
      ok: true,
      outputProcessing: { recovery: "direct", conformance: "accepted", projectionChanged: false },
    });
  });
});
