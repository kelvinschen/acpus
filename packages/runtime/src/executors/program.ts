import { execa } from "execa";
import type { IrNode } from "@acpus/core";
import { parseDurationMs } from "@acpus/core";
import type { ExpressionContext, ExecutorResult } from "../types.js";
import type { ExecutorAdapter } from "./types.js";
import { ExpressionEvaluator } from "../evaluator.js";

/**
 * Real program executor using execa for subprocess management.
 * Handles cmd template resolution, capture config, timeout, and abort signal.
 */
export class ProgramExecutor implements ExecutorAdapter {
  private readonly evaluator: ExpressionEvaluator;

  constructor(evaluator?: ExpressionEvaluator) {
    this.evaluator = evaluator ?? new ExpressionEvaluator();
  }

  async execute(node: IrNode, context: ExpressionContext, signal: AbortSignal): Promise<ExecutorResult> {
    const cmdTemplate = node.metadata.cmd;
    const timeout = node.metadata.timeout as string | undefined;
    const capture = node.metadata.capture as Record<string, unknown> | undefined;

    // Resolve cmd template
    const cmd = this.resolveCmd(cmdTemplate, context);

    if (signal.aborted) {
      return { partial: true, error: "Aborted before execution" };
    }

    const shell = typeof cmd === "string";
    const args = Array.isArray(cmd) ? cmd.slice(1) : [];
    const command = Array.isArray(cmd) ? cmd[0] : cmd;
    const timeoutMs = timeout ? parseDurationMs(timeout) : undefined;

    try {
      const result = await execa(command, args, {
        shell,
        reject: false,
        timeout: timeoutMs && timeoutMs > 0 ? timeoutMs : 0,
        killSignal: "SIGKILL",
        cancelSignal: signal,
        env: { ...process.env, ...(node.metadata.env as Record<string, string> | undefined) },
      });

      if (result.isCanceled) {
        return { partial: true, output: result.stdout, error: "Aborted during execution" };
      }

      if (result.failed && result.exitCode !== 0) {
        return {
          exitCode: result.exitCode ?? 1,
          error: result.stderr || `Process exited with code ${result.exitCode}`,
          output: result.stderr
        };
      }

      // Handle capture config
      let output: unknown;
      if (capture) {
        const from = capture.from as string;
        const parse = capture.parse as string;

        const rawOutput = from === "file" ? result.stdout : result.stdout; // For now, always stdout

        if (parse === "json") {
          try {
            output = JSON.parse(rawOutput);
          } catch {
            return { exitCode: 0, error: "Failed to parse stdout as JSON" };
          }
        } else if (parse === "text") {
          output = rawOutput;
        } else {
          output = rawOutput;
        }
      } else {
        output = result.stdout || undefined;
      }

      return { exitCode: 0, output };
    } catch (error) {
      return { exitCode: 1, error: error instanceof Error ? error.message : String(error) };
    }
  }

  private resolveCmd(cmd: unknown, context: ExpressionContext): string | string[] {
    if (Array.isArray(cmd)) {
      return cmd.map((c) => {
        if (typeof c === "string") {
          return this.evaluator.evaluateTemplate(c, context);
        }
        return String(c);
      });
    }
    if (typeof cmd === "string") {
      return this.evaluator.evaluateTemplate(cmd, context);
    }
    return String(cmd);
  }
}
