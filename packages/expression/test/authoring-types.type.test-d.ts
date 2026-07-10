import { assertType, test } from "vitest";
import {
  and,
  eq,
  fmap,
  gt,
  gte,
  lift,
  lift2,
  lift3,
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

const items = refExpr<readonly Item[]>(["input", "items"]);
const count = refExpr<number>(["input", "count"]);
const ready = refExpr<boolean>(["input", "ready"]);
const kind = refExpr<string>(["input", "kind"]);
const maxItems = refExpr<number>(["input", "maxItems"]);

test("authoring helpers infer expression shapes", () => {
  assertType<WorkflowData>({ ok: true, values: [1, "two", null] });
  assertType<Resolvable<string>>("literal");
  assertType<ExprValue<readonly Item[]>>(items);
  assertType<Expr<string>>(md`hello ${kind}`);

  assertType<ExprValue<number>>(fmap(count, value => value + 1));
  assertType<ExprValue<number>>(fmap(items, values => values.length));
  assertType<ExprValue<readonly string[]>>(fmap(items, values => values.map(item => item.name)));
  assertType<ExprValue<readonly Item[]>>(fmap(items, values => values.filter(item => item.done)));

  assertType<ExprValue<boolean>>(lift2(ready, kind, (ready, kind) => ready && kind === "release"));
  assertType<ExprValue<boolean>>(lift3(ready, kind, maxItems, (ready, kind, maxItems) => ready && kind === "release" && maxItems > 0));
  assertType<ExprValue<boolean>>(lift({ ready, kind, maxItems }, ({ ready, kind, maxItems }) => ready && kind === "release" && maxItems > 0));
  assertType<ExprValue<boolean>>(eq(kind, "release"));
  assertType<ExprValue<boolean>>(ne("draft", kind));
  assertType<ExprValue<boolean>>(lt(count, maxItems));
  assertType<ExprValue<boolean>>(lte(count, 5));
  assertType<ExprValue<boolean>>(gt(maxItems, count));
  assertType<ExprValue<boolean>>(gte(maxItems, 1));
  assertType<ExprValue<boolean>>(not(ready));
  assertType<ExprValue<boolean>>(and(ready, eq(kind, "release"), true));
  assertType<ExprValue<boolean>>(or(ready, false));

  const transformedIssue = fmap(refExpr<{ title: string; labels: readonly string[] }>(["input", "issue"]), issue => ({
    title: issue.title.trim(),
    urgent: issue.labels.includes("urgent"),
    meta: { labels: issue.labels },
  }));
  assertType<ExprValue<{ title: string; urgent: boolean; meta: { labels: readonly string[] } }>>(transformedIssue);
  assertType<ExprValue<string>>(transformedIssue.title);
  assertType<ExprValue<readonly string[]>>(transformedIssue.meta.labels);
  assertType<ExprValue<string | undefined>>(transformedIssue.meta.labels[0]!);
  assertType<ExprValue<string>>(fmap(transformedIssue.meta.labels[0]!, label => label ?? "fallback"));
});

test("authoring helpers reject unsupported shapes where static typing can prove it", () => {
  fmap(refExpr<{ title: string }>(["input", "issue"]), issue => {
    // @ts-expect-error fmap callback parameter is inferred from the input value.
    return issue.missing;
  });
  // @ts-expect-error async callbacks return Promise, not WorkflowData.
  fmap(count, async value => value + 1);
  // @ts-expect-error Date objects are not WorkflowData.
  fmap(count, () => new Date());
  // @ts-expect-error undefined is not WorkflowData.
  fmap(count, () => undefined);
  // @ts-expect-error raw undefined is not a resolvable input.
  fmap(undefined, value => value);
  // @ts-expect-error lift takes a named dependency object, not tuple deps.
  lift([ready, kind], ([ready, kind]) => ready && kind === "release");
  // @ts-expect-error lift does not support variadic dependencies.
  lift(ready, kind, (ready: boolean, kind: string) => ready && kind === "release");
  // @ts-expect-error comparisons only accept number values.
  gte(kind, "release");
  // @ts-expect-error scalar equality does not accept arrays or objects.
  eq(items, items);
  // @ts-expect-error and requires at least two operands.
  and(ready);
  // @ts-expect-error or requires at least two operands.
  or(false);
});
