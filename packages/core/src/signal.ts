import { SIGNAL_RUN } from "./internal.js";
import { templateToIR, type Template } from "./template.js";
import type { SignalRunIR } from "./ir.js";

export type SignalRunSpec = {
  prompt: Template | string | ((input: any) => Template | string);
};

export type SignalRun = {
  readonly [SIGNAL_RUN]: true;
  readonly spec: SignalRunSpec;
  toIR(input: Record<string, unknown>): SignalRunIR;
};

export type SignalFactory = {
  (spec: SignalRunSpec): SignalRun;
  isRun(value: unknown): value is SignalRun;
};

export const signal: SignalFactory = Object.assign(
  (spec: SignalRunSpec): SignalRun => ({
    [SIGNAL_RUN]: true as const,
    spec,
    toIR(input: Record<string, unknown>) {
      const prompt = typeof spec.prompt === "function" ? spec.prompt(input) : spec.prompt;
      return { kind: "signal_run", prompt: templateToIR(prompt) };
    },
  }),
  {
    isRun(value: unknown): value is SignalRun {
      return Boolean(value && typeof value === "object" && (value as any)[SIGNAL_RUN]);
    },
  },
);
