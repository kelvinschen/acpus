import type { DiagnosticBag } from "./diagnostics.js";
import type { IrNode } from "./types.js";
import { COMPOSITE_CONTRACTS } from "./composite-contract.js";
import { EXPRESSION_PATTERN } from "./expressions-shared.js";
import { isRecord } from "./schema/helpers.js";
import {
  extractReferences,
  isStaticReference,
  referenceToString,
  type ExpressionReference
} from "./cel-ast.js";

/**
 * Scope-aware static validation of CEL references in a compiled IR. Catches the
 * runtime failure classes that the flat collector cannot: `No such key`
 * (field-path against declared schemas), out-of-scope local roots, step
 * references that are not visible at a position, and non-scalar values spliced
 * into a `cmd` (shell-breaking).
 *
 * Fail-quiet by contract: anything whose shape cannot be determined statically
 * (dyn locals, open objects, undeclared schemas, composite projections) is
 * silently allowed. The validator never throws.
 */
export interface ScopedValidationInput {
  root: IrNode;
  inputSchema: Record<string, unknown>;
  outputs: Record<string, unknown>;
  agents: Record<string, unknown>;
  allStepIds: Set<string>;
  diagnostics: DiagnosticBag;
}

/** Scope-gated local roots: valid only inside the composite that introduces them. */
const SCOPED_LOCAL_ROOTS = new Set(["loop", "item", "item_id", "item_index"]);

type ResolvedKind = "scalar" | "object" | "array" | "unknown";

interface ScopeContext {
  /** Step ids visible (already executed) at this position. */
  visibleSteps: Set<string>;
  /** Local roots in scope (loop/item/...) at this position. */
  locals: Set<string>;
  /** Element schema bound to `item` inside a fanout body, when statically known. */
  itemSchema?: Record<string, unknown>;
  /** Path for diagnostics. */
  path: string;
  /** True when validating a `cmd` array element (enables shell-safety check). */
  isCmd: boolean;
  /** True when this expression came from `${{ }}` template interpolation. */
  rawTemplate: boolean;
  /** True when a whole-field `${{ expr }}` preserves the expression's native value. */
  nativeSingleExpression: boolean;
}

export function validateScopedExpressions(input: ScopedValidationInput): void {
  const { root, inputSchema, outputs, agents, allStepIds, diagnostics } = input;

  const globalNodes = new Map<string, IrNode>();
  indexNodes(root, globalNodes);

  const r: Resolver = { globalNodes, inputSchema, allStepIds, diagnostics };

  // The implicit root pipeline threads its children sequentially.
  walkChildScope(root, new Set<string>(), [], undefined, r);

  // outputs / agents are top-scope template positions evaluated after the
  // workflow body, so every step id is visible; we keep visibility global there
  // to avoid false positives while still validating field paths.
  const topScope = (path: string): ScopeContext => ({
    visibleSteps: allStepIds,
    locals: new Set<string>(),
    path,
    isCmd: false,
    rawTemplate: false,
    nativeSingleExpression: false
  });

  visitStrings(outputs, "$.outputs", (source, path) => checkTemplateString(source, { ...topScope(path), nativeSingleExpression: true }, r));
  visitStrings(agents, "$.agents", (source, path) => checkTemplateString(source, topScope(path), r));

  // input defaults are evaluated before any step runs, so no step is visible;
  // an input default referencing a step output is a guaranteed runtime error.
  const inputScope = (path: string): ScopeContext => ({
    visibleSteps: new Set<string>(),
    locals: new Set<string>(),
    path,
    isCmd: false,
    rawTemplate: false,
    nativeSingleExpression: false
  });
  visitStrings(inputSchema, "$.input", (source, path) => checkTemplateString(source, inputScope(path), r));
}

interface Resolver {
  globalNodes: Map<string, IrNode>;
  inputSchema: Record<string, unknown>;
  allStepIds: Set<string>;
  diagnostics: DiagnosticBag;
}

/**
 * Walk a node's child list, threading step visibility. Visibility rules,
 * deliberately conservative (prefer false negatives over false positives):
 * - Sequential siblings: each child sees the steps declared before it.
 * - When a sibling completes, only its own public step id becomes visible.
 *   Descendant ids remain private to the composite/pipeline frame.
 * - Loop `do` bodies compile to a pipeline, so body ordering follows normal
 *   pipeline sibling visibility.
 */
function walkChildScope(node: IrNode, inheritedVisible: Set<string>, localsStack: string[][], itemSchema: Record<string, unknown> | undefined, r: Resolver): void {
  const isParallel = node.kind === "parallel";

  const childLists: IrNode[][] = node.branches
    ? node.branches.map((b) => [b.child])
    : node.children
      ? [node.children]
      : [];

  // Validate branch `when` (raw CEL, outer scope) before descending.
  if (node.branches) {
    const currentLocals = unionLocals(localsStack);
    for (const branch of node.branches) {
      if (branch.when !== undefined) {
        checkRawCelString(branch.when, { visibleSteps: inheritedVisible, locals: currentLocals, itemSchema, path: `${node.nodePath.join("/")}.when`, isCmd: false, rawTemplate: false, nativeSingleExpression: false }, r);
      }
    }
  }

  for (const children of childLists) {
    const running = new Set(inheritedVisible);
    for (const child of children) {
      const childVisible = isParallel ? new Set(inheritedVisible) : new Set(running);
      walkNode(child, childVisible, localsStack, itemSchema, r);
      running.add(child.id);
    }
  }
}

function walkNode(node: IrNode, inheritedVisible: Set<string>, localsStack: string[][], itemSchema: Record<string, unknown> | undefined, r: Resolver): void {
  const contract = COMPOSITE_CONTRACTS[node.kind];
  const currentLocals = unionLocals(localsStack);
  const nodePath = node.nodePath.join("/");

  const configVisible = new Set(inheritedVisible);

  for (const cfg of nodeConfigExpressions(node)) {
    const locals = cfg.bodyScoped ? new Set([...currentLocals, ...contract.bodyLocals]) : currentLocals;
    // Body-scoped fanout config (key) sees `item`; resolve its element schema.
    const cfgItemSchema = cfg.bodyScoped && node.kind === "fanout" ? fanoutItemSchema(node, r) : itemSchema;
    const ctx: ScopeContext = {
      visibleSteps: configVisible,
      locals,
      itemSchema: cfgItemSchema,
      path: `${nodePath}.${cfg.field}`,
      isCmd: cfg.isCmd === true,
      rawTemplate: false,
      nativeSingleExpression: cfg.nativeSingleExpression === true
    };
    if (cfg.rawCel) {
      checkRawCelString(cfg.source, ctx, r);
    } else {
      checkTemplateString(cfg.source, ctx, r);
    }
  }

  // Recurse with this node's body locals added for its children. A fanout binds
  // `item` to the element schema of its `over` array (when statically known).
  const childLocalsStack = contract.bodyLocals.length > 0 ? [...localsStack, contract.bodyLocals] : localsStack;
  const childItemSchema = node.kind === "fanout" ? fanoutItemSchema(node, r) : itemSchema;
  if ((node.children && node.children.length > 0) || (node.branches && node.branches.length > 0)) {
    walkChildScope(node, inheritedVisible, childLocalsStack, childItemSchema, r);
  }

  if (node.kind === "pipeline" && isRecord(node.metadata.outputs)) {
    const outputVisible = new Set(inheritedVisible);
    for (const child of node.children ?? []) outputVisible.add(child.id);
    visitStrings(node.metadata.outputs, `${nodePath}.outputs`, (source, path) =>
      checkTemplateString(source, { visibleSteps: outputVisible, locals: currentLocals, itemSchema, path, isCmd: false, rawTemplate: false, nativeSingleExpression: true }, r)
    );
  }
}

/**
 * Resolve the element schema bound to `item` inside a fanout body. Only returns
 * a schema when `over` is `steps.<id>.output[...typed array]`; literal arrays and
 * dyn references yield undefined (fail-quiet → item.* not validated).
 */
function fanoutItemSchema(node: IrNode, r: Resolver): Record<string, unknown> | undefined {
  const over = node.metadata.over;
  if (typeof over !== "string") return undefined;
  // A coerced literal array (JSON string) has no element schema we can use.
  if (over.trimStart().startsWith("[")) return undefined;

  const { references, parseError } = extractReferences(over);
  if (parseError || references.length !== 1) return undefined;
  const ref = references[0]!;
  if (ref.root !== "steps") return undefined;

  const stepNode = r.globalNodes.get((ref.segments[0] as { name?: string })?.name ?? "");
  if (!stepNode) return undefined;
  if (COMPOSITE_CONTRACTS[stepNode.kind].outputShape !== "schema") return undefined;
  const schema = stepNode.metadata.output;
  if (!isRecord(schema)) return undefined;

  // Walk to the array referenced by `over`, then return its item schema.
  const arr = resolveSchemaNode(schema, ref.segments, 2);
  if (arr && arr.type === "array" && isRecord(arr.items)) return arr.items;
  return undefined;
}

/** Resolve segments to the schema node they point at, or undefined if not closed. */
function resolveSchemaNode(schema: Record<string, unknown>, segments: ExpressionReference["segments"], start: number): Record<string, unknown> | undefined {
  let cur: Record<string, unknown> = schema;
  for (let i = start; i < segments.length; i++) {
    const seg = segments[i]!;
    if (seg.kind === "index") {
      if (cur.type === "array" && isRecord(cur.items)) { cur = cur.items; continue; }
      return undefined;
    }
    if (isClosedObject(cur)) {
      const properties = cur.properties as Record<string, unknown>;
      if (Object.prototype.hasOwnProperty.call(properties, seg.name)) {
        cur = properties[seg.name] as Record<string, unknown>;
        continue;
      }
    }
    return undefined;
  }
  return cur;
}

interface NodeConfigExpr {
  source: string;
  field: string;
  rawCel: boolean;
  bodyScoped?: boolean;
  isCmd?: boolean;
  nativeSingleExpression?: boolean;
}

/** Yield the expression-bearing config strings for a node, by kind. */
function nodeConfigExpressions(node: IrNode): NodeConfigExpr[] {
  const out: NodeConfigExpr[] = [];
  const md = node.metadata;
  const pushTemplate = (value: unknown, field: string, isCmd = false): void => {
    if (typeof value === "string") out.push({ source: value, field, rawCel: false, isCmd });
  };

  switch (node.kind) {
    case "run.agent":
      pushTemplate(md.prompt, "prompt");
      pushTemplate(md.cwd, "cwd");
      pushTemplate(md.session_key, "session_key");
      break;
    case "run.program":
      if (Array.isArray(md.cmd)) {
        md.cmd.forEach((item, index) => pushTemplate(item, `cmd[${index}]`, true));
      } else if (typeof md.cmd === "string") {
        pushTemplate(md.cmd, "cmd", true);
      }
      pushTemplate(md.cwd, "cwd");
      if (isRecord(md.env)) {
        for (const [key, value] of Object.entries(md.env)) pushTemplate(value, `env.${key}`);
      }
      break;
    case "run.signal":
      pushTemplate(md.prompt, "prompt");
      break;
    case "guard":
      if (typeof md.when === "string") out.push({ source: md.when, field: "when", rawCel: true });
      pushTemplate(md.message, "message");
      break;
    case "loop":
      if (typeof md.until === "string") out.push({ source: md.until, field: "until", rawCel: true, bodyScoped: true });
      break;
    case "fanout":
      if (typeof md.over === "string") out.push({ source: md.over, field: "over", rawCel: true });
      if (typeof md.key === "string") out.push({ source: md.key, field: "key", rawCel: false, bodyScoped: true });
      break;
    case "subworkflow":
      if (isRecord(md.input)) {
        for (const [key, value] of Object.entries(md.input)) {
          if (typeof value === "string") out.push({ source: value, field: `input.${key}`, rawCel: false, nativeSingleExpression: true });
        }
      }
      break;
    default:
      break;
  }
  return out;
}

/** Validate every ${{ }} expression inside a template string. */
function checkTemplateString(value: string, ctx: ScopeContext, r: Resolver): void {
  const matches = [...value.matchAll(EXPRESSION_PATTERN)];
  if (matches.length === 1) {
    const match = matches[0]!;
    const before = value.slice(0, match.index).trim();
    const after = value.slice(match.index! + match[0].length).trim();
    if (before === "" && after === "") {
      checkExpression((match[1] ?? "").trim(), ctx.nativeSingleExpression ? ctx : { ...ctx, rawTemplate: true }, r);
      EXPRESSION_PATTERN.lastIndex = 0;
      return;
    }
  }
  for (const match of matches) {
    const source = (match[1] ?? "").trim();
    if (source.length === 0) continue;
    checkExpression(source, { ...ctx, rawTemplate: true }, r);
  }
  EXPRESSION_PATTERN.lastIndex = 0;
}

/** Validate a raw-CEL field (when/until/over). Skip if it carries ${{ }} (flat collector warns). */
function checkRawCelString(value: string, ctx: ScopeContext, r: Resolver): void {
  if (EXPRESSION_PATTERN.test(value)) {
    EXPRESSION_PATTERN.lastIndex = 0;
    return;
  }
  EXPRESSION_PATTERN.lastIndex = 0;
  checkExpression(value.trim(), ctx, r);
}

function checkExpression(source: string, ctx: ScopeContext, r: Resolver): void {
  const { references, functions, parseError } = extractReferences(source);
  if (parseError) return; // flat collector owns EXPR_PARSE

  for (const ref of references) {
    checkReference(ref, ctx, r);
  }

  if (ctx.isCmd) {
    checkCmdScalar(source, references, functions, ctx, r);
  } else if (ctx.rawTemplate) {
    checkStructuredTemplate(source, references, functions, ctx, r);
  }
}

function checkReference(ref: ExpressionReference, ctx: ScopeContext, r: Resolver): void {
  // Out-of-scope local root (loop/item/...) used where it is not bound.
  if (SCOPED_LOCAL_ROOTS.has(ref.root) && !ctx.locals.has(ref.root)) {
    r.diagnostics.error(
      "EXPR_ROOT_OUT_OF_SCOPE",
      `Expression root '${ref.root}' is only available inside its ${ref.root === "loop" ? "loop" : "fanout"} body; it is not in scope here.${describeScope(ctx)}`,
      ctx.path
    );
    return;
  }

  // TODO: Delete after users have migrated. Transitional guard for pre-primary-output loop.last syntax. 
  if (ref.root === "loop" && isLoopLastEnvelopeReference(ref)) {
    r.diagnostics.error(
      "EXPR_LOOP_LAST_ENVELOPE",
      "loop.last is already the previous body primary output; use loop.last.<field>, not loop.last.output.<field>.",
      ctx.path
    );
    return;
  }

  if (ref.root === "steps") {
    checkStepReference(ref, ctx, r);
    return;
  }

  if (ref.root === "input") {
    const result = walkInputSchema(r.inputSchema, ref.segments);
    if (result.error) {
      r.diagnostics.error(
        "EXPR_UNKNOWN_FIELD",
        `Expression '${referenceToString(ref)}' references field '${result.error.field}' not declared on input. Available fields: ${result.error.available.join(", ") || "(none)"}.`,
        ctx.path
      );
    }
  }

  if (ref.root === "workflow") {
    const result = walkSchema(WORKFLOW_CONTEXT_SCHEMA, ref.segments, 0);
    if (result.error) {
      r.diagnostics.error(
        "EXPR_UNKNOWN_FIELD",
        `Expression '${referenceToString(ref)}' references field '${result.error.field}' not declared on workflow. Available fields: ${result.error.available.join(", ") || "(none)"}.`,
        ctx.path
      );
    }
  }

  if (ref.root === "item" && ctx.itemSchema) {
    const result = walkSchema(ctx.itemSchema, ref.segments, 0);
    if (result.error) {
      r.diagnostics.error(
        "EXPR_UNKNOWN_FIELD",
        `Expression '${referenceToString(ref)}' references field '${result.error.field}' not declared on the fanout item. Available fields: ${result.error.available.join(", ") || "(none)"}.`,
        ctx.path
      );
    }
  }
}

function isLoopLastEnvelopeReference(ref: ExpressionReference): boolean {
  return ref.segments[0]?.kind === "field" &&
    ref.segments[0].name === "last" &&
    ref.segments[1]?.kind === "field" &&
    ref.segments[1].name === "output";
}

function checkStepReference(ref: ExpressionReference, ctx: ScopeContext, r: Resolver): void {
  const first = ref.segments[0];
  if (!first || first.kind !== "field") return; // steps[expr] — dynamic, skip

  const stepId = first.name;
  if (!r.allStepIds.has(stepId)) return; // genuinely unknown — flat collector owns EXPR_UNKNOWN_STEP

  if (!ctx.visibleSteps.has(stepId)) {
    const visible = [...ctx.visibleSteps].sort();
    r.diagnostics.error(
      "EXPR_UNKNOWN_STEP",
      `Expression references step '${stepId}' which is not visible at this position (it runs later or in a separate branch). Visible steps: ${visible.join(", ") || "(none)"}.`,
      ctx.path
    );
    return;
  }

  resolveStepType(ref, r, ctx); // resolve for field-path errors (side-effecting diagnostics)
}

/**
 * Resolve a `steps.<id>...` reference, emitting EXPR_UNKNOWN_FIELD on a closed
 * schema miss. Returns the resolved kind for the shell-safety check.
 */
function resolveStepType(ref: ExpressionReference, r: Resolver, ctx?: ScopeContext): ResolvedKind {
  const first = ref.segments[0];
  if (!first || first.kind !== "field") return "unknown"; // bare `steps` or `steps[expr]`
  const node = r.globalNodes.get(first.name);
  if (!node) return "unknown";

  const seg1 = ref.segments[1];
  if (!seg1) return "unknown"; // bare `steps.x` — envelope object, treat dyn
  if (seg1.kind !== "field") return "unknown";

  if (seg1.name === "exit_code") return "scalar";
  if (seg1.name !== "output") {
    const available = node.kind === "run.program" ? "output, exit_code" : "output";
    if (ctx) {
      r.diagnostics.error(
        "EXPR_UNKNOWN_FIELD",
        `Expression '${referenceToString(ref)}' accesses '${seg1.name}' on step '${node.id}'; step outputs are read via .output (available: ${available}).`,
        ctx.path
      );
    }
    return "unknown";
  }

  // seg1 === "output": project per the node's output shape.
  const shape = COMPOSITE_CONTRACTS[node.kind].outputShape;
  if (ref.segments.length === 2) {
    switch (shape) {
      case "array":
        return "array";
      case "map":
      case "decision":
      case "selected":
        return "object";
      default:
        break;
    }
  }
  if (shape !== "schema" && shape !== "payload") return "unknown"; // composite/dyn projection

  const schema = node.metadata.output;
  if (!isRecord(schema)) return "unknown"; // no declared schema → dyn

  const result = walkSchema(schema, ref.segments, 2);
  if (result.error && ctx) {
    r.diagnostics.error(
      "EXPR_UNKNOWN_FIELD",
      `Expression '${referenceToString(ref)}' references field '${result.error.field}' not declared on step '${node.id}' output. Available fields: ${result.error.available.join(", ") || "(none)"}.`,
      ctx.path
    );
  }
  return result.kind;
}

/** CEL functions whose result is a scalar, so their value is shell-safe even
 *  when an argument is an object/array. `json` is excluded: it serializes a
 *  whole structure into the command text, which is exactly what we warn about. */
const SCALAR_RETURNING_FUNCTIONS = new Set(["len", "startsWith", "matches", "size", "now"]);

/** Shell-safety: flag a non-scalar ${{ }} spliced into a cmd element. */
function checkCmdScalar(
  source: string,
  references: ExpressionReference[],
  functions: string[],
  ctx: ScopeContext,
  r: Resolver
): void {
  let nonScalar = false;
  let label = source.trim();

  // A scalar-returning function wrapping the value makes the spliced result a
  // scalar regardless of its argument shapes (e.g. len(steps.x.output.items)).
  if (functions.some((fn) => SCALAR_RETURNING_FUNCTIONS.has(fn))) {
    return;
  }

  if (functions.includes("json")) {
    nonScalar = true;
  } else if (references.length === 1 && isStaticReference(references[0]!)) {
    const ref = references[0]!;
    const kind = resolveReferenceKind(ref, r, ctx);
    if (kind === "object" || kind === "array") {
      nonScalar = true;
      label = referenceToString(ref);
    }
  }

  if (nonScalar) {
    r.diagnostics.warning(
      "EXPR_NONSCALAR_IN_CMD",
      `Expression '${label}' evaluates to a non-scalar value spliced into a command; shell metacharacters will break it. Pass it through env: and read it with $VAR / os.environ instead.`,
      ctx.path
    );
  }
}

function checkStructuredTemplate(
  source: string,
  references: ExpressionReference[],
  functions: string[],
  ctx: ScopeContext,
  r: Resolver
): void {
  if (functions.includes("json")) return;
  if (references.length !== 1 || !isStaticReference(references[0]!)) return;

  const ref = references[0]!;
  const kind = resolveReferenceKind(ref, r, ctx);
  if (kind !== "object" && kind !== "array") return;

  r.diagnostics.warning(
    "EXPR_STRUCTURED_TEMPLATE",
    `Expression '${referenceToString(ref)}' evaluates to a structured value in a template string; wrap it with json(...) when JSON text is intended.`,
    ctx.path
  );
}

function resolveReferenceKind(ref: ExpressionReference, r: Resolver, ctx?: ScopeContext): ResolvedKind {
  switch (ref.root) {
    case "steps":
      return resolveStepType(ref, r);
    case "input":
      return walkInputSchema(r.inputSchema, ref.segments).kind;
    case "workflow":
      return walkSchema(WORKFLOW_CONTEXT_SCHEMA, ref.segments, 0).kind;
    case "item":
      return ctx?.itemSchema ? walkSchema(ctx.itemSchema, ref.segments, 0).kind : "unknown";
    default:
      return "unknown";
  }
}

function walkInputSchema(schema: Record<string, unknown>, segments: ExpressionReference["segments"]): SchemaWalkResult {
  return walkSchema(schema, segments, 0, { allowOpenRootFields: true });
}

interface SchemaWalkResult {
  kind: ResolvedKind;
  error?: { field: string; available: string[] };
}

/** Walk JSON-Schema segments from `start`. Stops (kind=unknown) on any open/dyn shape. */
function walkSchema(
  schema: Record<string, unknown>,
  segments: ExpressionReference["segments"],
  start: number,
  options: { allowOpenRootFields?: boolean } = {}
): SchemaWalkResult {
  let cur: Record<string, unknown> = schema;
  for (let i = start; i < segments.length; i++) {
    const seg = segments[i]!;
    if (seg.kind === "index") {
      if (cur.type === "array" && isRecord(cur.items)) {
        cur = cur.items;
        continue;
      }
      return { kind: "unknown" };
    }
    // field segment
    if (isClosedObject(cur) || (options.allowOpenRootFields === true && i === start && isRecord(cur.properties))) {
      const properties = cur.properties as Record<string, unknown>;
      if (Object.prototype.hasOwnProperty.call(properties, seg.name)) {
        cur = properties[seg.name] as Record<string, unknown>;
        continue;
      }
      if (!isClosedObject(cur)) return { kind: "unknown" };
      return { kind: "unknown", error: { field: seg.name, available: Object.keys(properties) } };
    }
    // open object / scalar / dyn — cannot validate this access
    return { kind: "unknown" };
  }
  return { kind: schemaKind(cur) };
}

function isClosedObject(schema: Record<string, unknown>): boolean {
  return schema.type === "object" && isRecord(schema.properties) && schema.additionalProperties === false;
}

function schemaKind(schema: Record<string, unknown>): ResolvedKind {
  switch (schema.type) {
    case "object":
      return "object";
    case "array":
      return "array";
    case "string":
    case "integer":
    case "number":
    case "boolean":
      return "scalar";
    default:
      return "unknown";
  }
}

const WORKFLOW_CONTEXT_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {
    name: { type: "string" },
    description: { type: "string" },
    source_path: { type: "string" },
    source_dir: { type: "string" }
  }
};

function describeScope(ctx: ScopeContext): string {
  const locals = [...ctx.locals].sort();
  return locals.length > 0 ? ` In-scope locals: ${locals.join(", ")}.` : "";
}

function indexNodes(node: IrNode, out: Map<string, IrNode>): void {
  if (node.id) out.set(node.id, node);
  for (const child of node.children ?? []) indexNodes(child, out);
  for (const branch of node.branches ?? []) {
    indexNodes(branch.child, out);
  }
}

function unionLocals(stack: string[][]): Set<string> {
  const out = new Set<string>();
  for (const frame of stack) for (const local of frame) out.add(local);
  return out;
}

/** Visit every string leaf in a nested structure, yielding (value, jsonPath). */
function visitStrings(value: unknown, path: string, visit: (source: string, path: string) => void): void {
  if (typeof value === "string") {
    visit(value, path);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => visitStrings(item, `${path}[${index}]`, visit));
    return;
  }
  if (isRecord(value)) {
    for (const [key, child] of Object.entries(value)) visitStrings(child, `${path}.${key}`, visit);
  }
}
