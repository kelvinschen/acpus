import { createHash } from "node:crypto";
import type { AgentNodeIR } from "@acpus/core/ir";
import { err, ok, type Result } from "neverthrow";
import type { EvaluationScope } from "../evaluation/evaluator.js";
import { tryResolveString, type ResolutionError } from "../evaluation/resolvable.js";

export type AgentSessionIdentity = {
  sessionName: string;
  explicitSessionKey?: string;
};

export function resolveAgentSessionIdentity(
  node: AgentNodeIR,
  scope: EvaluationScope,
  runId: string | undefined,
  nodeKey: string,
): Result<AgentSessionIdentity, ResolutionError> {
  const explicitSessionKey = renderSessionKey(node, scope);
  if (explicitSessionKey.isErr()) return err(explicitSessionKey.error);
  const identity = explicitSessionKey.value === undefined
    ? { runId: runId ?? "local", nodeKey }
    : { runId: runId ?? "local", key: explicitSessionKey.value };
  const digest = createHash("sha256")
    .update(JSON.stringify(identity))
    .digest()
    .subarray(0, 16)
    .toString("base64url");
  return ok({
    sessionName: `acpus-${digest}`,
    ...(explicitSessionKey.value === undefined ? {} : { explicitSessionKey: explicitSessionKey.value }),
  });
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
