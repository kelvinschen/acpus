import type { IrNode } from "@acpus/core";
import type { ExpressionContext, ExecutorResult } from "../types.js";
import type { ExecutorAdapter } from "./types.js";
import { ExpressionEvaluator } from "../evaluator.js";

export interface MockProgramResponse {
  stdout?: string;
  exitCode?: number;
  parsedOutput?: unknown;
  delay?: number;
}

/**
 * Mock program executor for testing. Takes a step-id → {stdout, exitCode, parsedOutput} map,
 * resolves cmd template, handles capture config.
 */
export class MockProgramExecutor implements ExecutorAdapter {
  private readonly responses: Map<string, MockProgramResponse>;
  private readonly evaluator: ExpressionEvaluator;

  constructor(responses: Record<string, MockProgramResponse>, evaluator?: ExpressionEvaluator) {
    this.responses = new Map(Object.entries(responses));
    this.evaluator = evaluator ?? new ExpressionEvaluator();
  }

  async execute(node: IrNode, context: ExpressionContext, signal: AbortSignal): Promise<ExecutorResult> {
    const stepId = node.id;
    const response = this.responses.get(stepId);
    if (!response) {
      return { error: `No mock response configured for step '${stepId}'`, exitCode: 1 };
    }

    // Resolve cmd template
    const cmdTemplate = node.metadata.cmd as string | string[] | undefined;
    if (cmdTemplate) {
      if (Array.isArray(cmdTemplate)) {
        cmdTemplate.map((c) => this.evaluator.evaluateTemplate(c, context));
      } else {
        this.evaluator.evaluateTemplate(cmdTemplate, context);
      }
    }

    // Check for abort
    if (signal.aborted) {
      return { partial: true, error: "Aborted before execution" };
    }

    let aborted = false;
    const onAbort = (): void => { aborted = true; };
    signal.addEventListener("abort", onAbort, { once: true });

    try {
      await new Promise((resolve) => setTimeout(resolve, response.delay ?? 5));

      if (aborted || signal.aborted) {
        return { partial: true, error: "Aborted during execution" };
      }

      const exitCode = response.exitCode ?? 0;
      if (exitCode !== 0) {
        return { exitCode, error: response.stdout ?? `Process exited with code ${exitCode}` };
      }

      // Handle capture config
      const capture = node.metadata.capture as Record<string, unknown> | undefined;
      let output: unknown = response.parsedOutput;

      if (!output && response.stdout && capture?.parse === "json") {
        try {
          output = JSON.parse(response.stdout);
        } catch {
          return { error: "Failed to parse stdout as JSON" };
        }
      }

      if (!output && response.stdout && capture?.parse === "text") {
        output = response.stdout;
      }

      return { output, exitCode };
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }
}
