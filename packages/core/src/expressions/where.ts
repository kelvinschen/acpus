import type { OutputAccessor } from "../graph/refs.js";
import { isExpr, type Expr, type WorkflowValue } from "./expr.js";
import {
  and,
  endsWith,
  eq,
  gt,
  gte,
  includes,
  len,
  literal,
  lt,
  lte,
  matches,
  ne,
  not,
  or,
  startsWith,
} from "./operators.js";

export type NumberWhere = WorkflowValue<number> | {
  eq?: WorkflowValue<number>;
  ne?: WorkflowValue<number>;
  lt?: WorkflowValue<number>;
  lte?: WorkflowValue<number>;
  gt?: WorkflowValue<number>;
  gte?: WorkflowValue<number>;
  in?: WorkflowValue<readonly number[]>;
  notIn?: WorkflowValue<readonly number[]>;
  $eq?: WorkflowValue<number>;
  $ne?: WorkflowValue<number>;
  $lt?: WorkflowValue<number>;
  $lte?: WorkflowValue<number>;
  $gt?: WorkflowValue<number>;
  $gte?: WorkflowValue<number>;
  $in?: WorkflowValue<readonly number[]>;
  $nin?: WorkflowValue<readonly number[]>;
};

export type StringWhere = WorkflowValue<string> | {
  eq?: WorkflowValue<string>;
  ne?: WorkflowValue<string>;
  contains?: WorkflowValue<string>;
  startsWith?: WorkflowValue<string>;
  endsWith?: WorkflowValue<string>;
  matches?: WorkflowValue<string>;
  in?: WorkflowValue<readonly string[]>;
  notIn?: WorkflowValue<readonly string[]>;
  $eq?: WorkflowValue<string>;
  $ne?: WorkflowValue<string>;
  $regex?: WorkflowValue<string>;
  $in?: WorkflowValue<readonly string[]>;
  $nin?: WorkflowValue<readonly string[]>;
};

export type BooleanWhere = WorkflowValue<boolean> | {
  eq?: WorkflowValue<boolean>;
  ne?: WorkflowValue<boolean>;
  $eq?: WorkflowValue<boolean>;
  $ne?: WorkflowValue<boolean>;
};

export type ArrayWhere<Item> = {
  isEmpty?: boolean;
  length?: NumberWhere;
  contains?: WorkflowValue<Item>;
};

export type Where<T> = T extends string
  ? StringWhere
  : T extends number
    ? NumberWhere
    : T extends boolean
      ? BooleanWhere
      : T extends readonly (infer Item)[]
        ? ArrayWhere<Item>
        : T extends object
          ? ObjectWhere<T>
          : never;

export type ObjectWhere<T> = {
  [K in keyof T]?: Where<T[K]>;
} & {
  AND?: ObjectWhere<T>[];
  OR?: ObjectWhere<T>[];
  NOT?: ObjectWhere<T>;
  $and?: ObjectWhere<T>[];
  $or?: ObjectWhere<T>[];
  $not?: ObjectWhere<T>;
};

export function where<T>(target: OutputAccessor<T>, filter: Where<T>): Expr<boolean>;
export function where<T>(target: Expr<T>, filter: Where<T>): Expr<boolean>;
export function where(target: any, filter: any): Expr<boolean> {
  return lowerWhere(target, filter);
}

function lowerWhere(target: any, filter: any): Expr<boolean> {
  if (isExpr(filter)) return eq(target, filter);
  if (typeof filter === "boolean" || typeof filter === "string" || typeof filter === "number" || filter === null) return eq(target, filter as any);
  if (!filter || typeof filter !== "object" || Array.isArray(filter)) return eq(target, filter);
  if (isOperatorObject(filter)) return lowerOperator(target, filter);

  const clauses: WorkflowValue<boolean>[] = [];
  const entries = Object.entries(filter) as Array<[string, any]>;
  for (const [key, value] of entries) {
    if (key === "AND" || key === "$and") clauses.push(and(...value.map((v: any) => lowerWhere(target, v))));
    else if (key === "OR" || key === "$or") clauses.push(or(...value.map((v: any) => lowerWhere(target, v))));
    else if (key === "NOT" || key === "$not") clauses.push(not(lowerWhere(target, value)));
    else if (isOperatorObject(value)) clauses.push(lowerOperator(target[key], value));
    else clauses.push(lowerWhere(target[key], value));
  }
  if (clauses.length === 0) return literal(true);
  return clauses.length === 1 ? clauses[0] as Expr<boolean> : and(...clauses);
}

function isOperatorObject(value: any): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.keys(value).some(k => OPERATOR_KEYS.has(k));
}

const OPERATOR_ALIASES: Record<string, string> = {
  $eq: "eq",
  $ne: "ne",
  $lt: "lt",
  $lte: "lte",
  $gt: "gt",
  $gte: "gte",
  $in: "in",
  $nin: "notIn",
  $regex: "matches",
};
const OPERATOR_KEYS = new Set(["eq", "ne", "lt", "lte", "gt", "gte", "in", "notIn", "contains", "startsWith", "endsWith", "matches", "length", "isEmpty", ...Object.keys(OPERATOR_ALIASES)]);

function lowerOperator(target: any, spec: Record<string, any>): Expr<boolean> {
  const clauses: WorkflowValue<boolean>[] = [];
  for (const [rawOp, value] of Object.entries(spec)) {
    const op = OPERATOR_ALIASES[rawOp] ?? rawOp;
    switch (op) {
      case "eq": clauses.push(eq(target, value)); break;
      case "ne": clauses.push(ne(target, value)); break;
      case "lt": clauses.push(lt(target, value)); break;
      case "lte": clauses.push(lte(target, value)); break;
      case "gt": clauses.push(gt(target, value)); break;
      case "gte": clauses.push(gte(target, value)); break;
      case "in": clauses.push(includes(value, target)); break;
      case "notIn": clauses.push(not(includes(value, target))); break;
      case "contains": clauses.push(includes(target, value)); break;
      case "startsWith": clauses.push(startsWith(target, value)); break;
      case "endsWith": clauses.push(endsWith(target, value)); break;
      case "matches": clauses.push(matches(target, value)); break;
      case "length": clauses.push(lowerWhere(len(target), value)); break;
      case "isEmpty": clauses.push(value ? eq(len(target), 0) : gt(len(target), 0)); break;
      default: throw new Error(`Unsupported where operator: ${rawOp}`);
    }
  }
  return clauses.length === 0 ? literal(true) : clauses.length === 1 ? clauses[0] as Expr<boolean> : and(...clauses);
}
