import { execa } from "execa";
import type { IrNode } from "@acpus/core";
import type { ExpressionContext, ExecutorResult } from "../types.js";
import type { ExecutorAdapter } from "./types.js";
import { ExpressionEvaluator } from "../evaluator.js";
import { Ajv } from "ajv";

/**
 * Agent executor that drives acpx for ACP session management.
 *
 * Session name is derived from node key (stable, deterministic).
 * Execute: spawn acpx --session <name> --cwd <cwd>, send prompt.
 * Output validation: Ajv against compiled JSON Schema.
 * Cancel: execa's cancelSignal terminates the child process via SIGTERM.
 * Resume: call acpx with same --session, send continuation prompt.
 */
export class AgentExecutor implements ExecutorAdapter {
  private readonly evaluator: ExpressionEvaluator;
  private readonly ajv: Ajv;
  private readonly acpxPath: string;

  constructor(options?: { acpxPath?: string; evaluator?: ExpressionEvaluator }) {
    this.evaluator = options?.evaluator ?? new ExpressionEvaluator();
    this.ajv = new Ajv({ allErrors: true, strict: false });
    this.acpxPath = options?.acpxPath ?? "acpx";
  }

  async execute(node: IrNode, context: ExpressionContext, signal: AbortSignal): Promise<ExecutorResult> {
    const stepId = node.id;
    const agentSpec = node.metadata.use as string;
    const promptTemplate = node.metadata.prompt as string;
    const outputSchema = node.metadata.output as Record<string, unknown> | undefined;

    // Resolve prompt template
    const prompt = this.evaluator.evaluateTemplate(promptTemplate, context);

    // Session name: derived from node key (stable, deterministic)
    const sessionName = `acpus-${context.run_id}-${stepId}`;

    if (signal.aborted) {
      return { partial: true, error: "Aborted before execution" };
    }

    const input = JSON.stringify({ prompt }) + "\n";

    try {
      const result = await execa(this.acpxPath, ["--session", sessionName, "--cwd", process.cwd()], {
        input,
        reject: false,
        cancelSignal: signal,
        env: { ...process.env },
      });

      if (result.isCanceled) {
        return { partial: true, output: result.stdout, error: "Aborted" };
      }

      if (result.failed && result.exitCode !== 0) {
        return {
          exitCode: result.exitCode ?? 1,
          error: result.stderr || `acpx exited with code ${result.exitCode}`
        };
      }

      // Parse output from acpx
      let output: unknown;
      try {
        output = JSON.parse(result.stdout);
      } catch {
        output = { text: result.stdout };
      }

      // Validate output against schema if provided
      if (outputSchema && typeof output === "object" && output !== null) {
        const validate = this.ajv.compile(outputSchema);
        if (!validate(output)) {
          return {
            error: `Output validation failed: ${this.ajv.errorsText(validate.errors)}`,
            output
          };
        }
      }

      return { exitCode: 0, output };
    } catch (error) {
      return { exitCode: 1, error: error instanceof Error ? error.message : String(error) };
    }
  }
}
