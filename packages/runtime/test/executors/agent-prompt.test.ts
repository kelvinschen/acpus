import { describe, it, expect } from "vitest";
import { buildAgentPrompt } from "../../src/executors/agent.js";

const CONTINUATION = "Continue the previous task from where you left off.";
const SCHEMA = {
  type: "object",
  properties: { approved: { type: "boolean" }, score: { type: "integer" } },
  required: ["approved", "score"]
};
const SCHEMA_INSTRUCTION = "**After completing the task, your final response MUST be exactly one JSON object that conforms to this schema, with no Markdown, prose, or extra keys.**";
const SCHEMA_SECTION = `\n\n# OUTPUT SCHEMA\n${SCHEMA_INSTRUCTION}\n${JSON.stringify(SCHEMA, null, 2)}`;

describe("buildAgentPrompt", () => {
  it("first run with schema: task prompt + OUTPUT SCHEMA section", () => {
    expect(buildAgentPrompt("Review PR #42.", SCHEMA, false, false)).toBe(
      "Review PR #42." + SCHEMA_SECTION
    );
  });

  it("first run without schema: task prompt only", () => {
    expect(buildAgentPrompt("Review PR #42.", undefined, false, false)).toBe("Review PR #42.");
  });

  it("plain continuation: continuation prompt only, no schema section", () => {
    expect(buildAgentPrompt("Review PR #42.", SCHEMA, true, false)).toBe(CONTINUATION);
  });

  it("parse/schema retry: continuation prompt + OUTPUT SCHEMA section", () => {
    expect(buildAgentPrompt("Review PR #42.", SCHEMA, false, true)).toBe(
      CONTINUATION + SCHEMA_SECTION
    );
  });

  it("retry continuation: continuation + schema", () => {
    expect(buildAgentPrompt("Review PR #42.", SCHEMA, true, true)).toBe(
      CONTINUATION + SCHEMA_SECTION
    );
  });
});
