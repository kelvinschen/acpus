export type OperatorSpec = {
  arity: number[] | { min: number };
  lambdaArgs: ReadonlySet<number>;
};

export const EXPRESSION_OPERATORS: Record<string, OperatorSpec> = {
  not: { arity: [1], lambdaArgs: new Set() },
  and: { arity: { min: 0 }, lambdaArgs: new Set() },
  or: { arity: { min: 0 }, lambdaArgs: new Set() },
  ifElse: { arity: [3], lambdaArgs: new Set() },
  eq: { arity: [2], lambdaArgs: new Set() },
  ne: { arity: [2], lambdaArgs: new Set() },
  lt: { arity: [2], lambdaArgs: new Set() },
  lte: { arity: [2], lambdaArgs: new Set() },
  gt: { arity: [2], lambdaArgs: new Set() },
  gte: { arity: [2], lambdaArgs: new Set() },
  len: { arity: [1], lambdaArgs: new Set() },
  includes: { arity: [2], lambdaArgs: new Set() },
  startsWith: { arity: [2], lambdaArgs: new Set() },
  endsWith: { arity: [2], lambdaArgs: new Set() },
  matches: { arity: [2], lambdaArgs: new Set() },
  coalesce: { arity: { min: 1 }, lambdaArgs: new Set() },
  get: { arity: [2], lambdaArgs: new Set() },
  every: { arity: [1, 2], lambdaArgs: new Set([1]) },
  some: { arity: [1, 2], lambdaArgs: new Set([1]) },
  filter: { arity: [2], lambdaArgs: new Set([1]) },
  map: { arity: [2], lambdaArgs: new Set([1]) },
  max: { arity: [1], lambdaArgs: new Set() },
  min: { arity: [1], lambdaArgs: new Set() },
};

export const WHERE_OPERATOR_KEYS = ["eq", "ne", "lt", "lte", "gt", "gte", "contains", "startsWith", "endsWith", "matches", "length"] as const;
export type WhereOperatorKey = typeof WHERE_OPERATOR_KEYS[number];
export const WHERE_OPERATOR_KEY_SET: ReadonlySet<WhereOperatorKey> = new Set(WHERE_OPERATOR_KEYS);
