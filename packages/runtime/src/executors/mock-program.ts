import type { ExecutorResult, FailureKind } from "../types.js";
import type { ExecutorAdapter, ProgramExecutionRequest } from "./types.js";
import { ExpressionEvaluator } from "../evaluator.js";
import { Ajv } from "ajv";
import { schemaValidationError } from "./output-preview.js";

export interface MockProgramResponse {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  parsedOutput?: unknown;
  /** Raw captured output used in diagnostics; useful for file captures. */
  capturedOutputRaw?: string;
  /** Simulate a non-recoverable failure (timeout/spawn/killed/capture). */
  failureKind?: FailureKind;
  delay?: number;
}

/**
 * Mock program executor for testing. Takes a step-id → {stdout, exitCode, parsedOutput} map,
 * resolves cmd template, handles capture config.
 */
export class MockProgramExecutor implements ExecutorAdapter<ProgramExecutionRequest> {
  private readonly responses: Map<string, MockProgramResponse>;
  private readonly evaluator: ExpressionEvaluator;
  private readonly ajv = new Ajv({ allErrors: true, strict: false });

  constructor(responses: Record<string, MockProgramResponse>, evaluator?: ExpressionEvaluator) {
    this.responses = new Map(Object.entries(responses));
    this.evaluator = evaluator ?? new ExpressionEvaluator();
  }

  async execute({ node, context, signal }: ProgramExecutionRequest): Promise<ExecutorResult> {
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

      const stdout = response.stdout ?? "";
      const stderr = response.stderr ?? "";

      // Simulate a non-recoverable failure if configured.
      if (response.failureKind) {
        return { failureKind: response.failureKind, error: `Simulated ${response.failureKind} failure`, stdout, stderr };
      }

      const exitCode = response.exitCode ?? 0;

      // Mirror ADR-0006: a non-zero exit not allow-listed by `expect.exit_code`
      // (default `[0]`) fails the node fast and precedes capture/schema checks.
      const expect = node.metadata.expect as { exit_code?: number[] } | undefined;
      const allowedExitCodes = expect?.exit_code ?? [0];
      if (!allowedExitCodes.includes(exitCode)) {
        return {
          failureKind: "exit",
          error: `exit_code=${exitCode}`,
          exitCode,
          stdout,
          stderr
        };
      }

      // Handle capture config — an allow-listed exit code is step data.
      const capture = node.metadata.capture as Record<string, unknown> | undefined;
      let output: unknown = response.parsedOutput;
      let capturedOutputRaw: string | undefined = response.capturedOutputRaw;

      if (capturedOutputRaw === undefined && capture?.from === "stdout") {
        capturedOutputRaw = response.stdout;
      }

      if (output === undefined && capturedOutputRaw !== undefined && capture?.parse === "json") {
        try {
          output = JSON.parse(capturedOutputRaw);
        } catch {
          return { failureKind: "capture", error: "Failed to parse stdout as JSON", exitCode, stdout, stderr };
        }
      }

      if (output === undefined && capturedOutputRaw !== undefined && capture?.parse === "text") {
        output = capturedOutputRaw;
      }

      if (!capture) {
        capturedOutputRaw = undefined;
      }

      // Validate output against schema when declared (mirrors real ProgramExecutor).
      const outputSchema = node.metadata.output as Record<string, unknown> | undefined;
      if (outputSchema && output !== undefined) {
        const validate = this.ajv.compile(outputSchema);
        if (!validate(output)) {
          return { failureKind: "schema", error: schemaValidationError(this.ajv.errorsText(validate.errors), capturedOutputRaw, output), exitCode, stdout, stderr };
        }
      }

      return { output, exitCode, stdout, stderr };
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }
}
