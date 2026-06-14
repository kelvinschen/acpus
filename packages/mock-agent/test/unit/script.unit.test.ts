import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseMockScript, responseText, selectResponse, splitIntoChunks } from "../../src/index.js";

const fixtures = join(import.meta.dirname, "..", "fixtures");

function fixture(name: string): string {
  return readFileSync(join(fixtures, name), "utf8");
}

describe("@acpus/mock-agent script", () => {
  it("parses deterministic mock scripts", () => {
    const script = parseMockScript(fixture("mock.yaml"));

    expect(script.agent_id).toBe("acpus-fixture-mock");
    expect(script.rules.map((rule) => rule.name)).toEqual(["json-rule", "regex-rule", "slow-rule", "error-rule"]);
  });

  it("selects the first matching ordered rule", () => {
    const script = parseMockScript(fixture("mock.yaml"));
    const selected = selectResponse(script, "Return JSON and fix failing test");

    expect(selected.ruleName).toBe("json-rule");
    expect(responseText(selected.response)).toBe(JSON.stringify({ ok: true, source: "json-rule" }));
  });

  it("supports regex matching", () => {
    const script = parseMockScript(fixture("mock.yaml"));
    const selected = selectResponse(script, "please fix this test");

    expect(selected.ruleName).toBe("regex-rule");
    expect(responseText(selected.response)).toBe("fixed tests");
  });

  it("falls back to default response", () => {
    const script = parseMockScript(fixture("mock.yaml"));
    const selected = selectResponse(script, "no match");

    expect(selected.ruleName).toBe("default_response");
    expect(responseText(selected.response)).toBe("default ok");
  });

  it("supports stateful response sequences", () => {
    const script = parseMockScript(fixture("integration.yaml"));
    const attempts = new Map<string, number>();

    const first = selectResponse(script, "retry me", { ruleAttempts: attempts });
    attempts.set(first.ruleName, (attempts.get(first.ruleName) ?? 0) + 1);
    const second = selectResponse(script, "retry me", { ruleAttempts: attempts });

    expect(responseText(first.response)).toBe("{bad json");
    expect(responseText(second.response)).toBe(JSON.stringify({ ok: true, attempt: 2 }));
  });

  it("supports prompt-count rules", () => {
    const script = parseMockScript(fixture("integration.yaml"));
    const selected = selectResponse(script, "anything", { promptCount: 2 });

    expect(selected.ruleName).toBe("prompt-count-rule");
    expect(responseText(selected.response)).toBe("second prompt");
  });

  it("supports previous-rule matching for continuation prompts", () => {
    const script = parseMockScript(`
version: 1
agent_id: continuation-test
default_response:
  type: text
  text: default
rules:
  - name: review
    when:
      prompt_contains: "branch=review"
    respond:
      type: json
      payload:
        branch: review
  - name: loop-continuation
    when:
      prompt_contains: "Continue"
      previous_rule: loop
    respond:
      type: json
      payload:
        branch: loop
  - name: review-continuation
    when:
      prompt_contains: "Continue"
      previous_rule: review
    respond:
      type: json
      payload:
        branch: review
        continued: true
`);

    const continuation = selectResponse(script, "Continue the previous task", {
      previousRule: "review"
    });

    expect(continuation.ruleName).toBe("review-continuation");
    expect(responseText(continuation.response)).toBe(JSON.stringify({ branch: "review", continued: true }));
  });

  it("parses integration-test session controls", () => {
    const script = parseMockScript(fixture("integration.yaml"));

    expect(script.deterministic_session_ids).toBe(true);
    expect(script.allow_unknown_session_load).toBe(false);
  });

  it("rejects invalid scripts", () => {
    expect(() => parseMockScript(fixture("invalid.yaml"))).toThrow(/type must be text, json, error, or hang/);
  });

  it("splits response text into deterministic chunks", () => {
    expect(splitIntoChunks("abcdef", 3)).toEqual(["ab", "cd", "ef"]);
  });
});
