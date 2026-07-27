import type { SchemaIR } from "@acpus/core/ir";
import { schemaToJsonSchema } from "@acpus/core/schema";
import { describe, expect, it } from "vitest";
import {
  buildAgentOutputPrompt,
  buildAgentOutputRepairPrompt,
  conformAgentOutput,
} from "../src/execution/agent-output.js";

const booleanObject: SchemaIR = {
  kind: "object",
  fields: { ok: { kind: "boolean" } },
  required: ["ok"],
  additionalProperties: false,
};

const frame = (payload: string, prefix = "") => `${prefix}<ACPUS_OUTPUT>\n${payload}\n</ACPUS_OUTPUT>`;
const accepted = (schema: SchemaIR, text: string) => conformAgentOutput(schema, text, "review")._unsafeUnwrap();
const rejected = (schema: SchemaIR, text: string) => conformAgentOutput(schema, text, "review")._unsafeUnwrapErr();

describe("agent output prompts", () => {
  it("adds one minimal mandatory Tagged JSON contract and schema", () => {
    const prompt = buildAgentOutputPrompt("Do the work.", booleanObject);

    expect(prompt.startsWith("Do the work.")).toBe(true);
    expect(protocolMarkers(prompt)).toEqual(["<ACPUS_OUTPUT>", "</ACPUS_OUTPUT>"]);
    expect(embeddedJsonSchema(prompt)).toEqual(schemaToJsonSchema(booleanObject));
  });

  it("uses one bounded phase-specific repair instruction and repeats the contract", () => {
    const prompts = (["framing", "json", "schema"] as const)
      .map(phase => buildAgentOutputRepairPrompt(booleanObject, phase));
    const contract = buildAgentOutputPrompt("", booleanObject);
    const instructions = prompts.map(prompt => {
      expect(prompt.endsWith(contract)).toBe(true);
      return prompt.slice(0, -contract.length);
    });

    expect(new Set(instructions).size).toBe(3);
    for (const [index, prompt] of prompts.entries()) {
      expect(Buffer.byteLength(instructions[index]!)).toBeLessThanOrEqual(300);
      expect(protocolMarkers(prompt)).toEqual(["<ACPUS_OUTPUT>", "</ACPUS_OUTPUT>"]);
      expect(embeddedJsonSchema(prompt)).toEqual(schemaToJsonSchema(booleanObject));
    }
  });
});

function protocolMarkers(prompt: string): string[] {
  return [...prompt.matchAll(/<\/?ACPUS_OUTPUT>/gu)].map(match => match[0]);
}

function embeddedJsonSchema(prompt: string): unknown {
  const starts = [...prompt.matchAll(/[\[{]/gu)]
    .map(match => match.index)
    .reverse();
  for (const start of starts) {
    try {
      return JSON.parse(prompt.slice(start)) as unknown;
    } catch {}
  }
  throw new Error("Agent output prompt is missing its JSON Schema.");
}

describe("Tagged JSON framing", () => {
  it.each([
    ['{"ok":true}', "framing"],
    ['{"ok":true}</ACPUS_OUTPUT>', "framing"],
    [`prefix </ACPUS_OUTPUT> ${frame('{"ok":true}')}`, "framing"],
    [`${frame('{"ok":true}')} trailing prose`, "framing"],
  ] as const)("rejects an incomplete or non-terminal frame: %j", (text, phase) => {
    expect(rejected(booleanObject, text)).toEqual({
      kind: "output_framing",
      phase: "framing",
      message: "Agent node 'review' response did not contain one complete terminal <ACPUS_OUTPUT> frame.",
      outputProcessing: { outcome: "rejected", phase },
    });
  });

  it("accepts prefix commentary without depending on marker line endings", () => {
    expect(accepted(booleanObject, "prefix<ACPUS_OUTPUT>\r\n{\"ok\":true}\r\n</ACPUS_OUTPUT> \n\t")).toMatchObject({
      output: { ok: true },
      outputProcessing: { outcome: "accepted", parsing: "direct", projectionChanged: false },
    });
  });

  it("allows marker text inside a valid JSON string", () => {
    const schema: SchemaIR = { kind: "string" };

    expect(accepted(schema, frame('"<ACPUS_OUTPUT> x </ACPUS_OUTPUT>"'))).toMatchObject({
      output: "<ACPUS_OUTPUT> x </ACPUS_OUTPUT>",
      outputProcessing: { parsing: "direct" },
    });
  });

  it("rejects duplicate frames instead of selecting or repairing one", () => {
    const text = `${frame('{"ok":false}')}\n${frame('{"ok":true}')}`;

    expect(rejected(booleanObject, text)).toEqual({
      kind: "output_framing",
      phase: "framing",
      message: "Agent node 'review' response contained ambiguous ACPUS_OUTPUT framing.",
      outputProcessing: { outcome: "rejected", phase: "framing" },
    });
  });
});

describe("Tagged JSON parsing", () => {
  it.each([
    [{ kind: "object", fields: {}, required: [], additionalProperties: true } satisfies SchemaIR, '{}', {}],
    [{ kind: "array", item: { kind: "number" } } satisfies SchemaIR, '[1,2]', [1, 2]],
    [{ kind: "string" } satisfies SchemaIR, '"done"', "done"],
    [{ kind: "number" } satisfies SchemaIR, '42', 42],
    [{ kind: "boolean" } satisfies SchemaIR, 'true', true],
    [{ kind: "null" } satisfies SchemaIR, 'null', null],
  ])("accepts every JSON root for a $kind schema", (schema, payload, output) => {
    expect(accepted(schema, frame(payload))).toMatchObject({
      output,
      outputProcessing: { outcome: "accepted", parsing: "direct", projectionChanged: false },
    });
  });

  it("repairs only a framed payload after direct JSON parsing fails", () => {
    expect(accepted(booleanObject, frame('{"ok":true,}'))).toMatchObject({
      output: { ok: true },
      outputProcessing: { outcome: "accepted", parsing: "repaired", projectionChanged: false },
    });
  });

  it("applies the same repair path to scalar roots", () => {
    expect(accepted({ kind: "string" }, frame("done"))).toMatchObject({
      output: "done",
      outputProcessing: { outcome: "accepted", parsing: "repaired", projectionChanged: false },
    });
  });

  it("records jsonrepair's Markdown fence recovery instead of hiding it as direct parsing", () => {
    expect(accepted(booleanObject, frame('```json\n{"ok":true}\n```'))).toMatchObject({
      output: { ok: true },
      outputProcessing: { outcome: "accepted", parsing: "repaired", projectionChanged: false },
    });
  });

  it.each([
    ['{"id":1}\n{"id":2}'],
    ['```json\n{"id":1}\n{"id":2}\n```'],
  ])("rejects multiple root values instead of letting jsonrepair combine them: %j", payload => {
    const arraySchema: SchemaIR = {
      kind: "array",
      item: {
        kind: "object",
        fields: { id: { kind: "number" } },
        required: ["id"],
        additionalProperties: false,
      },
    };

    expect(rejected(arraySchema, frame(payload))).toMatchObject({
      kind: "output_json",
      phase: "json",
      outputProcessing: { outcome: "rejected", phase: "json" },
    });
  });

  it.each([
    ['"first";"second"', { kind: "string" } satisfies SchemaIR],
    ["`first`;`second`", { kind: "string" } satisfies SchemaIR],
    ['1;2', { kind: "unknown" } satisfies SchemaIR],
    ['// comment\n"first";"second"', { kind: "string" } satisfies SchemaIR],
    ['```json\n"first";"second"\n```', { kind: "string" } satisfies SchemaIR],
  ])("rejects multiple scalar roots before jsonrepair can combine them: %j", (payload, schema) => {
    expect(rejected(schema, frame(payload))).toMatchObject({
      kind: "output_json",
      phase: "json",
      outputProcessing: { outcome: "rejected", phase: "json" },
    });
  });

  it.each([
    "",
    '"\\uZZZZ"',
    "1e400",
  ])("rejects an unrecoverable or non-JsonValue payload: %j", payload => {
    expect(rejected(booleanObject, frame(payload))).toMatchObject({
      kind: "output_json",
      outputProcessing: { outcome: "rejected", phase: "json" },
    });
  });
});

describe("schema projection and normalization", () => {
  it("recursively removes undeclared properties", () => {
    const schema: SchemaIR = {
      kind: "object",
      fields: {
        first: { kind: "boolean" },
        nested: {
          kind: "object",
          fields: { kept: { kind: "number" } },
          required: ["kept"],
          additionalProperties: false,
        },
      },
      required: ["first", "nested"],
      additionalProperties: false,
    };

    expect(accepted(schema, frame('{"nested":{"removed":2,"kept":1},"first":true}'))).toMatchObject({
      output: { first: true, nested: { kept: 1 } },
      outputProcessing: { outcome: "accepted", parsing: "direct", projectionChanged: true },
    });
  });

  it("does not treat object key order as a projection change", () => {
    const reorderedSchema: SchemaIR = {
      kind: "object",
      fields: { first: { kind: "boolean" }, second: { kind: "boolean" } },
      required: ["first", "second"],
      additionalProperties: false,
    };
    expect(accepted(reorderedSchema, frame('{"second":false,"first":true}'))).toMatchObject({
      outputProcessing: { projectionChanged: false },
    });
  });

  it("reports schema rejection after preserving parsing and projection metadata", () => {
    expect(rejected(booleanObject, frame('{"ok":"yes","extra":1}'))).toMatchObject({
      kind: "output_conformance",
      outputProcessing: { outcome: "rejected", phase: "schema", parsing: "direct", projectionChanged: true },
    });
    expect(rejected(booleanObject, frame('{"ok":"yes",}'))).toMatchObject({
      kind: "output_conformance",
      outputProcessing: { outcome: "rejected", phase: "schema", parsing: "repaired", projectionChanged: false },
    });
  });

  it("preserves a declared __proto__ field as an own data property", () => {
    const key = "__proto__";
    const fields = Object.fromEntries([[key, { kind: "boolean" }]]) as Record<string, SchemaIR>;
    const schema: SchemaIR = { kind: "object", fields, required: [key], additionalProperties: false };
    const output = accepted(schema, frame(JSON.stringify({ [key]: true })));

    expect(output).toMatchObject({ outputProcessing: { projectionChanged: false } });
    if (typeof output.output !== "object" || output.output === null || Array.isArray(output.output)) throw new Error("expected object output");
    expect(Object.hasOwn(output.output, key)).toBe(true);
    expect(output.output[key]).toBe(true);
  });
});
