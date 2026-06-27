import { describe, expect, it } from "vitest";
import { validateWorkflowIR, type WorkflowIR } from "../src/index.js";

describe("WorkflowIR diagnostics contract", () => {
  it("returns stable diagnostic codes and paths for invalid IR", () => {
    const ir: WorkflowIR = {
      irVersion: 2,
      name: "bad workflow name",
      inputSchema: {
        kind: "object",
        fields: { id: { kind: "string" } },
        required: ["missing"],
        additionalProperties: false,
      },
      agents: {},
      root: {
        nodes: [
          {
            id: "review",
            kind: "agent",
            inputs: {},
            run: {
              kind: "agent_run",
              use: "reviewer",
              prompt: { kind: "template", parts: [] },
            },
          },
          {
            id: "review",
            kind: "guard",
            when: { kind: "ref", path: [] },
            otherwise: "fail",
          },
        ],
        outputs: {
          bad: { kind: "ref", path: [] },
        },
      },
      outputs: {},
      assets: {
        taskBundles: {
          wrong_key: {
            id: "actual_id",
            digest: "not-sha",
            runtime: "node",
          },
        },
      },
      lock: {
        acpusCoreVersion: "test",
        taskBundleDigests: {},
        generatedAt: "2026-01-01T00:00:00.000Z",
        notes: [],
      },
      diagnostics: [],
    };

    const diagnostics = validateWorkflowIR(ir);

    expect(diagnostics.map(diagnostic => diagnostic.code)).toEqual([
      "W002",
      "SC001",
      "A001",
      "ID002",
      "E001",
      "E001",
      "T004",
      "T005",
    ]);
    expect(diagnostics).toContainEqual(expect.objectContaining({
      code: "A001",
      path: "root.nodes.review.run.use",
    }));
    expect(diagnostics).toContainEqual(expect.objectContaining({
      code: "SC001",
      path: "inputSchema",
    }));
    expect(diagnostics).toContainEqual(expect.objectContaining({
      code: "T005",
      path: "assets.taskBundles.wrong_key.digest",
    }));
  });
});
