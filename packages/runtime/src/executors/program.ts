import { execa } from "execa";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { IrNode } from "@acpus/core";
import { parseDurationMs } from "@acpus/core";
import type { ExpressionContext, ExecutorResult } from "../types.js";
import type { ExecutorAdapter } from "./types.js";
import { ExpressionEvaluator } from "../evaluator.js";

/**
 * Real program executor using execa for subprocess management.
 * Handles cmd template resolution, capture config, timeout, and abort signal.
 *
 * A non-zero exit code is treated as step data (the node completes and exposes
 * exit_code). Only non-recoverable conditions — timeout, signal kill, spawn
 * failure, or capture parse failure — fail the node via `failureKind`.
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

    let result;
    try {
      result = await execa(command, args, {
        shell,
        reject: false,
        timeout: timeoutMs && timeoutMs > 0 ? timeoutMs : 0,
        killSignal: "SIGKILL",
        cancelSignal: signal,
        env: { ...process.env, ...(node.metadata.env as Record<string, string> | undefined) },
      });
    } catch (error) {
      // Spawn-level failure (e.g. command not found) — non-recoverable.
      return {
        failureKind: "spawn",
        error: error instanceof Error ? error.message : String(error),
        stdout: "",
        stderr: error instanceof Error ? error.message : String(error)
      };
    }

    const stdout = result.stdout ?? "";
    const stderr = result.stderr ?? "";

    // Operator abort (pause/cancel) → partial.
    if (result.isCanceled) {
      return { partial: true, output: stdout, stdout, stderr, error: "Aborted during execution" };
    }

    // Timeout → non-recoverable.
    if (result.timedOut) {
      return { failureKind: "timeout", error: `Process timed out after ${timeout}`, stdout, stderr };
    }

    // Killed by signal (SIGKILL etc.) → non-recoverable.
    if (result.isTerminated || (result.signal !== undefined && result.signal !== null)) {
      return { failureKind: "killed", error: `Process killed by signal ${result.signal}`, stdout, stderr };
    }

    // Spawn failure (e.g. command not found) — execa with reject:false reports
    // `failed` with no exit code rather than throwing.
    if (result.failed && (result.exitCode === undefined || result.exitCode === null)) {
      return {
        failureKind: "spawn",
        error: result.shortMessage || result.message || "Failed to spawn process",
        stdout,
        stderr
      };
    }

    const exitCode = result.exitCode ?? 0;

    // Handle capture config.
    let output: unknown;
    if (capture) {
      const from = capture.from as string;
      const parse = capture.parse as string;

      let raw: string;
      if (from === "file") {
        const filePath = resolve(process.cwd(), capture.path as string);
        try {
          raw = readFileSync(filePath, "utf8");
        } catch (error) {
          return {
            failureKind: "capture",
            error: `Failed to read capture file '${capture.path}': ${error instanceof Error ? error.message : String(error)}`,
            exitCode,
            stdout,
            stderr
          };
        }
      } else {
        raw = stdout;
      }

      if (parse === "json") {
        try {
          output = JSON.parse(raw);
        } catch {
          return { failureKind: "capture", error: "Failed to parse captured output as JSON", exitCode, stdout, stderr };
        }
      } else {
        output = raw;
      }
    } else {
      output = stdout || undefined;
    }

    return { exitCode, output, stdout, stderr };
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
