export type OperatorSpec = {
  arity: readonly number[];
  callback?: true;
};

export type ExpressionCallbackLayout = {
  callbackSourceArg: number;
  callbackParamCount: number;
  dependencyArgs: readonly number[];
};

export type ExpressionOperatorName = "lift" | "access";
export type ExpressionCallbackOperatorName = "lift";

export const EXPRESSION_OPERATORS: Record<ExpressionOperatorName, OperatorSpec> = {
  lift: { arity: [2, 3, 4], callback: true },
  access: { arity: [2] },
};

const EXPRESSION_CALLBACK_OPERATOR_NAMES: ExpressionCallbackOperatorName[] = ["lift"];

export function expressionOperatorSpec(fn: string): OperatorSpec | undefined {
  return isExpressionOperatorName(fn) ? EXPRESSION_OPERATORS[fn] : undefined;
}

export function expressionCallbackOperatorNames(): ExpressionCallbackOperatorName[] {
  return [...EXPRESSION_CALLBACK_OPERATOR_NAMES];
}

export function expressionCallbackLayout(fn: string, argCount: number): ExpressionCallbackLayout | undefined {
  const spec = expressionOperatorSpec(fn);
  if (!spec?.callback || !spec.arity.includes(argCount)) return undefined;
  const callbackSourceArg = argCount - 1;
  return {
    callbackSourceArg,
    callbackParamCount: callbackSourceArg,
    dependencyArgs: Array.from({ length: callbackSourceArg }, (_, index) => index),
  };
}

function isExpressionOperatorName(fn: string): fn is ExpressionOperatorName {
  return Object.prototype.hasOwnProperty.call(EXPRESSION_OPERATORS, fn);
}
