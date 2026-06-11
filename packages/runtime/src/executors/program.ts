import { execa } from "execa";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Ajv } from "ajv";
import { parseDurationMs } from "@acpus/core";
import type { ExpressionContext, ExecutorResult } from "../types.js";
import type { ExecutorAdapter, ExecutionRequest } from "./types.js";
import { ExpressionEvaluator } from "../evaluator.js";
import { schemaValidationError } from "./output-preview.js";

/**
 * Real program executor using execa for subprocess management.
 * Handles cmd template resolution, capture config, timeout, and abort signal.
 *
 * A non-zero exit code that is not listed in the step's `expect.exit_code`
 * allow-list (default `[0]`) fails the node with `failureKind: "exit"`. This
 * fail-fast policy lets dynamic shell/python script breakage (syntax errors,
 * missing tools, unbound paths) surface at the broken Program Step rather than
 * far downstream at a Guard Node. Authors who treat exit codes as a business
 * signal (test runners, grep, diff) opt out by listing the expected codes in
 * `expect.exit_code`.
 *
 * Other non-recoverable conditions — timeout, signal kill, spawn failure,
 * capture parse failure — also fail the node via `failureKind`.
 */
export class ProgramExecutor implements ExecutorAdapter {
  private readonly evaluator: ExpressionEvaluator;
  private readonly ajv = new Ajv({ allErrors: true, strict: false });

  constructor(evaluator?: ExpressionEvaluator) {
    this.evaluator = evaluator ?? new ExpressionEvaluator();
  }

  async execute({ node, context, signal }: ExecutionRequest): Promise<ExecutorResult> {
    const cmdTemplate = node.metadata.cmd;
    const timeoutRaw = node.metadata.timeout;
    const capture = node.metadata.capture as Record<string, unknown> | undefined;

    // Resolve cmd template
    const cmd = this.resolveCmd(cmdTemplate, context);

    if (signal.aborted) {
      return { partial: true, error: "Aborted before execution" };
    }

    const shell = typeof cmd === "string";
    const args = Array.isArray(cmd) ? cmd.slice(1) : [];
    const command = Array.isArray(cmd) ? cmd[0] : cmd;
    // Numeric timeout is milliseconds directly; string timeout is a duration.
    const timeoutMs = typeof timeoutRaw === "number" && timeoutRaw > 0
      ? timeoutRaw
      : typeof timeoutRaw === "string"
        ? parseDurationMs(timeoutRaw) || undefined
        : undefined;

    // Evaluate env templates. A bad expression (e.g. referencing an unknown step)
    // is a user-facing error, not a spawn failure — catch and report clearly.
    let env: Record<string, string>;
    try {
      env = { ...Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== undefined) as [string, string][]), ...this.evaluateEnv(node.metadata.env as Record<string, unknown> | undefined, context) };
    } catch (error) {
      return {
        failureKind: "capture",
        error: `Failed to evaluate env template: ${error instanceof Error ? error.message : String(error)}`,
        stdout: "",
        stderr: ""
      };
    }

    let result;
    try {
      result = await execa(command, args, {
        shell,
        reject: false,
        timeout: timeoutMs && timeoutMs > 0 ? timeoutMs : 0,
        killSignal: "SIGKILL",
        cancelSignal: signal,
        env,
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
      return { failureKind: "timeout", error: `Process timed out after ${timeoutMs}ms`, stdout, stderr };
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

    // ADR-0006: a non-zero exit not allow-listed by `expect.exit_code` fails
    // the node fast. The default allow-list is `[0]`. This precedes capture
    // and schema checks so a broken script never masquerades as a parse error.
    const expect = node.metadata.expect as { exit_code?: number[] } | undefined;
    const allowedExitCodes = expect?.exit_code ?? [0];
    if (!allowedExitCodes.includes(exitCode)) {
      const tail = stderrTail(stderr, 20);
      const message = tail
        ? `exit_code=${exitCode}; stderr (last ${tail.lines} line${tail.lines === 1 ? "" : "s"}):\n${tail.text}`
        : `exit_code=${exitCode}`;
      return { failureKind: "exit", error: message, exitCode, stdout, stderr };
    }

    // Handle capture config.
    let output: unknown;
    let capturedOutputRaw: string | undefined;
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
      capturedOutputRaw = raw;

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

    // Validate output against schema when declared (mirrors agent schema validation).
    const outputSchema = node.metadata.output as Record<string, unknown> | undefined;
    if (outputSchema && output !== undefined) {
      const validate = this.ajv.compile(outputSchema);
      if (!validate(output)) {
        return {
          failureKind: "schema",
          error: schemaValidationError(this.ajv.errorsText(validate.errors), capturedOutputRaw, output),
          exitCode,
          stdout,
          stderr
        };
      }
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

  /** Evaluate template expressions in env values; non-strings are stringified. */
  private evaluateEnv(env: Record<string, unknown> | undefined, context: ExpressionContext): Record<string, string> {
    if (!env) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(env)) {
      out[k] = typeof v === "string" ? this.evaluator.evaluateTemplate(v, context) : String(v);
    }
    return out;
  }
}

/**
 * Return the last `max` non-empty lines of stderr for inclusion in a Node-failed
 * error summary. Returns undefined when there's nothing useful to show.
 */
function stderrTail(stderr: string | undefined, max: number): { text: string; lines: number } | undefined {
  if (!stderr) return undefined;
  const lines = stderr.replace(/\s+$/u, "").split(/\r?\n/u);
  const trimmed = lines.slice(-max);
  if (trimmed.length === 0 || (trimmed.length === 1 && trimmed[0] === "")) return undefined;
  return { text: trimmed.join("\n"), lines: trimmed.length };
}
