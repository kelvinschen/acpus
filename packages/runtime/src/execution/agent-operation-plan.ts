import type { Sha256Digest } from "@acpus/core/content-identity";
import { err, ok, type Result } from "neverthrow";
import type { AgentPromptOrigin } from "./agent-prompt.js";

export type AgentSessionCheckpoint =
  | "not_dispatched"
  | "dispatch_intent"
  | "owned_in_flight"
  | "provider_observed"
  | "terminal_observed"
  | "acceptance_unknown"
  | "terminal_unknown";

export type AgentSessionCheckpointValue =
  | Readonly<{
      checkpoint: "not_dispatched";
      attemptId: string;
      turnId?: never;
      sessionLeaseId?: never;
      promptOrigin: AgentPromptOrigin;
      inputDigest: Sha256Digest;
    }>
  | Readonly<{
      checkpoint: Exclude<AgentSessionCheckpoint, "not_dispatched">;
      attemptId: string;
      turnId: string;
      sessionLeaseId: string;
      promptOrigin: AgentPromptOrigin;
      inputDigest: Sha256Digest;
    }>;

type PlannedAgentSession = Readonly<{
  agentSessionId: string;
  scopeDigest: Sha256Digest;
  generation: number;
  explicitShared: boolean;
}>;

export type AgentAttemptOperationPlan =
  | Readonly<{
      operation: "start";
      session: PlannedAgentSession;
      sessionOpenMode: "new_or_empty";
      predecessorAttemptId?: string;
      promptOrigin: "authored";
      inputDigest: Sha256Digest;
      admittedFromCheckpoint?: AgentSessionCheckpoint;
    }>
  | Readonly<{
      operation: "continue";
      session: PlannedAgentSession;
      sessionOpenMode: "existing_required";
      predecessorAttemptId: string;
      promptOrigin: "authored" | "steering";
      inputDigest: Sha256Digest;
      admittedFromCheckpoint: "terminal_observed";
      steerEventSequence?: number;
    }>
  | Readonly<{
      operation: "safe_retry";
      session: PlannedAgentSession;
      sessionOpenMode: "new_or_empty" | "existing_required";
      predecessorAttemptId: string;
      promptOrigin: AgentPromptOrigin;
      inputDigest: Sha256Digest;
      admittedFromCheckpoint: "not_dispatched";
    }>;

export type AgentOperationPlanError =
  | Readonly<{
      type: "session_checkpoint_unknown";
      agentSessionId: string;
      checkpoint: AgentSessionCheckpoint;
      message: string;
    }>
  | Readonly<{
      type: "safe_retry_input_mismatch";
      agentSessionId: string;
      predecessorAttemptId: string;
      message: string;
    }>
  | Readonly<{
      type: "invalid_agent_operation_target";
      target: string;
      operation: "continue";
      reason: "active" | "no_session" | "not_terminal";
      message: string;
    }>;

type PromptIdentity = Readonly<{ promptOrigin: AgentPromptOrigin; inputDigest: Sha256Digest }>;

export type AgentAttemptAdmissionPlanningInput =
  | Readonly<{
      source: "first_materialization";
      target: string;
      session: PlannedAgentSession & { generation: 1 };
      prompt: PromptIdentity & { promptOrigin: "authored" };
    }>
  | Readonly<{
      source: "generation_start";
      target: string;
      session: PlannedAgentSession;
      predecessorAttemptId: string;
      predecessorCheckpoint: AgentSessionCheckpoint;
      prompt: PromptIdentity & { promptOrigin: "authored" };
    }>
  | Readonly<{
      source: "continue";
      target: string;
      active: boolean;
      session: PlannedAgentSession;
      checkpoint: AgentSessionCheckpointValue;
      predecessorAttemptId: string;
      prompt: PromptIdentity & { promptOrigin: "authored" | "steering" };
      steerEventSequence?: number;
    }>
  | Readonly<{
      source: "safe_retry";
      target: string;
      session: PlannedAgentSession;
      checkpoint: AgentSessionCheckpointValue;
      predecessorAttemptId: string;
      predecessorSessionOpenMode: "new_or_empty" | "existing_required";
      rebuiltPrompt: PromptIdentity;
    }>;

export function planAgentAttemptAdmission(
  input: AgentAttemptAdmissionPlanningInput,
): Result<AgentAttemptOperationPlan, AgentOperationPlanError> {
  if (input.source === "first_materialization") {
    return ok({
      operation: "start",
      session: input.session,
      sessionOpenMode: "new_or_empty",
      promptOrigin: "authored",
      inputDigest: input.prompt.inputDigest,
    });
  }
  if (input.source === "generation_start") {
    return ok({
      operation: "start",
      session: input.session,
      sessionOpenMode: "new_or_empty",
      predecessorAttemptId: input.predecessorAttemptId,
      promptOrigin: "authored",
      inputDigest: input.prompt.inputDigest,
      admittedFromCheckpoint: input.predecessorCheckpoint,
    });
  }
  if (input.source === "continue") return planContinue(input);
  if (input.checkpoint.checkpoint !== "not_dispatched"
    || input.checkpoint.promptOrigin !== input.rebuiltPrompt.promptOrigin
    || input.checkpoint.inputDigest !== input.rebuiltPrompt.inputDigest) {
    return err({
      type: "safe_retry_input_mismatch",
      agentSessionId: input.session.agentSessionId,
      predecessorAttemptId: input.predecessorAttemptId,
      message: "Safe retry requires the predecessor's exact not-dispatched prompt identity.",
    });
  }
  return ok({
    operation: "safe_retry",
    session: input.session,
    sessionOpenMode: input.predecessorSessionOpenMode,
    predecessorAttemptId: input.predecessorAttemptId,
    ...input.rebuiltPrompt,
    admittedFromCheckpoint: "not_dispatched",
  });
}

function planContinue(
  input: Extract<AgentAttemptAdmissionPlanningInput, { source: "continue" }>,
): Result<AgentAttemptOperationPlan, AgentOperationPlanError> {
  if (input.active) return err(invalid(input.target, "active"));
  if (unknown(input.checkpoint.checkpoint)) return err(unknownCheckpoint(input.session, input.checkpoint.checkpoint));
  if (input.checkpoint.checkpoint !== "terminal_observed") return err(invalid(input.target, "not_terminal"));
  return ok({
    operation: "continue",
    session: input.session,
    sessionOpenMode: "existing_required",
    predecessorAttemptId: input.predecessorAttemptId,
    ...input.prompt,
    admittedFromCheckpoint: "terminal_observed",
    ...(input.steerEventSequence === undefined ? {} : { steerEventSequence: input.steerEventSequence }),
  });
}

function unknown(checkpoint: AgentSessionCheckpoint): checkpoint is "acceptance_unknown" | "terminal_unknown" {
  return checkpoint === "acceptance_unknown" || checkpoint === "terminal_unknown";
}

function unknownCheckpoint(session: PlannedAgentSession, checkpoint: AgentSessionCheckpoint): AgentOperationPlanError {
  return {
    type: "session_checkpoint_unknown",
    agentSessionId: session.agentSessionId,
    checkpoint,
    message: `Agent Session '${session.agentSessionId}' checkpoint '${checkpoint}' is not safe for automatic continuity.`,
  };
}

function invalid(
  target: string,
  reason: "active" | "no_session" | "not_terminal",
): AgentOperationPlanError {
  return {
    type: "invalid_agent_operation_target",
    target,
    operation: "continue",
    reason,
    message: `Agent target '${target}' cannot continue from ${reason}.`,
  };
}
