import { describe, expect, it } from "vitest";
import { formatRepairPrompt } from "../../src/runtime/repair.js";
import { parseWorkflowOutput } from "../../src/runtime/output-parser.js";

function implementationOutput(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    status: "completed",
    summary: "Implemented safely.",
    artifacts: [],
    nextFocus: "summarize",
    changedFiles: ["src/app.ts"],
    checks: [{ command: "npm test", status: "pass", summary: "ok" }],
    ...extra
  };
}

function validationOutput(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    status: "completed",
    summary: "Reviewed safely.",
    artifacts: [],
    nextFocus: "summarize",
    verdict: "pass",
    severityCounts: { P0: 0, P1: 0, P2: 0, P3: 0 },
    findings: [],
    checks: [],
    ...extra
  };
}

function trailing(value: unknown, prefix = "Done.\n"): string {
  return `${prefix}${JSON.stringify(value, null, 2)}`;
}

function fenced(tag: string, value: unknown): string {
  return `\`\`\`${tag}\n${JSON.stringify(value, null, 2)}\n\`\`\``;
}

describe("runtime output parser", () => {
  it("accepts prose containing a final balanced JSON object", () => {
    const parsed = parseWorkflowOutput(trailing(implementationOutput()), "implementation");

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.outputParse).toMatchObject({
      mode: "lastBalancedJson",
      repaired: false,
      candidateCount: 1
    });
  });

  it("accepts trailing symbols and text after the final JSON object", () => {
    const parsed = parseWorkflowOutput(`${JSON.stringify(implementationOutput({ summary: "with tail" }), null, 2)}\n✅ Done. ###`, "implementation");

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.summary).toBe("with tail");
    expect(parsed.outputParse).toMatchObject({
      mode: "lastBalancedJson",
      candidateCount: 1
    });
  });

  it("fails closed when no balanced JSON exists", () => {
    const parsed = parseWorkflowOutput("Now, let's write the workflow output JSON.", "implementation");

    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.errorCode).toBe("OUTPUT_PARSE_FAILED");
    expect(parsed.diagnostics.candidateCount).toBe(0);
  });

  it("repairs JSON syntax before schema validation", () => {
    const raw = [
      "Done.",
      "{\"status\":\"completed\",\"summary\":\"ok\", // brief result",
      "\"artifacts\":[],\"nextFocus\":\"done\",\"changedFiles\":[\"a.ts\",],\"checks\":[]}",
      "Finished."
    ].join("\n");
    const parsed = parseWorkflowOutput(raw, "implementation");

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.outputParse).toMatchObject({
      mode: "lastBalancedJson",
      repaired: true,
      candidateCount: 1
    });
  });

  it("does not treat workflow-output wrapper objects specially", () => {
    const parsed = parseWorkflowOutput(trailing({ "workflow-output": implementationOutput() }), "implementation");

    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.errorCode).toBe("OUTPUT_SCHEMA_FAILED");
    expect(parsed.diagnostics).toMatchObject({
      candidateCount: 1,
      bestCandidateId: "candidate-1"
    });
    expect(parsed.diagnostics.candidates[0]?.schemaErrors.map((error) => error.path)).toEqual(expect.arrayContaining(["/status"]));
  });

  it("normalizes only checks[].result to checks[].status", () => {
    const parsed = parseWorkflowOutput(trailing(implementationOutput({
      checks: [{ name: "unit", result: "pass" }]
    })), "implementation");

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.checks).toEqual([{ name: "unit", status: "pass" }]);
    expect(parsed.outputParse.outputNormalizedAliases).toEqual(["checks[].result->checks[].status"]);
  });

  it("uses only the final parseable JSON object when earlier valid JSON appears in prose", () => {
    const parsed = parseWorkflowOutput([
      JSON.stringify(implementationOutput({ summary: "First" }), null, 2),
      "The previous object was an example; final result follows.",
      JSON.stringify(implementationOutput({ summary: "Second" }), null, 2)
    ].join("\n"), "implementation");

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.summary).toBe("Second");
    expect(parsed.outputParse.candidateCount).toBe(1);
  });

  it("fails closed when the last parseable JSON object is schema-invalid", () => {
    const parsed = parseWorkflowOutput([
      JSON.stringify(implementationOutput({ summary: "Valid earlier" }), null, 2),
      "The last parseable object is a domain report.",
      JSON.stringify({ card: "67-zhaopin", overall_result: "PASS" }, null, 2)
    ].join("\n"), "implementation");

    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.errorCode).toBe("OUTPUT_SCHEMA_FAILED");
    expect(parsed.diagnostics.candidateCount).toBe(1);
    expect(parsed.diagnostics.candidates[0]?.rawPreview).toContain("67-zhaopin");
  });

  it("skips a later balanced brace span when it cannot be parsed or repaired", () => {
    const parsed = parseWorkflowOutput([
      JSON.stringify(implementationOutput({ summary: "Valid before noisy braces" }), null, 2),
      "debug tail {not json}"
    ].join("\n"), "implementation");

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.summary).toBe("Valid before noisy braces");
    expect(parsed.outputParse).toMatchObject({ mode: "lastBalancedJson", candidateCount: 1 });
  });

  it("parses report input/audio style findings with nested TypeScript fences in JSON strings", () => {
    const parsed = parseWorkflowOutput(trailing(validationOutput({
      verdict: "fix",
      severityCounts: { P0: 0, P1: 2, P2: 0, P3: 0 },
      findings: [{
        severity: "P1",
        summary: "input validate state typo",
        path: "packages/lego/lego_core/src/components/input/index.tsx",
        details: "Evidence:\n```typescript\nif (!('validateState' in this.props)) {\n```\nRecommendation: Fix the typo.",
        evidence: "```typescript\n// line 232-236\nevent(document as unknown as HTMLElement, 'visibilitychange', this.visiblePaused);\n```"
      }, {
        severity: "P1",
        summary: "audio browser global access",
        details: "The component uses document directly.\n```typescript\nthis.audio = document.createElement('audio');\n```"
      }]
    })), "validation");

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.outputParse).toMatchObject({ mode: "lastBalancedJson", candidateCount: 1 });
    expect(parsed.value.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        details: expect.stringContaining("```typescript")
      })
    ]));
  });

  it("parses report select/tabs/view style findings with nested TSX fences in JSON strings", () => {
    const parsed = parseWorkflowOutput(trailing(validationOutput({
      verdict: "fix",
      severityCounts: { P0: 0, P1: 1, P2: 0, P3: 0 },
      findings: [{
        severity: "P1",
        summary: "select unique id issue",
        path: "packages/lego/lego_core/src/components/select/index.tsx",
        details: "Lines 486-494:\n```tsx\nprivate readonly getUniqueId = (() => {\n  let uniqueId = '';\n  return () => uniqueId;\n})();\n```"
      }]
    })), "validation");

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        details: expect.stringContaining("```tsx")
      })
    ]));
  });

  it("accepts legacy fenced JSON only because the object is balanced in full text", () => {
    const parsed = parseWorkflowOutput(fenced("workflow-output", validationOutput({
      verdict: "fix",
      findings: [{
        severity: "P1",
        summary: "legacy fenced output",
        details: "```tsx\nconst value = 1;\n```"
      }],
      severityCounts: { P0: 0, P1: 1, P2: 0, P3: 0 }
    })), "validation");

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.outputParse).toMatchObject({ mode: "lastBalancedJson", candidateCount: 1 });
    expect(parsed.value.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        details: expect.stringContaining("```tsx")
      })
    ]));
  });

  it("fails closed for empty timeline-style raw output", () => {
    const parsed = parseWorkflowOutput("", "validation");

    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.errorCode).toBe("OUTPUT_PARSE_FAILED");
    expect(parsed.diagnostics.candidateCount).toBe(0);
  });

  it("returns schema diagnostics for domain reports such as the 67-zhaopin shape", () => {
    const domainReport = {
      card: "67-zhaopin",
      path: "packages/tt-search/business/Lego/67-zhaopin",
      overall_result: "PASS"
    };
    const parsed = parseWorkflowOutput(trailing(domainReport, "Here's the final JSON:\n"), "implementation");

    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.errorCode).toBe("OUTPUT_SCHEMA_FAILED");
    expect(parsed.diagnostics).toMatchObject({
      errorCode: "OUTPUT_SCHEMA_FAILED",
      candidateCount: 1,
      recoverability: "repairable"
    });
    expect(parsed.diagnostics.candidates.flatMap((candidate) => candidate.schemaErrors.map((error) => error.path))).toEqual(expect.arrayContaining(["/status", "/summary", "/artifacts", "/nextFocus", "/changedFiles", "/checks"]));
  });

  it("formats schema-aware repair prompts for balanced JSON failures", () => {
    const parsed = parseWorkflowOutput(trailing({ card: "67-zhaopin" }), "implementation");

    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    const prompt = formatRepairPrompt({ contractName: "implementation", failure: parsed });
    expect(prompt).toContain("Blocked reason: OUTPUT_SCHEMA_FAILED");
    expect(prompt).toContain("Canonical schema");
    expect(prompt).toContain("Minimal valid example");
    expect(prompt).toContain("/status");
    expect(prompt).toContain("checks[].result");
    expect(prompt).toContain("End with exactly one valid, parseable JSON object that satisfies the schema.");
    expect(prompt).toContain("Do not wrap the final JSON object in Markdown code fences. Do not use ```json.");
  });
});
