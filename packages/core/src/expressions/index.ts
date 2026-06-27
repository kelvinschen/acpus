export { expr, isExpr, valueToExprIR } from "./expr.js";
export type { Expr, WorkflowValue } from "./expr.js";
export {
  literal,
  not,
  and,
  or,
  eq,
  ne,
  lt,
  lte,
  gt,
  gte,
  len,
  contains,
  startsWith,
  endsWith,
  matches,
  coalesce,
  all,
  any,
  max,
  min,
} from "./operators.js";
export { where } from "./where.js";
export type { Where, ObjectWhere, NumberWhere, StringWhere, BooleanWhere, ArrayWhere } from "./where.js";
import * as operators from "./operators.js";
import { where } from "./where.js";

export const exprOps = {
  ...operators,
  where,
};
