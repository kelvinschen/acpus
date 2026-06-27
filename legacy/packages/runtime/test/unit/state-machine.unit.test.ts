import { describe, it, expect } from "vitest";
import {
  canTransition,
  transition,
  isTerminal,
  createInitialNodeState,
  resetFailedForRetry,
  resetCancelledForRunRetry,
  resetRunningForCrashRecovery,
  resetAwaitingForCrashRecovery,
  resetPausedForRunResume,
  cancelPendingForRunCancel
} from "../../src/state-machine.js";
import type { NodeState } from "../../src/types.js";

describe("Node State Machine", () => {
  describe("canTransition", () => {
    const states: NodeState[] = ["pending", "running", "awaiting", "completed", "failed", "paused", "cancelled"];

    // Legal lifecycle transitions
    const legal: [NodeState, NodeState][] = [
      ["pending", "running"],
      ["running", "completed"],
      ["running", "failed"],
      ["running", "paused"],
      ["running", "cancelled"],
      ["running", "awaiting"],
      ["awaiting", "completed"],
      ["awaiting", "cancelled"],
      ["paused", "cancelled"],
    ];
    it.each(legal)("allows %s -> %s", (from, to) => {
      expect(canTransition(from, to)).toBe(true);
    });

    // Illegal lifecycle shortcuts and control-plane mismatches
    const illegal: [NodeState, NodeState][] = [
      ["awaiting", "paused"],
      ["paused", "running"],
      ["running", "pending"],
      ["failed", "pending"],
      ["pending", "completed"],
      ["pending", "cancelled"],
    ];
    it.each(illegal)("rejects %s -> %s", (from, to) => {
      expect(canTransition(from, to)).toBe(false);
    });

    // Terminal states reject all transitions (retry is a control-plane reset)
    const terminal: [NodeState, NodeState][] = [
      ...states.map((to): [NodeState, NodeState] => ["completed", to]),
      ...states.map((to): [NodeState, NodeState] => ["failed", to]),
      ...states.map((to): [NodeState, NodeState] => ["cancelled", to]),
    ];
    it.each(terminal)("rejects %s -> %s (terminal)", (from, to) => {
      expect(canTransition(from, to)).toBe(false);
    });
  });

  describe("transition", () => {
    it("returns the new state on legal transitions", () => {
      expect(transition("pending", "running")).toBe("running");
      expect(transition("running", "completed")).toBe("completed");
      expect(transition("running", "paused")).toBe("paused");
      expect(transition("paused", "cancelled")).toBe("cancelled");
    });

    it("throws on illegal transitions", () => {
      expect(() => transition("pending", "completed")).toThrow("Illegal state transition");
      expect(() => transition("completed", "running")).toThrow("Illegal state transition");
      expect(() => transition("failed", "running")).toThrow("Illegal state transition");
    });
  });

  describe("isTerminal", () => {
    it("returns true for terminal states", () => {
      expect(isTerminal("completed")).toBe(true);
      expect(isTerminal("failed")).toBe(true);
      expect(isTerminal("cancelled")).toBe(true);
    });

    it("returns false for non-terminal states", () => {
      expect(isTerminal("pending")).toBe(false);
      expect(isTerminal("running")).toBe(false);
      expect(isTerminal("awaiting")).toBe(false);
      expect(isTerminal("paused")).toBe(false);
    });
  });

  describe("control-plane resets", () => {
    it("resetFailedForRetry resets a failed node to pending", () => {
      expect(resetFailedForRetry("failed")).toBe("pending");
    });

    it("resetFailedForRetry rejects any non-failed state", () => {
      const states: NodeState[] = ["pending", "running", "completed", "paused", "cancelled"];
      for (const from of states) {
        expect(() => resetFailedForRetry(from)).toThrow(/only failed nodes are retryable/);
      }
    });

    it("resetCancelledForRunRetry resets a cancelled node to pending", () => {
      expect(resetCancelledForRunRetry("cancelled")).toBe("pending");
    });

    it("resetCancelledForRunRetry rejects any non-cancelled state", () => {
      const states: NodeState[] = ["pending", "running", "awaiting", "completed", "failed", "paused"];
      for (const from of states) {
        expect(() => resetCancelledForRunRetry(from)).toThrow(/only cancelled nodes use Run-level cancelled reset/);
      }
    });

    it("resetRunningForCrashRecovery resets a running node to pending", () => {
      expect(resetRunningForCrashRecovery("running")).toBe("pending");
    });

    it("resetRunningForCrashRecovery rejects any non-running state", () => {
      const states: NodeState[] = ["pending", "awaiting", "completed", "failed", "paused", "cancelled"];
      for (const from of states) {
        expect(() => resetRunningForCrashRecovery(from)).toThrow(/only running nodes can be reset/);
      }
    });

    it("resetAwaitingForCrashRecovery resets an awaiting node to pending", () => {
      expect(resetAwaitingForCrashRecovery("awaiting")).toBe("pending");
    });

    it("resetAwaitingForCrashRecovery rejects any non-awaiting state", () => {
      const states: NodeState[] = ["pending", "running", "completed", "failed", "paused", "cancelled"];
      for (const from of states) {
        expect(() => resetAwaitingForCrashRecovery(from)).toThrow(/only awaiting nodes can be reset/);
      }
    });

    it("resetPausedForRunResume resets a paused node to pending", () => {
      expect(resetPausedForRunResume("paused")).toBe("pending");
    });

    it("resetPausedForRunResume rejects any non-paused state", () => {
      const states: NodeState[] = ["pending", "running", "awaiting", "completed", "failed", "cancelled"];
      for (const from of states) {
        expect(() => resetPausedForRunResume(from)).toThrow(/only paused nodes can be reset/);
      }
    });

    it("cancelPendingForRunCancel cancels a materialized pending node", () => {
      expect(cancelPendingForRunCancel("pending")).toBe("cancelled");
    });

    it("cancelPendingForRunCancel rejects any non-pending state", () => {
      const states: NodeState[] = ["running", "awaiting", "completed", "failed", "paused", "cancelled"];
      for (const from of states) {
        expect(() => cancelPendingForRunCancel(from)).toThrow(/only pending nodes use Run-level pending cancel/);
      }
    });
  });

  describe("createInitialNodeState", () => {
    it("creates a pending state with attempt 0", () => {
      const state = createInitialNodeState("workflow/step-a", "step-a", "run.agent");
      expect(state).toEqual({
        nodeKey: "workflow/step-a",
        nodeId: "step-a",
        kind: "run.agent",
        state: "pending",
        attempt: 0
      });
    });
  });
});
