import { describe, expect, it } from "vitest";
import { localizeResumePolicyForSegment, mergeResumePolicy, parseResumePolicyOptions, validateResumePolicy } from "../../src/runtime/resume-policy.js";
import { WorkflowSpecSchema } from "../../src/schema/workflow-spec.js";

const spec = WorkflowSpecSchema.parse({
  schemaVersion: "acpx-workflow-orchestrator.workflow/v1",
  name: "resume-policy",
  root: "review_files",
  roles: {
    reviewer: { category: "review", agent: "aiden", mode: "readOnly" },
    editor: { category: "implementation", agent: "trae", mode: "edit" }
  },
  limits: { stageTimeoutMinutes: 10 },
  stages: [
    {
      id: "review_files",
      kind: "fanout",
      items: { source: "input.files" },
      limits: { maxFanoutItems: 4 },
      prompt: "Review one file",
      laneGroups: [{ id: "review", mode: "all", lanes: [{ id: "reviewer", role: "reviewer" }] }]
    },
    {
      id: "edit_files",
      kind: "fanout",
      items: { source: "input.files" },
      limits: { maxFanoutItems: 2 },
      prompt: "Edit one file",
      laneGroups: [{ id: "edit", mode: "all", lanes: [{ id: "editor", role: "editor" }] }]
    },
    {
      id: "gate",
      kind: "gate",
      dependsOn: ["review_files"]
    }
  ]
});

describe("resume policy", () => {
  it("parses valid CLI policy options", () => {
    const parsed = parseResumePolicyOptions({
      allowPartialFanout: ["review_files"],
      maxFanoutItems: ["review_files=3"],
      skipFanoutItem: ["review_files=1", "review_files=2"]
    });
    expect(parsed.issues).toEqual([]);
    expect(parsed.policy).toEqual({
      fanout: {
        review_files: {
          allowPartial: true,
          maxItems: 3,
          skipItemIndexes: [1, 2]
        }
      }
    });
  });

  it("reports invalid CLI policy values as resume errors", () => {
    const parsed = parseResumePolicyOptions({
      maxFanoutItems: ["review_files=two"],
      skipFanoutItem: ["=1"]
    });
    expect(parsed.issues.map((entry) => entry.code)).toEqual([
      "RESUME_POLICY_INVALID_MAX_ITEMS",
      "RESUME_POLICY_INVALID_SKIP_ITEM"
    ]);
  });

  it("accepts read-only fanout policy that only tightens compiled limits", () => {
    const issues = validateResumePolicy(spec, {
      fanout: {
        review_files: { allowPartial: true, maxItems: 4, skipItemIndexes: [3] }
      }
    });
    expect(issues).toEqual([]);
  });

  it("rejects unknown, non-fanout, and non-tightening policy targets", () => {
    const issues = validateResumePolicy(spec, {
      fanout: {
        missing: { maxItems: 1 },
        gate: { allowPartial: true },
        review_files: { maxItems: 5, skipItemIndexes: [4] }
      }
    });
    expect(issues.map((entry) => entry.code)).toEqual([
      "RESUME_POLICY_STAGE_UNKNOWN",
      "RESUME_POLICY_STAGE_NOT_FANOUT",
      "RESUME_POLICY_MAX_ITEMS_NOT_TIGHTENING",
      "RESUME_POLICY_SKIP_ITEM_OUT_OF_RANGE"
    ]);
  });

  it("rejects partial-result resume on edit fanout", () => {
    const issues = validateResumePolicy(spec, {
      fanout: {
        edit_files: { allowPartial: true }
      }
    });
    expect(issues.map((entry) => entry.code)).toContain("RESUME_POLICY_PARTIAL_REQUIRES_READONLY");
  });

  it("merges resume policy without losing existing skipped items", () => {
    expect(mergeResumePolicy(
      { fanout: { review_files: { skipItemIndexes: [1], maxItems: 3 } } },
      { fanout: { review_files: { skipItemIndexes: [2], allowPartial: true } } }
    )).toEqual({
      fanout: {
        review_files: {
          maxItems: 3,
          allowPartial: true,
          skipItemIndexes: [1, 2]
        }
      }
    });
  });

  it("localizes global fanout item policy for a failed fanout batch segment", () => {
    expect(localizeResumePolicyForSegment({
      fanout: {
        review_files: { allowPartial: true, maxItems: 4, skipItemIndexes: [1, 3, 5] }
      }
    }, {
      purpose: "fanout-batch",
      fanoutStageId: "review_files",
      itemStart: 2,
      itemCount: 3
    })).toEqual({
      fanout: {
        review_files: { allowPartial: true, maxItems: 2, skipItemIndexes: [1] }
      }
    });
  });
});
