import { describe, expect, it } from "vitest";
import { lintWorkflow } from "../../src/index.js";
import { expectDiagnostic, expectNoDiagnostic, expectOk } from "../support/diagnostic-helpers.js";

const AGENTS = `agents:\n  m: { type: command, use: "x" }`;

function wf(body: string): string {
  return `version: 1\nname: t\n${AGENTS}\nworkflow:\n  steps:\n${body}`;
}

describe("@acpus/core compiler: scoped expression validation", () => {
  describe("field-path validity (A)", () => {
    it("rejects a misspelled output field and lists available fields", () => {
      const result = lintWorkflow(
        wf(`    - id: collect
      run: agent
      use: m
      prompt: hi
      output: { report_path: string, file_count: integer }
    - id: use
      run: agent
      use: m
      prompt: "got \${{ steps.collect.output.reprot_path }}"`)
      );
      expect(result.ok).toBe(false);
      expectDiagnostic(result, { code: "EXPR_UNKNOWN_FIELD", message: "reprot_path" });
      const diag = result.diagnostics.find((d) => d.code === "EXPR_UNKNOWN_FIELD")!;
      expect(diag.message).toContain("report_path");
      expect(diag.message).toContain("file_count");
    });

    it("accepts a valid output field path", () => {
      const result = lintWorkflow(
        wf(`    - id: collect
      run: agent
      use: m
      prompt: hi
      output: { report_path: string }
    - id: use
      run: agent
      use: m
      prompt: "got \${{ steps.collect.output.report_path }}"`)
      );
      expectOk(result);
    });

    it("stays silent when the step declares no output schema (dyn)", () => {
      const result = lintWorkflow(
        wf(`    - id: collect
      run: agent
      use: m
      prompt: hi
    - id: use
      run: agent
      use: m
      prompt: "got \${{ steps.collect.output.anything.deep }}"`)
      );
      expectOk(result);
      expectNoDiagnostic(result, "EXPR_UNKNOWN_FIELD");
    });

    it("stops descending at an open object without false positives", () => {
      const result = lintWorkflow(
        wf(`    - id: collect
      run: agent
      use: m
      prompt: hi
      output: { meta: object }
    - id: use
      run: agent
      use: m
      prompt: "got \${{ steps.collect.output.meta.whatever }}"`)
      );
      expectOk(result);
    });

    it("validates the fanout item element schema", () => {
      const result = lintWorkflow(
        wf(`    - id: plan
      run: agent
      use: m
      prompt: hi
      output: { topics: [{ topic: string, focus: string }] }
    - id: fan
      fanout:
        over: steps.plan.output.topics
        do:
          - id: each
            run: agent
            use: m
            prompt: "review \${{ item.topci }}"`)
      );
      expect(result.ok).toBe(false);
      expectDiagnostic(result, { code: "EXPR_UNKNOWN_FIELD", message: "fanout item" });
    });

    it("accepts workflow metadata fields in expressions", () => {
      const result = lintWorkflow(
        `version: 1
name: t
${AGENTS}
workflow:
  steps:
    - id: run_it
      run: program
      cmd: ["node", "\${{ workflow.source_dir }}/scripts/helper.mjs"]
outputs:
  name: "\${{ workflow.name }}"
  description: "\${{ workflow.description }}"
  source_path: "\${{ workflow.source_path }}"`
      );
      expectOk(result);
      expectNoDiagnostic(result, "EXPR_UNKNOWN_ROOT");
      expectNoDiagnostic(result, "EXPR_UNKNOWN_FIELD");
    });

    it("rejects an unknown workflow metadata field", () => {
      const result = lintWorkflow(
        wf(`    - id: run_it
      run: program
      cmd: ["echo", "\${{ workflow.missing }}"]`)
      );
      expect(result.ok).toBe(false);
      expectDiagnostic(result, { code: "EXPR_UNKNOWN_FIELD", message: "workflow" });
    });
  });

  describe("scope visibility", () => {
    it("rejects a local root used outside its body", () => {
      const result = lintWorkflow(
        wf(`    - id: use
      run: agent
      use: m
      prompt: "got \${{ item.topic }}"`)
      );
      expect(result.ok).toBe(false);
      expectDiagnostic(result, { code: "EXPR_ROOT_OUT_OF_SCOPE", message: "item" });
    });

    it("allows loop scope variables inside the loop body", () => {
      const result = lintWorkflow(
        wf(`    - id: fix
      loop:
        until: loop.iter > 0 && loop.last.output.ok
        max_iterations: 3
        do:
          - id: attempt
            run: agent
            use: m
            prompt: "try \${{ loop.iter }}"
            output: { ok: boolean }`)
      );
      expectOk(result);
    });

    it("rejects a forward reference to a later sibling step", () => {
      const result = lintWorkflow(
        wf(`    - id: early
      run: agent
      use: m
      prompt: "\${{ steps.late.output.x }}"
    - id: late
      run: agent
      use: m
      prompt: hi
      output: { x: string }`)
      );
      expect(result.ok).toBe(false);
      expectDiagnostic(result, { code: "EXPR_UNKNOWN_STEP", message: "not visible" });
    });
  });

  describe("shell safety (B)", () => {
    it("warns when json() is spliced into a cmd", () => {
      const result = lintWorkflow(
        wf(`    - id: collect
      run: agent
      use: m
      prompt: hi
      output: { items: [{ topic: string }] }
    - id: run_it
      run: program
      cmd: ["bash", "-c", "echo \${{ json(steps.collect.output) }}"]`)
      );
      expectOk(result);
      expectDiagnostic(result, { code: "EXPR_NONSCALAR_IN_CMD" });
    });

    it("warns when a whole object output is spliced into a cmd", () => {
      const result = lintWorkflow(
        wf(`    - id: collect
      run: agent
      use: m
      prompt: hi
      output: { meta: object }
    - id: run_it
      run: program
      cmd: ["bash", "-c", "echo \${{ steps.collect.output.meta }}"]`)
      );
      expectDiagnostic(result, { code: "EXPR_NONSCALAR_IN_CMD" });
    });

    it("does not warn for a scalar field in a cmd", () => {
      const result = lintWorkflow(
        wf(`    - id: collect
      run: agent
      use: m
      prompt: hi
      output: { name: string }
    - id: run_it
      run: program
      cmd: ["bash", "-c", "echo \${{ steps.collect.output.name }}"]`)
      );
      expectOk(result);
      expectNoDiagnostic(result, "EXPR_NONSCALAR_IN_CMD");
    });

    it("does not warn when the non-scalar is routed through env (safe outlet)", () => {
      const result = lintWorkflow(
        wf(`    - id: collect
      run: agent
      use: m
      prompt: hi
      output: { meta: object }
    - id: run_it
      run: program
      env:
        OUT: "\${{ json(steps.collect.output) }}"
      cmd: ["bash", "-c", "echo \\"$OUT\\""]`)
      );
      expectOk(result);
      expectNoDiagnostic(result, "EXPR_NONSCALAR_IN_CMD");
    });
  });

  describe("regression fixes from adversarial review", () => {
    it("B1: does not crash when bare 'steps' is spliced into a cmd", () => {
      const result = lintWorkflow(
        wf(`    - id: run_it
      run: program
      cmd: ["echo", "\${{ steps }}"]`)
      );
      // The key assertion is that lint returns instead of throwing.
      expectNoDiagnostic(result, "EXPR_NONSCALAR_IN_CMD");
    });

    it("B2: does not corrupt a step reference for a step named 'loop'", () => {
      const result = lintWorkflow(
        wf(`    - id: loop
      run: agent
      use: m
      prompt: hi
      output: { z: string }
    - id: use
      run: agent
      use: m
      prompt: "got \${{ steps.loop.output.z }}"`)
      );
      expectOk(result);
      expectNoDiagnostic(result, "EXPR_UNKNOWN_STEP");
    });

    it("B2: still rewrites a bare loop. scope reference", () => {
      const result = lintWorkflow(
        wf(`    - id: fix
      loop:
        until: loop.iter > 0
        max_iterations: 3
        do:
          - id: attempt
            run: agent
            use: m
            prompt: "try \${{ loop.iter }}"`)
      );
      expectOk(result);
    });

    it("H2: validates switch.on field paths against the referenced step schema", () => {
      const result = lintWorkflow(
        wf(`    - id: pick
      run: agent
      use: m
      prompt: hi
      output: { mode: string }
    - id: sw
      switch:
        on: steps.pick.output.moed
        cases:
          - when: "true"
            do:
              - id: b
                run: agent
                use: m
                prompt: hi`)
      );
      expect(result.ok).toBe(false);
      expectDiagnostic(result, { code: "EXPR_UNKNOWN_FIELD", message: "moed" });
    });

    it("M1: rejects an input default that references a step output", () => {
      const result = lintWorkflow(
        `version: 1
name: t
${AGENTS}
input:
  x:
    type: string
    default: "\${{ steps.late.output.z }}"
workflow:
  steps:
    - id: late
      run: agent
      use: m
      prompt: hi
      output: { z: string }`
      );
      expect(result.ok).toBe(false);
      expectDiagnostic(result, { code: "EXPR_UNKNOWN_STEP" });
    });
  });

  describe("regression fixes from second adversarial review", () => {
    it("does not warn when an array ref is wrapped in a scalar-returning function in a cmd", () => {
      const result = lintWorkflow(
        wf(`    - id: c
      run: agent
      use: m
      prompt: hi
      output: { items: [{ x: string }] }
    - id: run_it
      run: program
      cmd: ["bash", "-c", "test \${{ len(steps.c.output.items) }} -gt 0"]`)
      );
      expectOk(result);
      expectNoDiagnostic(result, "EXPR_NONSCALAR_IN_CMD");
    });

    it("still warns on a bare non-scalar ref in a cmd (no scalar wrapper)", () => {
      const result = lintWorkflow(
        wf(`    - id: c
      run: agent
      use: m
      prompt: hi
      output: { items: [{ x: string }] }
    - id: run_it
      run: program
      cmd: ["bash", "-c", "echo \${{ steps.c.output.items }}"]`)
      );
      expectDiagnostic(result, { code: "EXPR_NONSCALAR_IN_CMD" });
    });

    it("validates shell-safety for a string-form cmd (not just array form)", () => {
      const result = lintWorkflow(
        wf(`    - id: c
      run: agent
      use: m
      prompt: hi
      output: { meta: object }
    - id: run_it
      run: program
      cmd: "echo \${{ steps.c.output.meta }}"`)
      );
      expectDiagnostic(result, { code: "EXPR_NONSCALAR_IN_CMD" });
    });

    it("validates field paths inside a string-form cmd", () => {
      const result = lintWorkflow(
        wf(`    - id: c
      run: agent
      use: m
      prompt: hi
      output: { report_path: string }
    - id: run_it
      run: program
      cmd: "cat \${{ steps.c.output.reprot_path }}"`)
      );
      expect(result.ok).toBe(false);
      expectDiagnostic(result, { code: "EXPR_UNKNOWN_FIELD", message: "reprot_path" });
    });
  });
});
