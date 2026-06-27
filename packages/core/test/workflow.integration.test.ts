import { describe, expect, it } from "vitest";
import {
  agent,
  compileWorkflowDefinition,
  defineWorkflow,
  eq,
  matches,
  secret,
  task,
  template,
  toSchemaIR,
  where,
  z,
} from "../src/index.js";

const NormalizeInput = z.object({ packageName: z.string() });
const NormalizeOutput = z.object({ normalized: z.string(), slug: z.string() });
const TestOutput = z.object({ passed: z.boolean(), summary: z.string() });
const ReviewOutput = z.object({ ready: z.boolean(), summary: z.string() });
const StatusOutput = z.object({ status: z.string() });

const normalizePackage = task.define({
  input: NormalizeInput,
  output: NormalizeOutput,
}).run(async ({ input }) => ({
  normalized: input.packageName.trim(),
  slug: input.packageName.trim().toLowerCase().replaceAll(" ", "-"),
}));

describe("workflow compilation", () => {
  it("compiles leaf nodes, guards, secrets, task bundles, and outputs into validated WorkflowIR", () => {
    const definition = defineWorkflow({
      name: "release_review",
      input: z.object({
        repoPath: z.path(),
        packageName: z.string(),
      }),
      agents: {
        reviewer: agent.define({
          provider: "codex",
          policy: "read",
          env: { REVIEW_TOKEN: secret("REVIEW_TOKEN") },
        }),
      },
    }).build(({ input, step, output }) => {
      const normalized = step.task("normalize_package", {
        input: { packageName: input.packageName },
        run: normalizePackage,
        params: { strict: true },
      });

      const tests = step.task("run_tests", {
        input: { slug: normalized.output.slug },
        output: TestOutput,
        run: async ({ input }) => ({
          passed: true,
          summary: `ok:${input.slug}`,
        }),
        env: {
          CI: "true",
          PACKAGE_TOKEN: secret("PACKAGE_TOKEN"),
        },
        cwd: input.repoPath,
      });

      step.guard("require_tests", {
        when: where(tests.output, { passed: true }),
        otherwise: "fail",
        message: template`Tests failed: ${tests.output.summary}`,
      });

      const review = step.agent("review", {
        input: { summary: tests.output.summary },
        output: ReviewOutput,
        run: ({ input: reviewInput }) => ({
          use: "reviewer",
          prompt: template`Review ${reviewInput.summary}`,
          session: { key: template`release:${reviewInput.summary}` },
        }),
      });

      return output({
        ready: review.output.ready,
        summary: review.output.summary,
        slug: normalized.output.slug,
      });
    });

    const ir = compileWorkflowDefinition(definition, {
      source: "packages/core/test/workflow.integration.test.ts",
    });

    expect(ir.diagnostics).toEqual([]);
    expect(ir.root.nodes.map(node => node.kind)).toEqual(["task", "task", "guard", "agent"]);
    expect(ir.root.nodes.map(node => node.id)).toEqual([
      "normalize_package",
      "run_tests",
      "require_tests",
      "review",
    ]);
    expect(ir.agents).toEqual({
      reviewer: {
        kind: "agent_definition",
        provider: "codex",
        policy: "read",
        env: {
          REVIEW_TOKEN: { kind: "secret", name: "REVIEW_TOKEN" },
        },
      },
    });
    expect(ir.root.nodes[0]).toMatchObject({
      kind: "task",
      run: { inline: false },
      outputSchema: toSchemaIR(NormalizeOutput),
      params: { strict: true },
      inputs: {
        packageName: { kind: "ref", path: ["input", "packageName"] },
      },
    });
    expect(ir.root.nodes[1]).toMatchObject({
      kind: "task",
      run: { inline: true },
      cwd: { kind: "ref", path: ["input", "repoPath"] },
      env: {
        CI: { kind: "literal", value: "true" },
        PACKAGE_TOKEN: { kind: "secret", name: "PACKAGE_TOKEN" },
      },
    });
    expect(ir.root.nodes[2]).toMatchObject({
      kind: "guard",
      otherwise: "fail",
      when: {
        kind: "call",
        fn: "eq",
        args: [
          { kind: "ref", path: ["nodes", "run_tests", "output", "passed"] },
          { kind: "literal", value: true },
        ],
      },
    });
    expect(ir.outputs).toMatchObject({
      ready: { kind: "ref", path: ["nodes", "review", "output", "ready"] },
      summary: { kind: "ref", path: ["nodes", "review", "output", "summary"] },
      slug: { kind: "ref", path: ["nodes", "normalize_package", "output", "slug"] },
    });
    expect(Object.values(ir.assets.taskBundles)).toHaveLength(2);
    expect(Object.values(ir.assets.taskBundles).every(bundle => bundle.digest.startsWith("sha256:"))).toBe(true);
    expect(ir.lock.taskBundleDigests).toEqual(
      Object.fromEntries(Object.entries(ir.assets.taskBundles).map(([id, bundle]) => [id, bundle.digest])),
    );
  });

  it("compiles current composite node shapes without invoking a runtime", () => {
    const definition = defineWorkflow({
      name: "composite_flow",
      input: z.object({
        items: z.array(z.string()),
        shouldRun: z.boolean(),
      }),
    }).build(({ input, step, output }) => {
      const gate = step.if("gate", {
        when: input.shouldRun,
        output: StatusOutput,
        then: ({ output }) => output({ status: "run" }),
        otherwise: ({ output }) => output({ status: "skip" }),
      });

      step.parallel("checks", {
        branches: {
          fast: ({ output }) => output({ status: gate.output.status }),
          slow: ({ output }) => output({ done: true }),
        },
        join: "all",
        maxConcurrency: 2,
      });

      step.fanout("per_item", {
        over: input.items,
        item: z.string(),
        output: z.object({ ok: z.boolean() }),
        do: ({ item, output }) => output({ ok: matches(item, ".+") }),
        join: "all",
        maxConcurrency: 4,
      });

      const retry = step.loop("retry_until_done", {
        maxIterations: 3,
        output: z.object({ done: z.boolean() }),
        do: ({ iter, output }) => output({ done: eq(iter, 2) }),
        until: ({ last }) => where(last.output, { done: true }),
        onMaxIterations: "complete",
      });

      return output({
        status: gate.output.status,
        done: retry.output.done,
      });
    });

    const ir = compileWorkflowDefinition(definition);

    expect(ir.diagnostics).toEqual([]);
    expect(ir.root.nodes.map(node => node.kind)).toEqual(["if", "parallel", "fanout", "loop"]);
    expect(ir.root.nodes[0]).toMatchObject({
      id: "gate",
      kind: "if",
      when: { kind: "ref", path: ["input", "shouldRun"] },
      outputSchema: { kind: "object" },
    });
    expect(ir.root.nodes[1]).toMatchObject({
      id: "checks",
      kind: "parallel",
      join: "all",
      maxConcurrency: 2,
      branches: {
        fast: {
          outputs: {
            status: { kind: "ref", path: ["nodes", "gate", "output", "status"] },
          },
        },
      },
    });
    expect(ir.root.nodes[2]).toMatchObject({
      id: "per_item",
      kind: "fanout",
      over: { kind: "ref", path: ["input", "items"] },
      itemSchema: { kind: "string" },
      do: {
        outputs: {
          ok: {
            kind: "call",
            fn: "matches",
            args: [
              { kind: "ref", path: ["fanout", "per_item", "item"] },
              { kind: "literal", value: ".+" },
            ],
          },
        },
      },
    });
    expect(ir.root.nodes[3]).toMatchObject({
      id: "retry_until_done",
      kind: "loop",
      maxIterations: 3,
      onMaxIterations: "complete",
      until: {
        kind: "call",
        fn: "eq",
        args: [
          { kind: "ref", path: ["nodes", "retry_until_done.__last", "output", "done"] },
          { kind: "literal", value: true },
        ],
      },
    });
  });
});
