import type { IrNode } from "@acpus/core";
import type { ExpressionContext, ExecutorResult } from "../types.js";
import type { ExecutorAdapter } from "./types.js";
import { ExpressionEvaluator } from "../evaluator.js";
import { Ajv } from "ajv";

/**
 * Mock agent executor for testing. Takes a step-id → response map,
 * resolves prompt template, returns mock output, validates against
 * schema (Ajv), and respects AbortSignal (returns partial result).
 */
export class MockAgentExecutor implements ExecutorAdapter {
  private readonly responses: Map<string, MockAgentResponse>;
  private readonly evaluator: ExpressionEvaluator;
  private readonly ajv: Ajv;

  constructor(responses: Record<string, MockAgentResponse>, evaluator?: ExpressionEvaluator) {
    this.responses = new Map(Object.entries(responses));
    this.evaluator = evaluator ?? new ExpressionEvaluator();
    this.ajv = new Ajv({ allErrors: true, strict: false });
  }

  async execute(node: IrNode, context: ExpressionContext, signal: AbortSignal): Promise<ExecutorResult> {
    const stepId = node.id;
    const response = this.responses.get(stepId);
    if (!response) {
      return { error: `No mock response configured for step '${stepId}'` };
    }

    // Resolve prompt template
    const promptTemplate = node.metadata.prompt as string | undefined;
    if (promptTemplate) {
      this.evaluator.evaluateTemplate(promptTemplate, context);
    }

    // Check for abort before starting
    if (signal.aborted) {
      return { partial: true, error: "Aborted before execution" };
    }

    // Simulate abort listener
    let aborted = false;
    const onAbort = (): void => { aborted = true; };
    signal.addEventListener("abort", onAbort, { once: true });

    try {
      // Simulate async work
      await new Promise((resolve) => setTimeout(resolve, response.delay ?? 10));

      if (aborted || signal.aborted) {
        return { partial: true, error: "Aborted during execution" };
      }

      // Validate output against schema if provided
      const output = response.output;
      const schema = node.metadata.output as Record<string, unknown> | undefined;
      if (schema && output !== undefined) {
        const validate = this.ajv.compile(schema);
        if (!validate(output)) {
          return { error: `Output validation failed: ${this.ajv.errorsText(validate.errors)}` };
        }
      }

      return { output };
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }
}

export interface MockAgentResponse {
  output?: unknown;
  error?: string;
  delay?: number;
}
