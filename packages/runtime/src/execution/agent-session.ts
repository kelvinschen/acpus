import { sha256Digest } from "@acpus/core/content-identity";
import type { AgentNodeIR } from "@acpus/core/ir";
import * as Result from "effect/Result";
import type { EvaluationScope } from "../evaluation/evaluator.js";
import { tryResolveString, type ResolutionError } from "../evaluation/resolvable.js";

export type AgentSessionIdentity = {
  agentSessionId: string;
  scopeDigest: ReturnType<typeof sha256Digest>;
  generation: number;
  explicitShared: boolean;
  explicitSessionKey?: string;
};

const SESSION_GROUP_DOMAIN = "acpus:session-group:v1\0";
const SESSION_SCOPE_DOMAIN = "acpus:agent-session-scope:v1\0";

export function resolveAgentSessionIdentity(
  node: AgentNodeIR,
  scope: EvaluationScope,
  runId: string | undefined,
  nodeKey: string,
  generation = 1,
): Result.Result<AgentSessionIdentity, ResolutionError> {
  const explicitSessionKey = renderSessionKey(node, scope);
  if (Result.isFailure(explicitSessionKey)) return Result.fail(explicitSessionKey.failure);
  if (!Number.isInteger(generation) || generation < 1) throw new TypeError("Agent Session generation must be a positive integer.");
  const canonicalRunId = runId ?? "local";
  const scopeDigest = agentSessionScopeDigest(
    canonicalRunId,
    explicitSessionKey.success === undefined ? "node" : "key",
    explicitSessionKey.success ?? nodeKey,
  );
  return Result.succeed({
    agentSessionId: agentSessionIdForScope(scopeDigest, generation),
    scopeDigest,
    generation,
    explicitShared: explicitSessionKey.success !== undefined,
    ...(explicitSessionKey.success === undefined ? {} : { explicitSessionKey: explicitSessionKey.success }),
  });
}

export function agentSessionScopeDigest(
  runId: string,
  kind: "node" | "key",
  value: string,
): ReturnType<typeof sha256Digest> {
  return sha256Digest(`${SESSION_SCOPE_DOMAIN}${JSON.stringify({ runId, kind, value })}`);
}

export function agentSessionIdForScope(
  scopeDigest: ReturnType<typeof sha256Digest>,
  generation: number,
): string {
  if (!Number.isInteger(generation) || generation < 1) throw new TypeError("Agent Session generation must be a positive integer.");
  return `acpus-${scopeDigest.slice("sha256:".length)}-g${generation}`;
}

export function resolveAgentSessionGroupDigest(
  node: AgentNodeIR,
  scope: EvaluationScope,
): Result.Result<string | undefined, ResolutionError> {
  return Result.map(renderSessionKey(node, scope), sessionKey => sessionKey === undefined
    ? undefined
    : sha256Digest(`${SESSION_GROUP_DOMAIN}${sessionKey}`));
}

function renderSessionKey(node: AgentNodeIR, scope: EvaluationScope): Result.Result<string | undefined, ResolutionError> {
  if (!node.run.sessionKey) return Result.succeed(undefined);
  const field = `Agent node '${node.id}' sessionKey`;
  const rendered = tryResolveString(node.run.sessionKey, scope, field);
  if (Result.isFailure(rendered)) return Result.fail(rendered.failure);
  if (rendered.success.trim().length === 0) {
    return Result.fail({
      type: "constraint",
      field,
      expected: "non-empty string",
      message: `${field} must render to a non-empty string.`,
    });
  }
  return Result.succeed(rendered.success);
}
