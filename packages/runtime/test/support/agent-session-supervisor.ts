import type {
  AgentSessionSupervisor,
  AgentTurnEvent,
  AgentTurnFailure,
  AgentTurnOutcome,
  TurnInput,
} from "@acpus/agent-executor";
import { err, ok, ResultAsync, type Result } from "neverthrow";
import {
  acpErrorFromFixture,
  fixtureEvent,
  type FixtureAgentTurnProgress,
  type FixtureAgentTurnRequest,
  type FixtureAgentTurnResult,
} from "./agent-turn.js";

export type FixtureAgentTurnExecutor = (request: FixtureAgentTurnRequest) => Promise<FixtureAgentTurnResult>;

export function testAgentSessionSupervisor(
  executeTurn: FixtureAgentTurnExecutor,
  shutdown: AgentSessionSupervisor["shutdown"] = () => new ResultAsync(Promise.resolve(ok(undefined))),
  onLease?: (input: Parameters<AgentSessionSupervisor["withSessionLease"]>[0]) => void,
): AgentSessionSupervisor {
  return {
    withSessionLease: (input, use) => {
      onLease?.(input);
      let turnNo = 0;
      return use({
        agentSessionId: input.session.agentSessionId,
        sessionLeaseId: `test-lease:${input.attempt.attemptId}`,
        projectionRef: `sessions/${input.session.agentSessionId}.json`,
        runTurn: <E>(turn: TurnInput<E>) => new ResultAsync((async (): Promise<Result<AgentTurnOutcome, AgentTurnFailure<E>>> => {
          turnNo += 1;
          let sequence = 0;
          let sinkFailure: E | undefined;
          let latestProgressResponse = "";
          const emit = (event: AgentTurnEvent["event"], observedAt = new Date().toISOString(), elapsedMs = 0) => {
            if (sinkFailure !== undefined) return;
            const accepted = turn.onEvent({ sequence: sequence++, observedAt, elapsedMs, event });
            if (accepted.isErr()) sinkFailure = accepted.error;
          };
          const progress = (value: FixtureAgentTurnProgress) => {
            const latest = value.responses.at(-1) ?? "";
            if (latest !== latestProgressResponse) {
              const chunk = latest.startsWith(latestProgressResponse) ? latest.slice(latestProgressResponse.length) : latest;
              if (chunk.length > 0) emit({ type: "message", channel: "assistant", content: { type: "text", text: chunk } }, value.updatedAt);
              latestProgressResponse = latest;
            }
            if (value.summary.context || value.summary.tokenUsage) emit({
              type: "usage",
              ...(value.summary.context ? { context: { used: value.summary.context.used, size: value.summary.context.size } } : {}),
              ...(value.summary.tokenUsage ? { tokens: value.summary.tokenUsage } : {}),
            }, value.updatedAt);
            for (const tool of value.summary.tools.calls) emit({
              type: "tool",
              action: "update",
              toolCallId: tool.toolCallId,
              ...(tool.title ? { title: tool.title } : {}),
              ...(tool.toolName ? { name: tool.toolName } : {}),
              ...(tool.kind ? { kind: tool.kind } : {}),
              ...(tool.status ? { status: tool.status } : {}),
            }, value.updatedAt);
          };
          const config = {
            ...input.session.configuration.options,
            ...(input.session.configuration.model === undefined ? {} : { model: input.session.configuration.model }),
          };
          const result = await executeTurn({
            agent: input.session.agent,
            prompt: turn.prompt,
            cwd: input.session.cwd,
            env: input.session.env,
            agentSessionId: input.session.agentSessionId,
            permissionMode: input.session.permissionMode,
            ...(input.session.configuration.model === undefined ? {} : { model: input.session.configuration.model }),
            ...(turnNo !== 1 || Object.keys(config).length === 0 ? {} : { config }),
            ...(input.attempt.deadlineAt === undefined ? {} : { timeoutMs: Math.max(0, new Date(input.attempt.deadlineAt).getTime() - Date.now()) }),
            signal: input.attempt.signal,
            onEvent: event => {
              const accepted = turn.onEvent(event);
              if (accepted.isErr()) sinkFailure = accepted.error;
            },
            onProgress: progress,
            onObservation: observation => {
              const event = fixtureEvent(observation.event);
              if (event) emit(event, observation.event.observedAt, observation.event.elapsedMs);
            },
          });
          const snapshot = { responses: [...result.responses], summary: result.summary, timing: result.timing };
          if (sinkFailure !== undefined) return err({ type: "event_sink" as const, error: sinkFailure, snapshot, evidence: {} });
          if (result.status === "completed") return ok({
            terminal: { status: "completed" as const, stopReason: result.summary.stopReason ?? "end_turn" },
            finalResponse: result.finalResponse,
            snapshot,
          });
          if (result.status === "cancelled") return err({
            type: "cancelled" as const,
            reason: "provider" as const,
            snapshot,
            evidence: {
              protocolTerminal: {
                type: "provider_result" as const,
                result: { status: "cancelled" as const, stopReason: "cancelled" },
              },
            },
          });
          if (result.failure.kind === "timeout") return err({
            type: "policy_timeout" as const,
            deadlineAt: input.attempt.deadlineAt ?? result.timing.finishedAt,
            snapshot,
            evidence: {},
          });
          if (result.failure.kind === "inactivity_stale") return err({
            type: "inactivity_stale" as const,
            failAfterMs: result.failure.evidence?.failAfterMs ?? 0,
            silentForMs: result.failure.evidence?.silentForMs ?? 0,
            silenceStartedAt: result.failure.evidence?.silenceStartedAt ?? result.timing.startedAt,
            snapshot,
            evidence: {},
          });
          if (result.failure.kind === "worker_lost") return err({
            type: "capsule_lost" as const,
            error: { type: "process_capsule" as const, phase: "running" as const, code: "worker_exit" as const, message: result.failure.message },
            snapshot,
            evidence: {},
          });
          const error = acpErrorFromFixture(result.failure);
          return err({ type: "acp" as const, error, snapshot, evidence: { localFailure: { type: "local_error" as const, error } } });
        })()),
      }).mapErr(error => ({ type: "use" as const, error }));
    },
    withSessionsNeutralized: (_input, commit) => new ResultAsync(Promise.resolve(commit([]).mapErr(error => ({ type: "commit" as const, error })))),
    shutdown,
  };
}
