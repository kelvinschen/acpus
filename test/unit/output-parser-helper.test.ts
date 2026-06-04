import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { compileSchemaDsl, outputSchemaFooter } from "../../src/contracts/schema-dsl.js";
import { AGENT_TASK_RETRY_DELAY_MS, agentTaskRetryDelayMs, formatContinuationPrompt, setAgentTaskRetryDelayForTests } from "../../src/runtime/agent-task-retry.js";
import { parseWorkflowOutput } from "../../src/runtime/output-parser.js";

const REVIEW_SCHEMA = compileSchemaDsl("{summary:string,data:[{severity:string,category:string,title:string,path?:string,line?:number,evidence:string,recommendation:string}]}");
const GATE_SCHEMA = compileSchemaDsl("{summary:string}");

function reviewOutput(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    summary: "Reviewed safely.",
    data: [{
      severity: "P2",
      category: "runtime",
      title: "example finding",
      path: "src/runtime/example.ts",
      line: 12,
      evidence: "Concrete evidence.",
      recommendation: "Concrete fix."
    }],
    ...extra
  };
}

function strictJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

describe("runtime output parser", () => {
  afterEach(() => setAgentTaskRetryDelayForTests(undefined));

  it("accepts exactly one JSON object matching a compiled DSL schema", () => {
    const parsed = parseWorkflowOutput(strictJson(reviewOutput()), { outputSchema: REVIEW_SCHEMA });

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.summary).toBe("Reviewed safely.");
    expect(parsed.outputParse).toMatchObject({
      mode: "lastBalancedJsonObject",
      candidateCount: 1
    });
  });

  it("extracts a final fenced JSON object with prose before and after", () => {
    const parsed = parseWorkflowOutput([
      "Next is my summary",
      "```json",
      "{ \"summary\": \"my summary\" }",
      "```",
      "This is my summary."
    ].join("\n"), { outputSchema: GATE_SCHEMA });

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.summary).toBe("my summary");
  });

  it("extracts a fenced JSON object without surrounding prose", () => {
    const parsed = parseWorkflowOutput("```json\n{ \"summary\": \"my summary\" }\n```", { outputSchema: GATE_SCHEMA });

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.summary).toBe("my summary");
  });

  it("extracts an object followed by a semicolon", () => {
    const parsed = parseWorkflowOutput("{ \"summary\": \"my summary\" };", { outputSchema: GATE_SCHEMA });

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.summary).toBe("my summary");
  });

  it("extracts an object followed by a semicolon and prose", () => {
    const parsed = parseWorkflowOutput("{ \"summary\": \"my summary\" };\nThis is my summary.", { outputSchema: GATE_SCHEMA });

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.summary).toBe("my summary");
  });

  it("extracts a final object from prose", () => {
    const parsed = parseWorkflowOutput(`Done.\n${strictJson(reviewOutput())}`, { outputSchema: REVIEW_SCHEMA });

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.summary).toBe("Reviewed safely.");
  });

  it("accepts a long strict JSON response", () => {
    const raw = strictJson({
      summary: "long output parsed",
      data: [{
        severity: "P2",
        category: "runtime",
        title: "large evidence",
        evidence: "x".repeat(32000),
        recommendation: "Keep strict JSON parsing."
      }]
    });
    expect(raw.length).toBeGreaterThan(32000);

    const parsed = parseWorkflowOutput(raw, { outputSchema: REVIEW_SCHEMA });

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.summary).toBe("long output parsed");
  });

  it("reports parse failure for invalid JSON syntax", () => {
    const raw = "{\"summary\":\"ok\", \"data\":[{\"severity\":\"P1\",\"category\":\"runtime\",\"title\":\"t\",\"evidence\":\"e\",\"recommendation\":\"r\",}],}";
    const parsed = parseWorkflowOutput(raw, { outputSchema: REVIEW_SCHEMA });

    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.errorCode).toBe("OUTPUT_PARSE_FAILED");
    expect(parsed.diagnostics.candidateCount).toBe(1);
  });

  it("fails closed when no JSON response exists", () => {
    const parsed = parseWorkflowOutput("Now, let's write the workflow output JSON.", { outputSchema: REVIEW_SCHEMA });

    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.errorCode).toBe("OUTPUT_PARSE_FAILED");
    expect(parsed.diagnostics.candidateCount).toBe(0);
  });

  it("fails closed when the response is empty", () => {
    const parsed = parseWorkflowOutput("", { outputSchema: REVIEW_SCHEMA });

    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.errorCode).toBe("OUTPUT_PARSE_FAILED");
    expect(parsed.diagnostics.candidateCount).toBe(0);
  });

  it("fails closed when the JSON response is schema-invalid", () => {
    const parsed = parseWorkflowOutput(strictJson({ card: "67-zhaopin", overall_result: "PASS" }), { outputSchema: REVIEW_SCHEMA });

    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.errorCode).toBe("OUTPUT_SCHEMA_FAILED");
    expect(parsed.diagnostics.candidates[0]?.schemaErrors.map((error) => error.path)).toEqual(expect.arrayContaining(["/summary", "/data"]));
  });

  it("validates wrapper objects as the submitted output object", () => {
    const parsed = parseWorkflowOutput(strictJson({ final: reviewOutput() }), { outputSchema: REVIEW_SCHEMA });

    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.errorCode).toBe("OUTPUT_SCHEMA_FAILED");
    expect(parsed.diagnostics.candidates[0]?.schemaErrors.map((error) => error.path)).toEqual(expect.arrayContaining(["/summary", "/data"]));
  });

  it("uses the final object when multiple objects are present", () => {
    const baseData = reviewOutput().data as Array<Record<string, unknown>>;
    const final = reviewOutput({
      data: [{ ...baseData[0], title: "second" }]
    });
    const parsed = parseWorkflowOutput(`${strictJson(reviewOutput())}\n${strictJson(final)}`, { outputSchema: REVIEW_SCHEMA });

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect((parsed.value.data as Array<{ title: string }>)[0]?.title).toBe("second");
  });

  it("does not fall back when the final object is schema-invalid", () => {
    const parsed = parseWorkflowOutput(`${strictJson(reviewOutput())}\n${strictJson({ summary: "missing data" })}`, { outputSchema: REVIEW_SCHEMA });

    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.errorCode).toBe("OUTPUT_SCHEMA_FAILED");
    expect(parsed.diagnostics.candidateCount).toBe(1);
    expect(parsed.diagnostics.candidates[0]?.schemaErrors.map((error) => error.path)).toContain("/data");
  });

  it("ignores braces inside JSON strings while finding the final object", () => {
    const parsed = parseWorkflowOutput(`notes { ignored\n${strictJson({ summary: "literal braces { nested } are text" })}`, { outputSchema: GATE_SCHEMA });

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.summary).toBe("literal braces { nested } are text");
  });

  it("ignores arrays and primitives as workflow output candidates", () => {
    for (const raw of ["[1, 2, 3]", "[{\"summary\":\"array object\"}]", "[{\"outer\":{\"summary\":\"nested in array\"}}]", "[1,{\"a\":{\"b\":1}}]", "\"string\"", "42", "true", "null"]) {
      const parsed = parseWorkflowOutput(raw, { outputSchema: GATE_SCHEMA });
      expect(parsed.ok).toBe(false);
      if (parsed.ok) continue;
      expect(parsed.errorCode).toBe("OUTPUT_PARSE_FAILED");
      expect(parsed.diagnostics.candidateCount).toBe(0);
    }
  });

  it("validates runtime implicit fields with the compiled schema", () => {
    const parsed = parseWorkflowOutput(strictJson({ summary: "Gate passed.", verdict: "pass" }), {
      outputSchema: GATE_SCHEMA,
      implicitFields: { verdict: z.enum(["pass", "pass_with_warnings", "blocked", "failed", "unknown"]) }
    });

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.verdict).toBe("pass");
  });

  it("rejects missing runtime implicit fields", () => {
    const parsed = parseWorkflowOutput(strictJson({ summary: "Gate passed." }), {
      outputSchema: GATE_SCHEMA,
      implicitFields: { verdict: z.enum(["pass", "pass_with_warnings", "blocked", "failed", "unknown"]) }
    });

    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.errorCode).toBe("OUTPUT_SCHEMA_FAILED");
    expect(parsed.diagnostics.candidates[0]?.schemaErrors.map((error) => error.path)).toContain("/verdict");
  });

  it("builds continuation prompts from the final output schema only", () => {
    const parsed = parseWorkflowOutput(strictJson({ summary: "missing data" }), { outputSchema: REVIEW_SCHEMA });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;

    const prompt = formatContinuationPrompt({ outputSchema: REVIEW_SCHEMA, failure: parsed });

    expect(prompt).toContain("Continue your work");
    expect(prompt).toContain("# Final Output Contract");
    expect(prompt).toContain("After completing the whole task");
    expect(prompt).toContain("final JSON object");
    expect(prompt).toContain("summary: string");
    expect(prompt).toContain("recommendation: string");
    expect(prompt).toContain("without ```json fence");
    expect(prompt).not.toContain("missing data");
    expect(prompt).not.toContain("best candidate");
  });

  it("renders route implicit fields in continuation prompts", () => {
    const parsed = parseWorkflowOutput(strictJson({ summary: "missing route" }), {
      implicitFields: { route: z.enum(["left", "right"]) }
    });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;

    const prompt = formatContinuationPrompt({ failure: parsed, implicitOutputFields: ["route:left|right"] });

    expect(prompt).toContain("route: \"left\" | \"right\"");
    expect(prompt).not.toContain("route:left|right");
  });

  it("uses a five second Agent Task Retry interval by default", () => {
    expect(AGENT_TASK_RETRY_DELAY_MS).toBe(5_000);
    expect(agentTaskRetryDelayMs()).toBe(5_000);
    setAgentTaskRetryDelayForTests(0);
    expect(agentTaskRetryDelayMs()).toBe(0);
  });

  it("renders implicit fields inside the final output schema", () => {
    const footer = outputSchemaFooter(GATE_SCHEMA, ["verdict"]);

    expect(footer).toContain("# Final Output Contract");
    expect(footer).toContain("verdict: \"pass\" | \"pass_with_warnings\" | \"blocked\" | \"failed\" | \"unknown\"");
    expect(footer).toContain("**After completing the whole task, respond with exactly one valid, parseable final JSON object without ```json fence that satisfies this schema; the response must start with `{` and end with `}` and include no prose, Markdown, or code fences.**");
  });

  it("renders route implicit fields inside the final output schema", () => {
    const footer = outputSchemaFooter(undefined, ["route:left|right"]);

    expect(footer).toContain("route: \"left\" | \"right\"");
    expect(footer).not.toContain("route:left|right");
  });
});
