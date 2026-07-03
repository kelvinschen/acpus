import { assertType, test } from "vitest";
import {
  coalesce,
  every,
  filter,
  get,
  head,
  ifElse,
  map,
  md,
  pick,
  some,
  where,
  type Expr,
  type OutputAccessor,
  type WorkflowValue,
} from "@acpus/expression";
import { refExpr } from "@acpus/expression/ir";
// @ts-expect-error expr is exported from @acpus/expression/ir, not the root.
import { expr as rootExpr } from "@acpus/expression";
// @ts-expect-error refExpr is exported from @acpus/expression/ir, not the root.
import { refExpr as rootRefExpr } from "@acpus/expression";
// @ts-expect-error valueToExprIR is exported from @acpus/expression/ir, not the root.
import { valueToExprIR as rootValueToExprIR } from "@acpus/expression";
// @ts-expect-error all was removed; use every.
import { all as rootAll } from "@acpus/expression";
// @ts-expect-error any was removed; use some.
import { any as rootAny } from "@acpus/expression";
// @ts-expect-error fallback was removed; use coalesce.
import { fallback as rootFallback } from "@acpus/expression";

void rootExpr;
void rootRefExpr;
void rootValueToExprIR;
void rootAll;
void rootAny;
void rootFallback;

type Item = {
  done: boolean;
  score: number;
  name: string;
};

const items = refExpr<readonly Item[]>(["input", "items"]);
const maybeName = refExpr<string | null>(["input", "name"]);
const maybeUser = refExpr<{ deletedAt: string | null; tags: readonly string[] }>(["input", "user"]);

test("authoring helpers infer core expression shapes", () => {
  assertType<WorkflowValue<string>>("literal");
  assertType<OutputAccessor<readonly Item[]>>(items);
  assertType<Expr<boolean>>(every(items, () => true));
  assertType<Expr<boolean>>(some(items, () => false));
  assertType<Expr<readonly Item[]>>(filter(items, () => true));
  assertType<Expr<readonly string[]>>(map(items, () => "name"));
  assertType<Expr<Item | undefined>>(head(items));
  assertType<Expr<Item | undefined>>(get(items, 0));
  assertType<Expr<string>>(coalesce(maybeName, "unknown"));
  assertType<Expr<string>>(md`hello ${maybeName}`);
  assertType<Expr<string | number>>(ifElse(refExpr<boolean>(["input", "ok"]), "ok", 1));
  assertType<Expr<boolean>>(where(head(items), { done: true }));
  assertType<Expr<boolean>>(where(maybeName, null));
  assertType<Expr<boolean>>(where(maybeUser, { deletedAt: null, tags: { eq: ["ready"] } }));
  assertType<OutputAccessor<string | undefined>>(pick(head(items), ["name"]).name);
});

test("authoring helpers reject unknown values where static typing can prove it", () => {
  // @ts-expect-error coalesce requires at least one value.
  coalesce();
  // @ts-expect-error every callbacks must produce booleans.
  every(items, () => "done");
  // @ts-expect-error dynamic array get uses numeric keys.
  get(items, "0");
  // @ts-expect-error where rejects unknown typed object keys.
  where(head(items), { missing: true });
  // @ts-expect-error where object sugar reserves operator keys; use eq(user.eq, value) instead.
  where(refExpr<{ eq: string }>(["input", "user"]), { eq: "x" });
  // @ts-expect-error dynamic string get is for records, not plain object refs.
  get(refExpr<{ name: string }>(["input", "user"]), "name");
  // @ts-expect-error pick is accessor projection sugar, not object literal projection.
  pick({ name: "Ada" }, ["name"]);
  assertType<OutputAccessor<string>>(pick(refExpr<{ ir: string }>(["input", "user"]), ["ir"]).ir);
  assertType<OutputAccessor<string>>(refExpr<{ ir: string }>(["input", "user"]).ir);
  assertType<Expr<boolean>>(where(refExpr<{ ir: string }>(["input", "user"]), { ir: "ok" }));
  // @ts-expect-error pick cannot project reserved expression token internals.
  pick(refExpr<{ __ir: string }>(["input", "user"]), ["__ir"]);
  // @ts-expect-error where cannot filter reserved expression token internals.
  where(refExpr<{ __ir: string }>(["input", "user"]), { __ir: "ok" });
  // @ts-expect-error accessor token property .__ir is reserved for expression IR inspection.
  assertType<Expr<string>>(refExpr<{ __ir: string }>(["input", "user"]).__ir);
});
