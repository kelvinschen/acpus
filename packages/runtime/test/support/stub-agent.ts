import type { ExecutorResult, FailureKind } from "../../src/types.js";
import type { ExecutorAdapter, ExecutionRequest } from "../../src/executors/types.js";

/**
 * A lightweight test double for agent execution. Takes a step-id → response
 * map, supports sequences (for retry tests), delay, and AbortSignal — but
 * does NOT load mock scripts, run Ajv validation, or import @acpus/mock-agent.
 *
 * Schema/parse failure scenarios are simulated by setting `failureKind`
 * explicitly. Real schema validation is covered by E2E tests that use the
 * acpx-backed AgentExecutor.
 */
export class StubAgentExecutor implements ExecutorAdapter {
  private readonly responses: Map<string, StubAgentResponse>;
  private readonly callCounts: Map<string, number> = new Map();

  constructor(responses: Record<string, StubAgentResponse>) {
    this.responses = new Map(Object.entries(responses));
  }

  async execute({ node, signal }: ExecutionRequest): Promise<ExecutorResult> {
    const stepId = node.id;
    const response = this.responses.get(stepId);

    if (!response) {
      return { error: `No stub response configured for step '${stepId}'` };
    }
    if (response.error) {
      return { error: response.error };
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

      // Pick this call's effective response (sequence supports retry tests).
      const effective = this.pickResponse(stepId, response);

      // Simulate a classified failure (e.g. parse/schema for retry).
      if (effective.failureKind) {
        return { failureKind: effective.failureKind, error: `Simulated ${effective.failureKind} failure` };
      }

      return { output: effective.output };
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }

  /** Return the response for this call, advancing through a `sequence` if present. */
  private pickResponse(stepId: string, response: StubAgentResponse): StubAgentResponse {
    if (!response.sequence || response.sequence.length === 0) {
      return response;
    }
    const n = this.callCounts.get(stepId) ?? 0;
    this.callCounts.set(stepId, n + 1);
    // Keep returning the final element once the sequence is exhausted.
    return response.sequence[Math.min(n, response.sequence.length - 1)]!;
  }
}

export interface StubAgentResponse {
  output?: unknown;
  error?: string;
  /** Simulate a classified failure (parse/schema are retryable). */
  failureKind?: FailureKind;
  /** Ordered responses returned on successive calls (for retry tests). */
  sequence?: StubAgentResponse[];
  delay?: number;
}
