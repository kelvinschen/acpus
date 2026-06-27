import { parse as parseCel } from "@marcbachmann/cel-js";
import { toCelParseSource } from "./expressions-shared.js";

/**
 * One segment of a reference access chain. A `field` segment is a static member
 * access (`.name`); a `bracket` segment is a static `[...]` access; an `index`
 * segment is a dynamic `[...]` access whose result shape is unknown.
 */
export type ReferenceSegment =
  | { kind: "field"; name: string }
  | { kind: "bracket"; value: string | number }
  | { kind: "index" };

/** A resolved access chain rooted at a CEL identifier, e.g. `steps.x.output.f`. */
export interface ExpressionReference {
  /** The logical root identifier (loop_ctx is normalized back to `loop`). */
  root: string;
  segments: ReferenceSegment[];
}

export interface ExtractResult {
  references: ExpressionReference[];
  /** Names of standalone function calls. Used only for Acpus shape checks. */
  functions: string[];
  parseError?: string;
}

/** cel-js native AST node: `{ op, args }`. */
interface AstNode {
  op: string;
  args: unknown;
}

function isAstNode(value: unknown): value is AstNode {
  return typeof value === "object" && value !== null && typeof (value as AstNode).op === "string" && "args" in (value as AstNode);
}

/**
 * Parse a CEL source string and extract every identifier-rooted access chain and
 * standalone function-call name needed by Acpus workflow validation.
 *
 * Fail-quiet by contract: on parse failure we return the error text (so the
 * caller can emit EXPR_PARSE) and empty results rather than throwing.
 */
export function extractReferences(source: string): ExtractResult {
  let ast: AstNode;
  try {
    ast = parseCel(toCelParseSource(source)).ast as unknown as AstNode;
  } catch (error) {
    return { references: [], functions: [], parseError: error instanceof Error ? error.message : String(error) };
  }

  const references: ExpressionReference[] = [];
  const functions: string[] = [];
  collect(ast, references, functions, new Set());
  return { references, functions };
}

/** Build the canonical source spelling of a reference (index segments shown as `[]`). */
export function referenceToString(ref: ExpressionReference): string {
  let out = ref.root;
  for (const seg of ref.segments) {
    if (seg.kind === "field") out += `.${seg.name}`;
    else if (seg.kind === "bracket") out += `[${JSON.stringify(seg.value)}]`;
    else out += "[]";
  }
  return out;
}

/** Whether a reference contains no dynamic `[index]` segments. */
export function isStaticReference(ref: ExpressionReference): boolean {
  return ref.segments.every((seg) => seg.kind !== "index");
}

/** Resolve a node into a chain if it is rooted at an identifier; else null. */
function asChain(node: AstNode, scope: Set<string>): { root: string; segments: ReferenceSegment[]; inner: AstNode[] } | null {
  if (node.op === "id") {
    const name = node.args;
    if (typeof name !== "string") return null;
    if (scope.has(name)) return null;
    return { root: normalizeRoot(name), segments: [], inner: [] };
  }

  if (node.op === ".") {
    const [base, field] = node.args as [unknown, unknown];
    if (!isAstNode(base) || typeof field !== "string") return null;
    const baseChain = asChain(base, scope);
    if (!baseChain) return null;
    return {
      root: baseChain.root,
      segments: [...baseChain.segments, { kind: "field", name: field }],
      inner: baseChain.inner
    };
  }

  if (node.op === "[]") {
    const [base, indexNode] = node.args as [unknown, unknown];
    if (!isAstNode(base)) return null;
    const baseChain = asChain(base, scope);
    if (!baseChain) return null;
    const staticIndex = staticBracketIndex(indexNode);
    return {
      root: baseChain.root,
      segments: [...baseChain.segments, staticIndex !== undefined ? { kind: "bracket", value: staticIndex } : { kind: "index" }],
      inner: staticIndex === undefined && isAstNode(indexNode) ? [...baseChain.inner, indexNode] : baseChain.inner
    };
  }

  return null;
}

function staticBracketIndex(node: unknown): string | number | undefined {
  if (!isAstNode(node) || node.op !== "value") return undefined;
  if (typeof node.args === "string") return node.args;
  if (typeof node.args === "number") return node.args;
  if (typeof node.args === "bigint") return Number(node.args);
  return undefined;
}

function collect(node: AstNode, refs: ExpressionReference[], functions: string[], scope: Set<string>): void {
  // Standalone function call: args = [name, [argNodes]]. Method (receiver)
  // calls (`rcall`) are not name-validated, matching prior regex behavior, but
  // their operands are still walked below.
  if (node.op === "call") {
    const [name, callArgs] = node.args as [unknown, unknown];
    if (typeof name === "string") functions.push(name);
    if (Array.isArray(callArgs)) {
      for (const arg of callArgs) if (isAstNode(arg)) collect(arg, refs, functions, scope);
    }
    return;
  }

  // Receiver calls may be CEL macros. Their local binding semantics are owned by
  // cel-js type checking; reference extraction keeps only workflow dependencies.
  if (node.op === "rcall") {
    const [name, receiver, params] = node.args as [unknown, unknown, unknown];
    if (isAstNode(receiver)) collect(receiver, refs, functions, scope);
    if (Array.isArray(params)) {
      const scoped = macroScope(name, params, scope);
      if (scoped) walkChildren(params.slice(1), refs, functions, scoped);
      else walkChildren(params, refs, functions, scope);
    }
    return;
  }

  const chain = asChain(node, scope);
  if (chain) {
    refs.push({ root: chain.root, segments: chain.segments });
    for (const innerNode of chain.inner) collect(innerNode, refs, functions, scope);
    return;
  }

  walkChildren(node.args, refs, functions, scope);
}

const BINDING_MACROS = new Set(["all", "exists", "exists_one", "filter", "map", "bind"]);

function macroScope(name: unknown, params: unknown[], scope: Set<string>): Set<string> | null {
  if (typeof name !== "string" || !BINDING_MACROS.has(name)) return null;
  const first = params[0];
  if (!isAstNode(first) || first.op !== "id") return null;
  const localName = first.args;
  return typeof localName === "string" ? new Set([...scope, localName]) : null;
}

/** Recurse into any nested AST nodes held in an args payload. */
function walkChildren(args: unknown, refs: ExpressionReference[], functions: string[], scope: Set<string>): void {
  if (isAstNode(args)) {
    collect(args, refs, functions, scope);
    return;
  }
  if (Array.isArray(args)) {
    for (const child of args) walkChildren(child, refs, functions, scope);
  }
}

/** The parser rewrites `loop.` → `loop_ctx.`; surface the logical root again. */
function normalizeRoot(name: string): string {
  return name === "loop_ctx" ? "loop" : name;
}
