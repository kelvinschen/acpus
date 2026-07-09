export type OperatorSpec = {
  arity: readonly number[];
  callback?: {
    callbackSourceArg: number;
    callbackParamCount: number;
    dependencyArgs: readonly number[];
  };
};

export type ExpressionOperatorName = "fmap" | "lift2" | "lift3" | "lift" | "access";
export type ExpressionCallbackOperatorName = "fmap" | "lift2" | "lift3" | "lift";

export const EXPRESSION_OPERATORS: Record<ExpressionOperatorName, OperatorSpec> = {
  fmap: { arity: [2], callback: { callbackSourceArg: 1, callbackParamCount: 1, dependencyArgs: [0] } },
  lift2: { arity: [3], callback: { callbackSourceArg: 2, callbackParamCount: 2, dependencyArgs: [0, 1] } },
  lift3: { arity: [4], callback: { callbackSourceArg: 3, callbackParamCount: 3, dependencyArgs: [0, 1, 2] } },
  lift: { arity: [2], callback: { callbackSourceArg: 1, callbackParamCount: 1, dependencyArgs: [0] } },
  access: { arity: [2] },
};

const EXPRESSION_CALLBACK_OPERATOR_NAMES: ExpressionCallbackOperatorName[] = ["fmap", "lift2", "lift3", "lift"];

export function expressionOperatorSpec(fn: string): OperatorSpec | undefined {
  return isExpressionOperatorName(fn) ? EXPRESSION_OPERATORS[fn] : undefined;
}

export function expressionCallbackOperatorNames(): ExpressionCallbackOperatorName[] {
  return [...EXPRESSION_CALLBACK_OPERATOR_NAMES];
}

function isExpressionOperatorName(fn: string): fn is ExpressionOperatorName {
  return Object.prototype.hasOwnProperty.call(EXPRESSION_OPERATORS, fn);
}
