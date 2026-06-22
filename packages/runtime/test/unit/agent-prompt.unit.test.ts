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
  it.each([
    ["first run with schema", SCHEMA, false, false, "Review PR #42." + SCHEMA_SECTION],
    ["first run without schema", undefined, false, false, "Review PR #42."],
    ["plain continuation", SCHEMA, true, false, CONTINUATION],
    ["parse/schema retry", SCHEMA, false, true, CONTINUATION + SCHEMA_SECTION],
    ["retry continuation", SCHEMA, true, true, CONTINUATION + SCHEMA_SECTION]
  ])("%s", (_label, schema, isContinuation, isParseRetry, expected) => {
    expect(buildAgentPrompt("Review PR #42.", schema, isContinuation, isParseRetry)).toBe(expected);
  });
});
