import { describe, expect, it } from "vitest";
import { commandForControl, confirmationForControl, controlStateForRun, nodeInspectionRefetchInterval, retryCommandTarget, retryTargetsForRun } from "../src/client/ui/App.js";
import type { RunDetails } from "../src/client/api.js";

describe("runtime run controls", () => {
  it("shows pause and cancel for active runs", () => {
    expect(controlStateForRun("running", false).map(control => control.id)).toEqual(["pause", "cancel"]);
    expect(controlStateForRun("running", false).every(control => !control.disabled)).toBe(true);
  });

  it("shows resume and cancel for paused runs", () => {
    expect(controlStateForRun("paused", false).map(control => control.id)).toEqual(["resume", "cancel"]);
  });

  it("shows target-first retry only for failed runs", () => {
    const controls = controlStateForRun("failed", false, [{ value: "node_a~123", label: "node: a", kind: "node" }]);
    expect(controls.map(control => control.id)).toEqual(["retry"]);
    expect(controls[0]!.disabled).toBe(false);
  });

  it("disables retry when no failed target exists", () => {
    const controls = controlStateForRun("failed", false, []);
    expect(controls).toMatchObject([{ id: "retry", disabled: true }]);
  });

  it("disables terminal run controls", () => {
    for (const status of ["completed", "canceled"]) {
      const controls = controlStateForRun(status, false);
      expect(controls.map(control => control.id)).toEqual(["pause", "cancel"]);
      expect(controls.every(control => control.disabled)).toBe(true);
    }
  });

  it("refreshes node Overview every second only while the run is non-terminal", () => {
    expect(nodeInspectionRefetchInterval("running")).toBe(1_000);
    expect(nodeInspectionRefetchInterval("awaiting")).toBe(1_000);
    expect(nodeInspectionRefetchInterval("completed")).toBe(false);
    expect(nodeInspectionRefetchInterval("failed")).toBe(false);
    expect(nodeInspectionRefetchInterval("canceled")).toBe(false);
  });

  it("extracts failed retry targets from frames, node instances, and group members", () => {
    const targets = retryTargetsForRun({
      dynamic: {
        version: 1,
        attempts: [],
        signalWaits: [],
        executionMetadata: [],
        frames: [
          { frameKey: "z_frame", nodeId: "route", frameKind: "node", status: "failed" },
          { frameKey: "ignored_scope", nodeId: "scope", frameKind: "scope", status: "failed" },
        ],
        nodeInstances: [
          { nodeKey: "a_node", nodeId: "score_gate", status: "failed" },
          { nodeKey: "done_node", nodeId: "done", status: "completed" },
        ],
        groupMembers: [
          { groupKey: "group", memberKey: "m_member", memberKind: "branch", branchId: "cache", status: "failed" },
          { groupKey: "group", memberKey: "a_node", memberKind: "branch", branchId: "duplicate", status: "failed" },
        ],
      },
    } satisfies Pick<RunDetails, "dynamic">);

    expect(targets).toEqual([
      { value: "a_node", label: "node: score_gate", kind: "node" },
      { value: "m_member", label: "member: cache", kind: "member" },
      { value: "z_frame", label: "frame: route", kind: "frame" },
    ]);
  });

  it("uses the only failed target directly and respects selected target for multiples", () => {
    const one = [{ value: "node_a", label: "node: a", kind: "node" as const }];
    const many = [...one, { value: "node_b", label: "node: b", kind: "node" as const }];

    expect(retryCommandTarget(one, undefined)).toBe("node_a");
    expect(retryCommandTarget(many, "node_b")).toBe("node_b");
    expect(retryCommandTarget(many, "missing")).toBeUndefined();
  });

  it("builds command payloads only after a confirmable target exists", () => {
    expect(commandForControl("pause", undefined, undefined)).toEqual({ type: "pause" });
    expect(commandForControl("resume", undefined, undefined)).toEqual({ type: "resume" });
    expect(commandForControl("cancel", undefined, "node_a")).toEqual({ type: "cancel", target: "node_a" });
    expect(commandForControl("cancel", undefined, undefined)).toEqual({ type: "cancel" });
    expect(commandForControl("retry", "node_a", undefined)).toEqual({ type: "retry", target: "node_a" });
    expect(commandForControl("retry", undefined, undefined)).toBeUndefined();
  });

  it("describes destructive and recovery controls before submission", () => {
    expect(confirmationForControl("cancel", "node_a")).toMatchObject({
      title: "Cancel selected target?",
      confirmLabel: "Cancel",
      tone: "cancel",
    });
    expect(confirmationForControl("retry", "node: score_gate")).toMatchObject({
      title: "Retry failed target?",
      confirmLabel: "Retry",
      tone: "retry",
    });
    expect(confirmationForControl("pause", undefined).title).toBe("Pause this run?");
    expect(confirmationForControl("resume", undefined).title).toBe("Resume this run?");
  });
});
