import { describe, expect, it } from "vitest";
import {
  agentExecutionRefetchInterval,
  commandForControl,
  confirmationForControl,
  controlStateForRun,
  nodeInspectionRefetchInterval,
  retryCommandTarget,
  retryTargetsForControls,
} from "../src/client/ui/App.js";

describe("runtime run controls", () => {
  it("shows pause and cancel for active runs", () => {
    expect(controlStateForRun("running", false, [], true).map(control => control.id)).toEqual(["pause", "cancel"]);
    expect(controlStateForRun("running", false, [], true).every(control => !control.disabled)).toBe(true);
  });

  it("shows resume and cancel for paused runs", () => {
    expect(controlStateForRun("paused", false, [], true).map(control => control.id)).toEqual(["resume", "cancel"]);
  });

  it("disables run cancel when Runtime reports no useful cancel action", () => {
    expect(controlStateForRun("running", false, [], false)).toMatchObject([
      { id: "pause", disabled: false },
      { id: "cancel", disabled: true },
    ]);
  });

  it("shows target-first retry only for failed runs", () => {
    const controls = controlStateForRun("failed", false, [{ value: "node_a~123", label: "node: a", kind: "node" }]);
    expect(controls.map(control => control.id)).toEqual(["retry"]);
    expect(controls[0]!.disabled).toBe(false);
    expect(controlStateForRun(
      "running",
      false,
      [{ value: "node_a~123", label: "node: a", kind: "node" }],
      true,
    ).map(control => control.id)).toEqual(["pause", "cancel"]);
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

  it("refreshes an active Execution tab only while its scheduler status is active", () => {
    for (const status of ["starting", "ready", "running", "awaiting"]) {
      expect(agentExecutionRefetchInterval(true, status)).toBe(2_500);
    }
    for (const status of [undefined, "not_started", "completed", "failed", "timed_out", "cancelled"]) {
      expect(agentExecutionRefetchInterval(true, status)).toBe(false);
    }
    expect(agentExecutionRefetchInterval(false, "running")).toBe(false);
  });

  it("adds Web labels without reordering Runtime-approved retry targets", () => {
    const targets = retryTargetsForControls([
      { target: "z_frame", nodeId: "route", kind: "frame" },
      { target: "a_node", nodeId: "score_gate", kind: "node" },
      { target: "key_only", kind: "node" },
    ]);

    expect(targets).toEqual([
      { value: "z_frame", label: "frame: route", kind: "frame" },
      { value: "a_node", label: "node: score_gate", kind: "node" },
      { value: "key_only", label: "node: key_only", kind: "node" },
    ]);
  });

  it("disambiguates repeated authored labels with exact Runtime targets", () => {
    expect(retryTargetsForControls([
      { target: "task~item-0", nodeId: "task", kind: "node" },
      { target: "task~item-1", nodeId: "task", kind: "node" },
    ])).toEqual([
      { value: "task~item-0", label: "node: task (task~item-0)", kind: "node" },
      { value: "task~item-1", label: "node: task (task~item-1)", kind: "node" },
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
    expect(commandForControl("cancel", undefined, null)).toBeUndefined();
    expect(commandForControl("cancel", undefined, "")).toBeUndefined();
    expect(commandForControl("cancel", undefined, "   ")).toBeUndefined();
    expect(commandForControl("retry", "node_a", undefined)).toEqual({ type: "retry", target: "node_a" });
    expect(commandForControl("retry", "", undefined)).toBeUndefined();
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
