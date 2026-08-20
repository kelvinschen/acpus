import { createHash } from "node:crypto";
import { sha256Digest } from "@acpus/core/content-identity";
import type { AgentNodeIR } from "@acpus/core/ir";
import { err, ok, type Result } from "neverthrow";
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
const SESSION_ID_DOMAIN = "acpus:agent-session:v2\0";

export function resolveAgentSessionIdentity(
  node: AgentNodeIR,
  scope: EvaluationScope,
  runId: string | undefined,
  nodeKey: string,
  generation = 1,
): Result<AgentSessionIdentity, ResolutionError> {
  const explicitSessionKey = renderSessionKey(node, scope);
  if (explicitSessionKey.isErr()) return err(explicitSessionKey.error);
  if (!Number.isInteger(generation) || generation < 1) throw new TypeError("Agent Session generation must be a positive integer.");
  const canonicalRunId = runId ?? "local";
  const scopeDigest = agentSessionScopeDigest(
    canonicalRunId,
    explicitSessionKey.value === undefined ? "node" : "key",
    explicitSessionKey.value ?? nodeKey,
  );
  return ok({
    agentSessionId: agentSessionIdForScope(canonicalRunId, scopeDigest, generation),
    scopeDigest,
    generation,
    explicitShared: explicitSessionKey.value !== undefined,
    ...(explicitSessionKey.value === undefined ? {} : { explicitSessionKey: explicitSessionKey.value }),
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
  runId: string,
  scopeDigest: ReturnType<typeof sha256Digest>,
  generation: number,
): string {
  if (!Number.isInteger(generation) || generation < 1) throw new TypeError("Agent Session generation must be a positive integer.");
  const sessionIdentity = { runId, scopeDigest, generation };
  const digest = createHash("sha256")
    .update(`${SESSION_ID_DOMAIN}${JSON.stringify(sessionIdentity)}`)
    .digest()
    .subarray(0, 16)
    .toString("base64url");
  return `acpus-${digest}`;
}

export function resolveAgentSessionGroupDigest(
  node: AgentNodeIR,
  scope: EvaluationScope,
): Result<string | undefined, ResolutionError> {
  return renderSessionKey(node, scope).map(sessionKey => sessionKey === undefined
    ? undefined
    : sha256Digest(`${SESSION_GROUP_DOMAIN}${sessionKey}`));
}

function renderSessionKey(node: AgentNodeIR, scope: EvaluationScope): Result<string | undefined, ResolutionError> {
  if (!node.run.sessionKey) return ok(undefined);
  const field = `Agent node '${node.id}' sessionKey`;
  const rendered = tryResolveString(node.run.sessionKey, scope, field);
  if (rendered.isErr()) return err(rendered.error);
  if (rendered.value.trim().length === 0) {
    return err({
      type: "constraint",
      field,
      expected: "non-empty string",
      message: `${field} must render to a non-empty string.`,
    });
  }
  return ok(rendered.value);
}
