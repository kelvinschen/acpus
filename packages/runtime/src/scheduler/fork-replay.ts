import { createHash } from "node:crypto";
import type { AgentDefinitionIR, AgentNodeIR, ExprIR, NodeIR, SignalNodeIR, TaskNodeIR } from "@acpus/core/ir";
import { tryEvaluateExpr, type EvaluationScope } from "../evaluation/evaluator.js";
import { stableJson } from "../stable-json.js";
import type { ReplayIdentity } from "./types.js";

type ReplayLeaf = AgentNodeIR | TaskNodeIR | SignalNodeIR;
const missingArtifact = Symbol("missingArtifact");

export function replayIdentity(
  node: ReplayLeaf,
  scope: EvaluationScope,
  agent: AgentDefinitionIR | undefined,
  artifactDigest: (uri: string) => string | undefined,
): ReplayIdentity | undefined {
  if (node.kind === "agent" && node.run.sessionKey !== undefined) return undefined;
  const dependencies = declaredRefs(node).map(path => {
    const value = tryEvaluateExpr({ kind: "ref", path }, scope);
    if (value.isErr()) return undefined;
    const canonical = canonicalValue(value.value, artifactDigest);
    return canonical === missingArtifact ? undefined : [path, canonical];
  });
  if (dependencies.some(value => value === undefined)) return undefined;
  const operation = node.kind === "agent" ? { node, agent } : { node };
  return {
    operationDigest: digest(operation),
    inputDigest: digest(dependencies),
  };
}

function declaredRefs(node: ReplayLeaf): string[][] {
  const expressions = node.kind === "agent"
    ? [node.run.prompt, node.run.cwd, ...Object.values(node.run.env ?? {}), node.timeout]
    : node.kind === "task"
      ? [node.run.input, node.run.cwd, ...Object.values(node.run.env ?? {}), node.run.execution?.defaultCommandTimeout, node.timeout]
      : [node.run.prompt, node.timeout, node.onTimeout?.message];
  const refs = new Map<string, string[]>();
  for (const expression of expressions) {
    if (expression) collectRefs(expression, refs);
  }
  return [...refs.values()].sort((left, right) => stableJson(left).localeCompare(stableJson(right)));
}

function collectRefs(expression: ExprIR, refs: Map<string, string[]>): void {
  if (expression.kind === "ref") {
    refs.set(stableJson(expression.path), expression.path);
    return;
  }
  if (expression.kind === "call") {
    for (const argument of expression.args) collectRefs(argument, refs);
  } else if (expression.kind === "array") {
    for (const item of expression.items) collectRefs(item, refs);
  } else if (expression.kind === "object") {
    for (const value of Object.values(expression.fields)) collectRefs(value, refs);
  } else if (expression.kind === "template") {
    for (const part of expression.parts) {
      if (part.kind === "expr") collectRefs(part.expr, refs);
    }
  }
}

function canonicalValue(
  value: unknown,
  artifactDigest: (uri: string) => string | undefined,
): unknown | typeof missingArtifact {
  if (value === undefined) return ["undefined"];
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return ["value", value];
  }
  if (Array.isArray(value)) {
    const items = value.map(item => canonicalValue(item, artifactDigest));
    return items.includes(missingArtifact) ? missingArtifact : ["array", items];
  }
  if (typeof value !== "object") return ["unsupported"];
  const candidate = value as { kind?: unknown; uri?: unknown };
  if (candidate.kind === "artifact" && typeof candidate.uri === "string") {
    const contentDigest = artifactDigest(candidate.uri);
    return contentDigest === undefined ? missingArtifact : ["artifact", contentDigest];
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => [key, canonicalValue(item, artifactDigest)]);
  return entries.some(([, item]) => item === missingArtifact) ? missingArtifact : ["object", entries];
}

function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(stableJson(value)).digest("hex")}`;
}

export function isReplayLeaf(node: NodeIR): node is ReplayLeaf {
  return node.kind === "agent" || node.kind === "task" || node.kind === "signal";
}
