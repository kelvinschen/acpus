import * as Result from "effect/Result";
import { describe, expect, it } from "vitest";
import { sha256Digest } from "@acpus/core/content-identity";
import { planAgentAttemptAdmission } from "../src/execution/agent-operation-plan.js";

const scopeDigest = sha256Digest("scope");
const inputDigest = sha256Digest("prompt");
const session = {
  agentSessionId: "acpus-abcdefghijklmnopqrstuv",
  scopeDigest,
  generation: 1,
  explicitShared: false,
};

describe("Agent Attempt admission planning", () => {
  it("starts generation one with the authored prompt", () => {
    expect(Result.getOrThrow(planAgentAttemptAdmission({
      source: "first_materialization",
      target: "agent~1",
      session: { ...session, generation: 1 },
      prompt: { promptOrigin: "authored", inputDigest },
    }))).toMatchObject({
      operation: "start",
      sessionOpenMode: "new_or_empty",
      promptOrigin: "authored",
    });
  });

  it("starts the next generation from an abandoned predecessor", () => {
    expect(Result.getOrThrow(planAgentAttemptAdmission({
      source: "generation_start",
      target: "agent~1",
      session: { ...session, agentSessionId: "acpus-bcdefghijklmnopqrstuvw", generation: 2 },
      predecessorAttemptId: "attempt-1",
      predecessorCheckpoint: "terminal_observed",
      prompt: { promptOrigin: "authored", inputDigest },
    }))).toMatchObject({
      operation: "start",
      predecessorAttemptId: "attempt-1",
      admittedFromCheckpoint: "terminal_observed",
    });
  });

  it("continues a terminal Session for authored and steering prompts", () => {
    const checkpoint = {
      checkpoint: "terminal_observed" as const,
      attemptId: "attempt-1",
      turnId: "turn-1",
      sessionLeaseId: "lease-1",
      promptOrigin: "authored" as const,
      inputDigest,
    };
    expect(Result.getOrThrow(planAgentAttemptAdmission({
      source: "continue",
      target: "agent~1",
      active: false,
      session,
      checkpoint,
      predecessorAttemptId: "attempt-1",
      prompt: { promptOrigin: "steering", inputDigest: sha256Digest("steer") },
      steerEventSequence: 12,
    }))).toMatchObject({
      operation: "continue",
      promptOrigin: "steering",
      steerEventSequence: 12,
    });
  });

  it("allows Safe Retry only for the exact not-dispatched prompt", () => {
    const checkpoint = {
      checkpoint: "not_dispatched" as const,
      attemptId: "attempt-1",
      promptOrigin: "authored" as const,
      inputDigest,
    };
    expect(Result.getOrThrow(planAgentAttemptAdmission({
      source: "safe_retry",
      target: "agent~1",
      session,
      checkpoint,
      predecessorAttemptId: "attempt-1",
      predecessorSessionOpenMode: "new_or_empty",
      rebuiltPrompt: { promptOrigin: "authored", inputDigest },
    }))).toMatchObject({ operation: "safe_retry" });
    expect(Result.getOrThrow(Result.flip(planAgentAttemptAdmission({
      source: "safe_retry",
      target: "agent~1",
      session,
      checkpoint,
      predecessorAttemptId: "attempt-1",
      predecessorSessionOpenMode: "new_or_empty",
      rebuiltPrompt: { promptOrigin: "authored", inputDigest: sha256Digest("different") },
    }))).type).toBe("safe_retry_input_mismatch");
  });
});
