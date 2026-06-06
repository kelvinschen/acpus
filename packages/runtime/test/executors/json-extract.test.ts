import { describe, it, expect } from "vitest";
import { extractJson } from "../../src/executors/agent.js";

describe("extractJson", () => {
  it("parses a pure JSON reply (strict fast path)", () => {
    expect(extractJson('{"ok": true, "n": 1}')).toEqual({ ok: true, n: 1 });
    expect(extractJson("  [1, 2, 3]  ")).toEqual([1, 2, 3]);
  });

  it("extracts JSON wrapped in prose and a code fence", () => {
    const reply = 'This is my response:\n```json\n{\n  "ok": true\n}\n```\nIs this ok';
    expect(extractJson(reply)).toEqual({ ok: true });
  });

  it("returns the last valid JSON when multiple blocks are present", () => {
    const reply = 'First draft: {"ok": false}\nFinal answer: {"ok": true, "score": 9}';
    expect(extractJson(reply)).toEqual({ ok: true, score: 9 });
  });

  it("does not treat braces inside string literals as structure", () => {
    expect(extractJson('{"note": "a } b { c"}')).toEqual({ note: "a } b { c" });
  });

  it("repairs malformed JSON (unquoted keys) via jsonrepair fallback", () => {
    const reply = "Here you go:\n```\n{ ok: true, n: 2 }\n```";
    expect(extractJson(reply)).toEqual({ ok: true, n: 2 });
  });

  it("returns undefined when no JSON can be recovered", () => {
    expect(extractJson("no json here at all")).toBeUndefined();
    expect(extractJson("")).toBeUndefined();
    expect(extractJson("   ")).toBeUndefined();
  });
});
