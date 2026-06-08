import type { AgentSpec } from "@acpus/core";
import { resolve } from "node:path";
import { loadMockScript, responseText, selectResponse, type MockRespond, type MockScript } from "@acpus/mock-agent";
import type { ExecutorResult, FailureKind } from "../types.js";
import type { ExecutorAdapter, ExecutionRequest } from "./types.js";
import { ExpressionEvaluator } from "../evaluator.js";
import { Ajv } from "ajv";

/**
 * Mock agent executor for testing. Takes a step-id → response map,
 * resolves prompt template, returns mock output, validates against
 * schema (Ajv), and respects AbortSignal (returns partial result).
 *
 * A response may declare a `sequence` of results returned in order on
 * successive calls (used to test retry: fail then succeed). Per-step call
 * counts are tracked on the executor instance.
 */
export class MockAgentExecutor implements ExecutorAdapter {
  private readonly responses: Map<string, MockAgentResponse>;
  private readonly evaluator: ExpressionEvaluator;
  private readonly ajv: Ajv;
  private readonly callCounts: Map<string, number> = new Map();
  private readonly scriptCache: Map<string, MockScript> = new Map();

  constructor(responses: Record<string, MockAgentResponse>, evaluator?: ExpressionEvaluator) {
    this.responses = new Map(Object.entries(responses));
    this.evaluator = evaluator ?? new ExpressionEvaluator();
    this.ajv = new Ajv({ allErrors: true, strict: false });
  }

  async execute({ node, context, signal }: ExecutionRequest): Promise<ExecutorResult> {
    const stepId = node.id;

    // Resolve prompt template. Script-backed mock agents select responses by
    // the rendered prompt, matching the ACP mock-agent script semantics without
    // spawning acpx or consuming model tokens.
    let renderedPrompt = "";
    const promptTemplate = node.metadata.prompt as string | undefined;
    if (promptTemplate) {
      renderedPrompt = this.evaluator.evaluateTemplate(promptTemplate, context);
    }

    let response: MockAgentResponse | undefined;
    try {
      response = this.responseFor(node.metadata.agent as AgentSpec | undefined, stepId, renderedPrompt);
    } catch (error) {
      return { failureKind: "spawn", error: `Failed to load mock_script for step '${stepId}': ${errorMessage(error)}` };
    }
    if (!response) {
      return { error: `No mock response configured for step '${stepId}'` };
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

      // Validate output against schema if provided
      const output = effective.output;
      const schema = node.metadata.output as Record<string, unknown> | undefined;
      if (schema && output !== undefined) {
        const validate = this.ajv.compile(schema);
        if (!validate(output)) {
          return { failureKind: "schema", error: `Output validation failed: ${this.ajv.errorsText(validate.errors)}` };
        }
      }

      return { output };
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }

  private responseFor(agent: AgentSpec | undefined, stepId: string, prompt: string): MockAgentResponse | undefined {
    if (agent?.mock_script) {
      const script = this.loadScript(agent.mock_script, agent.cwd);
      const selected = selectResponse(script, prompt);
      return outputFromMockRespond(selected.response);
    }
    return this.responses.get(stepId);
  }

  private loadScript(scriptPath: string, cwd: unknown): MockScript {
    const base = typeof cwd === "string" && cwd.length > 0 ? cwd : process.cwd();
    const abs = resolve(base, scriptPath);
    const cached = this.scriptCache.get(abs);
    if (cached) return cached;
    const script = loadMockScript(abs);
    this.scriptCache.set(abs, script);
    return script;
  }

  /** Return the response for this call, advancing through a `sequence` if present. */
  private pickResponse(stepId: string, response: MockAgentResponse): MockAgentResponse {
    if (!response.sequence || response.sequence.length === 0) {
      return response;
    }
    const n = this.callCounts.get(stepId) ?? 0;
    this.callCounts.set(stepId, n + 1);
    // Keep returning the final element once the sequence is exhausted.
    return response.sequence[Math.min(n, response.sequence.length - 1)]!;
  }
}

function outputFromMockRespond(response: MockRespond): MockAgentResponse {
  if (response.type === "json") return { output: response.payload };
  if (response.type === "text") return { output: { text: responseText(response) } };
  if (response.type === "error") return { error: response.error.message };
  return { error: "Mock script selected a hanging response; in-memory mock_script execution does not support hangs" };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface MockAgentResponse {
  output?: unknown;
  error?: string;
  /** Simulate a classified failure (parse/schema are retryable). */
  failureKind?: FailureKind;
  /** Ordered responses returned on successive calls (for retry tests). */
  sequence?: MockAgentResponse[];
  delay?: number;
}
