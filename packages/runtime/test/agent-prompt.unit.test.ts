import type { SchemaIR } from "@acpus/core/ir";
import { describe, expect, it } from "vitest";
import {
  agentPromptInputDigest,
  buildAuthoredAgentPrompt,
  buildRepairAgentPrompt,
  buildSteeringAgentPrompt,
} from "../src/execution/agent-prompt.js";

const outputSchema: SchemaIR = {
  kind: "object",
  fields: { ok: { kind: "boolean" } },
  required: ["ok"],
  additionalProperties: false,
};

describe("Agent prompt identity", () => {
  it("locks authored wrapping", () => {
    const authored = buildAuthoredAgentPrompt("Do α", outputSchema);
    expect(authored).toEqual({
      prompt: "Do α\n\n# RESULT HANDOFF [MANDATORY]\nReplace the type shape inside the tags with one matching JSON value; comments are guidance. Keep the tags verbatim, do not escape them, and end at the closing tag.\n<ACPUS_OUTPUT>\n{ ok: boolean }\n</ACPUS_OUTPUT>",
      promptOrigin: "authored",
      inputDigest: "sha256:c89dee1a04dd2a556bab16a9360c5371ba68e1b953cdc8ef3b7e129375380747",
    });
  });

  it("preserves Unicode/newlines in steering and versions repair bytes", () => {
    expect(buildSteeringAgentPrompt("先做 A\n再做 B")).toEqual({
      prompt: "<steering>先做 A\n再做 B</steering>",
      promptOrigin: "steering",
      inputDigest: "sha256:7242085b8ec1835b5f45599ba48341949fac0e0e169b225e8724a8dc77ed982a",
    });
    expect(buildRepairAgentPrompt(outputSchema, "json")).toMatchObject({
      promptOrigin: "repair",
      inputDigest: "sha256:f174f4106976fd19e59f9235fa6316cdf45c60f9200ae1814b9f4532bb4ef06a",
    });
  });

  it("does not normalize prompt bytes", () => {
    expect(agentPromptInputDigest("x\n")).not.toBe(agentPromptInputDigest("x"));
    expect(agentPromptInputDigest(" x ")).not.toBe(agentPromptInputDigest("x"));
  });
});
