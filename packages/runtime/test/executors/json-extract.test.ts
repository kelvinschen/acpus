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

  it("extracts the final report JSON despite earlier Markdown and TSX fragments", () => {
    const reply = [
      "The resolved key falls back to `detailSections[0]?.key`.",
      "The current `footerHintGroups`:",
      "```ts",
      "...(tabCount > 0 ? [{ key: \"1-9\", label: `tabs (${tabCount})` }] : []),",
      "```",
      "In `App.tsx`:",
      "```ts",
      "useInput((input, key) => {",
      "    if (input === \"j\") {",
      "        setDetailsScroll((s) => Math.min(detailsMaxScroll, s + 1));",
      "```",
      "A JSX example: `<Tabs tabs={...} activeKey={activeSection?.key ?? \"\"} />`.",
      "OK, here is the final report.",
      '{"report_path": "/tmp/contract.md", "blocking_count": 0, "top_findings": [{"title": "done", "severity": "MEDIUM"}]}'
    ].join("\n");

    expect(extractJson(reply)).toEqual({
      report_path: "/tmp/contract.md",
      blocking_count: 0,
      top_findings: [{ title: "done", severity: "MEDIUM" }]
    });
  });

  it("does not let an unbalanced prose brace block a later final JSON object", () => {
    const reply = 'A partial code block starts here: function run() {\nFinal answer: {"ok": true}';
    expect(extractJson(reply)).toEqual({ ok: true });
  });

  it("does not treat braces inside string literals as structure", () => {
    expect(extractJson('{"note": "a } b { c"}')).toEqual({ note: "a } b { c" });
  });

  it("repairs malformed JSON (unquoted keys) via jsonrepair fallback", () => {
    const reply = "Here you go:\n```\n{ ok: true, n: 2 }\n```";
    expect(extractJson(reply)).toEqual({ ok: true, n: 2 });
  });

  it("repairs the later object candidate before accepting an earlier strict JSON object", () => {
    const reply = 'Draft: {"ok": false, "score": 1}\nFinal answer: { ok: true, score: 9 }';
    expect(extractJson(reply)).toEqual({ ok: true, score: 9 });
  });

  it("falls back to an earlier valid JSON object when the last candidate cannot be recovered", () => {
    const reply = 'Draft: {"ok": true}\nBroken final: { definitely not json !!! }';
    expect(extractJson(reply)).toEqual({ ok: true });
  });

  it("does not repair prose bracket fragments into JSON output", () => {
    expect(extractJson("Draft: {\"ok\": true}\nSee range [1-9]")).toEqual({ ok: true });
    expect(extractJson("Draft: {\"ok\": true}\nCode: [{ key: \"1-9\", label: `tabs (${tabCount})` }]")).toEqual({ ok: true });
  });

  it("returns undefined when no JSON can be recovered", () => {
    expect(extractJson("no json here at all")).toBeUndefined();
    expect(extractJson("")).toBeUndefined();
    expect(extractJson("   ")).toBeUndefined();
  });
});
