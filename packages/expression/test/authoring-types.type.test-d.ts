import { assertType, expectTypeOf, test } from "vitest";
import {
  and,
  eq,
  gt,
  gte,
  lift,
  lt,
  lte,
  md,
  ne,
  not,
  or,
  type Expr,
  type ExprValue,
  type WorkflowData,
  type Resolvable,
} from "@acpus/expression";
import { refExpr } from "@acpus/expression/ir";
// @ts-expect-error expr is exported from @acpus/expression/ir, not the root.
import { expr as rootExpr } from "@acpus/expression";
// @ts-expect-error refExpr is exported from @acpus/expression/ir, not the root.
import { refExpr as rootRefExpr } from "@acpus/expression";
// @ts-expect-error valueToExprIR is exported from @acpus/expression/ir, not the root.
import { valueToExprIR as rootValueToExprIR } from "@acpus/expression";
void rootExpr;
void rootRefExpr;
void rootValueToExprIR;

type Item = {
  done: boolean;
  score: number;
  name: string;
};
interface Payload {
  title: string;
  count: number;
}
interface NamedDependencies {
  ready: Expr<boolean>;
  nested: {
    kind: Expr<string>;
  };
}
interface OptionalPayload {
  title: string;
  note?: string;
}
interface LiftResult {
  title: string;
  nested: {
    count: number;
  };
  note?: string;
}
interface DeepInvalidLiftResult {
  a: { b: { c: { d: { e: { f: { g: { h: { i: { createdAt: Date } } } } } } } } };
}
declare const symbolKey: unique symbol;
interface SymbolKeyPayload {
  [symbolKey]: string;
}
type SymbolKeyAlias = {
  [symbolKey]: string;
};

const items = refExpr<readonly Item[]>(["input", "items"]);
const count = refExpr<number>(["input", "count"]);
const ready = refExpr<boolean>(["input", "ready"]);
const kind = refExpr<string>(["input", "kind"]);
const maxItems = refExpr<number>(["input", "maxItems"]);
const booleanDependencies: readonly Resolvable<boolean>[] = [ready, true];
const broadResolvable = ready as Resolvable;
declare const broadWorkflowData: WorkflowData;
const payload: Payload = { title: "Release", count: 1 };
const namedDependencies: NamedDependencies = { ready, nested: { kind } };
const optionalPayload: OptionalPayload = { title: "Release" };

function mapResolvable<T extends string | number>(dependency: Resolvable<T>): ExprValue<T> {
  return lift(dependency, value => {
    assertType<T>(value);
    assertType<typeof value>(null as unknown as T);
    return value;
  });
}

function mapWorkflowData<T extends WorkflowData>(dependency: Resolvable<T>): ExprValue<T> {
  return lift(dependency, value => value);
}

function mapInterfaceResolvable<T extends Payload>(dependency: Resolvable<T>): ExprValue<string> {
  return lift(dependency, value => value.title);
}

function mapTwoResolvables<A extends string | number, B extends string | number>(
  a: Resolvable<A>,
  b: Resolvable<B>,
): ExprValue<string> {
  return lift(a, b, (left, right) => `${left}:${right}`);
}

function mapThreeResolvables<A extends string | number, B extends string | number, C extends string | number>(
  a: Resolvable<A>,
  b: Resolvable<B>,
  c: Resolvable<C>,
): ExprValue<string> {
  return lift(a, b, c, (first, second, third) => `${first}:${second}:${third}`);
}

test("authoring helpers infer expression shapes", () => {
  assertType<WorkflowData>({ ok: true, values: [1, "two", null] });
  assertType<Resolvable<string>>("literal");
  assertType<ExprValue<readonly Item[]>>(items);
  assertType<Expr<string>>(md`hello ${kind}`);

  const unary = lift(count, value => {
    expectTypeOf(value).toEqualTypeOf<number>();
    return value + 1;
  });
  expectTypeOf(unary).toEqualTypeOf<ExprValue<number>>();
  assertType<ExprValue<WorkflowData>>(lift(broadResolvable, value => {
    expectTypeOf(value).toEqualTypeOf<WorkflowData | undefined>();
    return value ?? null;
  }));
  assertType<ExprValue<WorkflowData>>(lift(broadWorkflowData, value => {
    expectTypeOf(value).toEqualTypeOf<WorkflowData>();
    return value;
  }));
  const genericMapped = mapResolvable(kind);
  assertType<ExprValue<string>>(genericMapped);
  assertType<typeof genericMapped>(null as unknown as ExprValue<string>);
  void mapWorkflowData;
  assertType<ExprValue<string>>(mapInterfaceResolvable(payload));
  assertType<ExprValue<string>>(mapTwoResolvables(kind, count));
  assertType<ExprValue<string>>(mapThreeResolvables(kind, count, maxItems));
  assertType<ExprValue<string>>(lift(payload, value => {
    expectTypeOf(value).toEqualTypeOf<Readonly<Payload>>();
    return `${value.title}:${value.count}`;
  }));
  assertType<ExprValue<boolean>>(lift(namedDependencies, dependencies => {
    expectTypeOf(dependencies).toEqualTypeOf<Readonly<{ ready: boolean; nested: Readonly<{ kind: string }> }>>();
    return dependencies.ready && dependencies.nested.kind === "release";
  }));
  assertType<ExprValue<string>>(lift(optionalPayload, value => {
    expectTypeOf(value).toEqualTypeOf<Readonly<OptionalPayload>>();
    return value.note ?? value.title;
  }));
  assertType<ExprValue<number>>(lift(items, values => values.length));
  assertType<ExprValue<readonly string[]>>(lift(items, values => values.map(item => item.name)));
  assertType<ExprValue<readonly Item[]>>(lift(items, values => values.filter(item => item.done)));

  const binary = lift(ready, kind, (resolvedReady, resolvedKind) => {
    expectTypeOf(resolvedReady).toEqualTypeOf<boolean>();
    expectTypeOf(resolvedKind).toEqualTypeOf<string>();
    return resolvedReady && resolvedKind === "release";
  });
  expectTypeOf(binary).toEqualTypeOf<ExprValue<boolean>>();
  const ternary = lift(ready, kind, maxItems, (resolvedReady, resolvedKind, resolvedMaxItems) => {
    expectTypeOf(resolvedReady).toEqualTypeOf<boolean>();
    expectTypeOf(resolvedKind).toEqualTypeOf<string>();
    expectTypeOf(resolvedMaxItems).toEqualTypeOf<number>();
    return resolvedReady && resolvedKind === "release" && resolvedMaxItems > 0;
  });
  expectTypeOf(ternary).toEqualTypeOf<ExprValue<boolean>>();
  const interfaceUnary = lift(count, (value): LiftResult => ({
    title: String(value),
    nested: { count: value },
  }));
  expectTypeOf(interfaceUnary).toEqualTypeOf<ExprValue<LiftResult>>();
  const interfaceBinary = lift(kind, count, (title, value): LiftResult => ({
    title,
    nested: { count: value },
    note: "binary",
  }));
  expectTypeOf(interfaceBinary).toEqualTypeOf<ExprValue<LiftResult>>();
  const interfaceTernary = lift(kind, count, ready, (title, value, resolvedReady): LiftResult => ({
    title,
    nested: { count: value },
    ...(resolvedReady ? { note: "ready" } : {}),
  }));
  expectTypeOf(interfaceTernary).toEqualTypeOf<ExprValue<LiftResult>>();
  expectTypeOf(interfaceTernary.nested.count).toEqualTypeOf<Expr<number>>();
  const named = lift({ ready, kind, maxItems }, dependencies => {
    expectTypeOf(dependencies).toEqualTypeOf<Readonly<{ ready: boolean; kind: string; maxItems: number }>>();
    return dependencies.ready && dependencies.kind === "release" && dependencies.maxItems > 0;
  });
  expectTypeOf(named).toEqualTypeOf<ExprValue<boolean>>();
  assertType<ExprValue<boolean>>(lift(
    { release: { ready, kind }, limits: { current: count, maximum: maxItems } },
    ({ release, limits }) => release.ready && release.kind === "release" && limits.current <= limits.maximum,
  ));
  assertType<ExprValue<boolean>>(lift([ready, kind] as const, values => {
    expectTypeOf(values).toEqualTypeOf<readonly [boolean, string]>();
    return values[0] && values[1] === "release";
  }));
  assertType<ExprValue<boolean>>(lift(booleanDependencies, values => {
    expectTypeOf(values).toEqualTypeOf<readonly boolean[]>();
    return values.every(value => value);
  }));
  assertType<ExprValue<boolean>>(eq(kind, "release"));
  assertType<ExprValue<boolean>>(ne("draft", kind));
  assertType<ExprValue<boolean>>(lt(count, maxItems));
  assertType<ExprValue<boolean>>(lte(count, 5));
  assertType<ExprValue<boolean>>(gt(maxItems, count));
  assertType<ExprValue<boolean>>(gte(maxItems, 1));
  assertType<ExprValue<boolean>>(not(ready));
  assertType<ExprValue<boolean>>(and(ready, eq(kind, "release"), true));
  assertType<ExprValue<boolean>>(or(ready, false));

  const transformedIssue = lift(refExpr<{ title: string; labels: readonly string[] }>(["input", "issue"]), issue => ({
    title: issue.title.trim(),
    urgent: issue.labels.includes("urgent"),
    meta: { labels: issue.labels },
  }));
  assertType<ExprValue<{ title: string; urgent: boolean; meta: { labels: readonly string[] } }>>(transformedIssue);
  assertType<ExprValue<string>>(transformedIssue.title);
  assertType<ExprValue<readonly string[]>>(transformedIssue.meta.labels);
  assertType<ExprValue<string | undefined>>(transformedIssue.meta.labels[0]!);
  assertType<ExprValue<string>>(lift(transformedIssue.meta.labels[0]!, label => {
    expectTypeOf(label).toEqualTypeOf<string | undefined>();
    return label ?? "fallback";
  }));
});

test("authoring helpers reject unsupported shapes where static typing can prove it", () => {
  lift(refExpr<{ title: string }>(["input", "issue"]), issue => {
    // @ts-expect-error lift callback parameter is inferred from the dependency.
    const missing: string = issue.missing;
    return missing;
  });
  // @ts-expect-error async callbacks return Promise, not WorkflowData.
  lift(count, async value => value + 1);
  // @ts-expect-error Date objects are not WorkflowData.
  lift(count, () => new Date());
  // @ts-expect-error undefined is not WorkflowData.
  lift(count, () => undefined);
  // @ts-expect-error functions are not WorkflowData.
  lift(count, () => () => 1);
  const escapedAny = lift(count, (): any => 1);
  expectTypeOf(escapedAny).toEqualTypeOf<never>();
  // @ts-expect-error unknown callback results must be narrowed.
  lift(count, (): unknown => 1);
  // @ts-expect-error required fields cannot contain undefined.
  lift(count, (): { value: string | undefined } => ({ value: undefined }));
  // @ts-expect-error arrays cannot contain undefined.
  lift(count, (): Array<string | undefined> => ["ok", undefined]);
  // @ts-expect-error deeply nested non-durable values remain rejected.
  lift(count, (): DeepInvalidLiftResult => null as unknown as DeepInvalidLiftResult);
  // @ts-expect-error a durable union cannot hide a non-durable branch.
  lift(count, (): WorkflowData | Date => new Date());
  const symbolKeyPayload = null as unknown as SymbolKeyPayload;
  // @ts-expect-error symbol-keyed callback results cannot be lowered.
  lift(count, (): SymbolKeyPayload => symbolKeyPayload);
  // @ts-expect-error symbol-keyed type aliases cannot bypass the durable result check.
  lift(count, (): SymbolKeyAlias => symbolKeyPayload);
  const expressionResult = refExpr<string>(["input", "result"]);
  // @ts-expect-error lift callbacks return materialized data, not Expr tokens.
  lift(count, () => expressionResult);
  // @ts-expect-error broad object callback results are not known to be durable.
  lift(count, (): object => ({}));
  assertType<ExprValue<{}>>(lift(count, (): {} => ({})));
  // @ts-expect-error raw undefined is not a resolvable input.
  lift(undefined, value => value);
  // @ts-expect-error raw Date dependencies are not resolvable.
  lift(new Date(), value => value.toISOString());
  // @ts-expect-error raw function dependencies are not resolvable.
  lift(() => 1, value => value());
  // @ts-expect-error Promise dependencies are not resolvable.
  lift(Promise.resolve(1), value => value);
  // @ts-expect-error nested Date dependencies are not resolvable.
  lift({ releasedAt: new Date() }, value => value.releasedAt.toISOString());
  assertType<ExprValue<{}>>(lift({}, value => value));
  // @ts-expect-error positional lift supports at most three dependencies.
  lift(ready, kind, count, maxItems, () => true);
  // @ts-expect-error comparisons only accept number values.
  gte(kind, "release");
  // @ts-expect-error scalar equality does not accept arrays or objects.
  eq(items, items);
  // @ts-expect-error and requires at least two operands.
  and(ready);
  // @ts-expect-error or requires at least two operands.
  or(false);
});
