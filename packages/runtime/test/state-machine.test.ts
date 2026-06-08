import { describe, it, expect } from "vitest";
import {
  canTransition,
  transition,
  isTerminal,
  createInitialNodeState,
  resetFailedForRetry,
  resetRunningForCrashRecovery,
  resetAwaitingForCrashRecovery
} from "../src/state-machine.js";
import type { NodeState } from "../src/types.js";

describe("Node State Machine", () => {
  describe("canTransition", () => {
    it("allows pending → running", () => {
      expect(canTransition("pending", "running")).toBe(true);
    });

    it("allows running → completed", () => {
      expect(canTransition("running", "completed")).toBe(true);
    });

    it("allows running → failed", () => {
      expect(canTransition("running", "failed")).toBe(true);
    });

    it("allows running → paused", () => {
      expect(canTransition("running", "paused")).toBe(true);
    });

    it("allows running → cancelled", () => {
      expect(canTransition("running", "cancelled")).toBe(true);
    });

    it("allows running → awaiting", () => {
      expect(canTransition("running", "awaiting")).toBe(true);
    });

    it("allows awaiting → completed (human decision delivered)", () => {
      expect(canTransition("awaiting", "completed")).toBe(true);
    });

    it("allows awaiting → cancelled (operator cancel)", () => {
      expect(canTransition("awaiting", "cancelled")).toBe(true);
    });

    it("rejects awaiting → paused (awaiting is distinct from operator pause)", () => {
      expect(canTransition("awaiting", "paused")).toBe(false);
    });

    it("allows paused → running", () => {
      expect(canTransition("paused", "running")).toBe(true);
    });

    it("allows paused → cancelled", () => {
      expect(canTransition("paused", "cancelled")).toBe(true);
    });

    it("rejects running → pending (control-plane reset, not a lifecycle transition)", () => {
      expect(canTransition("running", "pending")).toBe(false);
    });

    it("rejects failed → pending (control-plane reset, not a lifecycle transition)", () => {
      expect(canTransition("failed", "pending")).toBe(false);
    });

    it("rejects pending → completed (must go through running)", () => {
      expect(canTransition("pending", "completed")).toBe(false);
    });

    it("rejects completed → any (terminal)", () => {
      const states: NodeState[] = ["pending", "running", "awaiting", "completed", "failed", "paused", "cancelled"];
      for (const to of states) {
        expect(canTransition("completed", to)).toBe(false);
      }
    });

    it("rejects failed → any (terminal; retry is a control-plane reset, not a transition)", () => {
      const states: NodeState[] = ["pending", "running", "awaiting", "completed", "failed", "paused", "cancelled"];
      for (const to of states) {
        expect(canTransition("failed", to)).toBe(false);
      }
    });

    it("rejects cancelled → any (terminal)", () => {
      const states: NodeState[] = ["pending", "running", "awaiting", "completed", "failed", "paused", "cancelled"];
      for (const to of states) {
        expect(canTransition("cancelled", to)).toBe(false);
      }
    });
  });

  describe("transition", () => {
    it("returns the new state on legal transitions", () => {
      expect(transition("pending", "running")).toBe("running");
      expect(transition("running", "completed")).toBe("completed");
      expect(transition("running", "paused")).toBe("paused");
      expect(transition("paused", "running")).toBe("running");
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
