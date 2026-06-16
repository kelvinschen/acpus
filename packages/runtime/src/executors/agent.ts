import { execa, type ResultPromise } from "execa";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseDurationMs, type AgentSpec } from "@acpus/core";
import type { ExpressionContext, ExecutorResult } from "../types.js";
import type { ExecutorAdapter, ExecutionRequest } from "./types.js";
import { ExpressionEvaluator } from "../evaluator.js";
import { Ajv } from "ajv";
import { jsonrepair } from "jsonrepair";
import { AgentTelemetryAccumulator } from "../agent-telemetry.js";

/** Fixed runtime prompt used when continuing an existing agent session. */
const CONTINUATION_PROMPT = "Continue the previous task from where you left off.";

/** Grace period (ms) to wait for a cooperative cancel before SIGKILL. */
const DEFAULT_CANCEL_GRACE_MS = 5000;

/**
 * Drives an ACP agent through the `acpx` CLI. Acpus owns scheduling/state;
 * acpx owns the ACP saved-session lifecycle and dead-pid recovery.
 *
 * - Session name is derived from the resolved node key (stable, unique per
 *   loop round / fanout lane / subworkflow nesting).
 * - First run: `sessions ensure` then `prompt -s <session>` with the rendered
 *   prompt; continuation: same session with a fixed continuation prompt.
 * - Cancel is cooperative: on abort we run `acpx cancel -s <session>` and wait
 *   for the in-flight prompt to settle (SIGKILL only as a last resort).
 * - Output is the concatenation of `agent_message_chunk` text from the ACP
 *   NDJSON stream; stdout buffering is disabled so the full stream is not
 *   retained in memory.
 */
export class AgentExecutor implements ExecutorAdapter {
  private readonly evaluator: ExpressionEvaluator;
  private readonly ajv: Ajv;
  private readonly acpxPath?: string;
  private readonly cancelGraceMs: number;

  constructor(options?: { acpxPath?: string; evaluator?: ExpressionEvaluator; cancelGraceMs?: number }) {
    this.evaluator = options?.evaluator ?? new ExpressionEvaluator();
    this.ajv = new Ajv({ allErrors: true, strict: false });
    this.acpxPath = options?.acpxPath;
    this.cancelGraceMs = options?.cancelGraceMs ?? DEFAULT_CANCEL_GRACE_MS;
  }

  async execute({ node, context, signal, nodeKey, prompt: preparedPrompt, sessionKey: preparedSessionKey, continuation, retry, onStream }: ExecutionRequest): Promise<ExecutorResult> {
    const agent = node.metadata.agent as AgentSpec | undefined;
    if (!agent) {
      return { failureKind: "spawn", error: `Agent step '${node.id}' has no resolved agent definition` };
    }

    const outputSchema = node.metadata.output as Record<string, unknown> | undefined;
    const timeoutSeconds = this.resolveTimeoutSeconds(node.metadata.timeout);

    // Evaluate local templates before touching acpx. These are deterministic
    // config errors and must not consume output-retry attempts.
    let cwd: string | undefined;
    let env: NodeJS.ProcessEnv;
    let prompt: string;
    let sessionName: string;
    try {
      // Step-level cwd overrides the agent definition's default cwd.
      cwd = this.resolveCwd(node.metadata.cwd ?? agent.cwd, context);
      env = { ...process.env, ...this.stringEnv(agent.env, context) };
      prompt = preparedPrompt ?? renderAgentRequestPrompt(node, context, this.evaluator, Boolean(continuation), Boolean(retry));
      const sessionKey = preparedSessionKey ?? renderAgentSessionKey(node, context, this.evaluator);
      sessionName = this.sessionName(context.run_id, nodeKey, sessionKey);
    } catch (error) {
      return {
        failureKind: "config",
        error: `Failed to evaluate agent configuration template: ${error instanceof Error ? error.message : String(error)}`
      };
    }

    if (signal.aborted) {
      return { partial: true, error: "Aborted before execution", prompt, responseText: "" };
    }

    const invoker = this.resolveInvoker();
    const build = this.argsBuilder(agent, cwd);

    let acpxRecordId: string | undefined;
    try {
      // Ensure a saved session exists (idempotent). acpx requires a session
      // record before prompt commands route to it.
      const ensureResult = await execa(invoker.command, [...invoker.prefixArgs, ...build(["--format", "json"], ["sessions", "ensure", "--name", sessionName])], {
        reject: false,
        env
      });

      if (ensureResult.failed) {
        const exitCode = ensureResult.exitCode ?? 1;
        const stderr = ensureResult.stderr ?? "";
        const detail = stderr || ensureResult.shortMessage || `acpx sessions ensure exited with code ${exitCode}`;
        return { failureKind: "spawn", exitCode, error: detail, prompt, responseText: "", stdout: ensureResult.stdout ?? "", stderr };
      }

      if (ensureResult.stdout) {
        try {
          acpxRecordId = JSON.parse(ensureResult.stdout).acpxRecordId;
        } catch { /* non-JSON output; record ID stays undefined */ }
      }

      if (signal.aborted) {
        return { partial: true, error: "Aborted before prompt", prompt, responseText: "", acpxRecordId, cwd };
      }

      // Run the prompt, streaming the ACP protocol as NDJSON. Stdout buffering
      // is disabled so execa does not retain the full stream in memory.
      const promptGlobalArgs = [...(timeoutSeconds ? ["--timeout", timeoutSeconds] : []), "--format", "json"];
      const promptArgs = [...invoker.prefixArgs, ...build(promptGlobalArgs, ["prompt", "-s", sessionName, prompt])];
      const accumulator = new AgentTelemetryAccumulator({ attempt: 1, inputText: prompt, acpxRecordId, cwd });
      const proc = execa(invoker.command, promptArgs, {
        reject: false,
        env,
        buffer: { stdout: false }
      });
      let stderrText = "";
      proc.stdout?.on("data", (chunk) => {
        const text = String(chunk);
        onStream?.("stdout", text);
        accumulator.append(text);
      });
      proc.stderr?.on("data", (chunk) => {
        const text = String(chunk);
        stderrText += text;
        onStream?.("stderr", text);
      });

      const cancellation = this.wireCooperativeCancel(proc, signal, invoker, build, sessionName, env);

      const result = await proc;
      cancellation.cleanup();

      const stderr = result.stderr ?? stderrText;
      accumulator.flush();
      const text = accumulator.responseText();
      const stopReason = accumulator.finalStopReason();

      // Cooperative cancel (or any cancelled turn) → paused with partial response.
      if (cancellation.cancelled || stopReason === "cancelled") {
        return { partial: true, output: { text }, prompt, responseText: text, stderr, error: "Aborted", acpxRecordId, cwd };
      }

      // Spawn failure (no exit code) → non-recoverable.
      if (result.failed && (result.exitCode === undefined || result.exitCode === null)) {
        return { failureKind: "spawn", error: result.shortMessage || "Failed to spawn acpx", prompt, responseText: text, stderr, acpxRecordId, cwd };
      }

      // Non-zero exit (and not cancelled) → non-recoverable agent failure.
      if (result.exitCode !== 0) {
        return { failureKind: "exit", exitCode: result.exitCode ?? 1, error: stderr || `acpx exited with code ${result.exitCode}`, prompt, responseText: text, stderr, acpxRecordId, cwd };
      }

      // Assemble structured output. When a schema is declared, extract a JSON
      // object from the (possibly prose-wrapped) reply; failure to extract is a
      // retryable parse failure. Otherwise wrap as { text }.
      let output: unknown;
      if (outputSchema) {
        const parsed = extractJson(text);
        if (parsed === undefined) {
          return { failureKind: "parse", error: "Failed to parse agent output as JSON", output: { text }, prompt, responseText: text, stderr, acpxRecordId, cwd };
        }
        const validate = this.ajv.compile(outputSchema);
        if (!validate(parsed)) {
          return { failureKind: "schema", error: `Output validation failed: ${this.ajv.errorsText(validate.errors)}`, output: parsed, prompt, responseText: text, stderr, acpxRecordId, cwd };
        }
        output = parsed;
      } else {
        output = { text };
      }

      return { exitCode: 0, output, prompt, responseText: text, stderr, acpxRecordId, cwd };
    } catch (error) {
      return { failureKind: "spawn", error: error instanceof Error ? error.message : String(error), prompt, responseText: "", acpxRecordId, cwd };
    }
  }

  /**
   * On abort, request a cooperative `session/cancel` via acpx and schedule a
   * SIGKILL fallback if the in-flight prompt does not settle within the grace
   * period. Returns a handle exposing whether cancel fired and a cleanup fn.
   */
  private wireCooperativeCancel(
    proc: ResultPromise,
    signal: AbortSignal,
    invoker: { command: string; prefixArgs: string[] },
    build: (global: string[], sub: string[]) => string[],
    sessionName: string,
    env: NodeJS.ProcessEnv
  ): { cancelled: boolean; cleanup: () => void } {
    const handle = { cancelled: false, cleanup: () => undefined as void };
    let killTimer: NodeJS.Timeout | undefined;

    const onAbort = (): void => {
      handle.cancelled = true;
      // Fire-and-forget cooperative cancel; failures are non-fatal.
      void execa(invoker.command, [...invoker.prefixArgs, ...build([], ["cancel", "-s", sessionName])], { reject: false, env }).catch(() => undefined);
      // Last-resort kill if the prompt process refuses to settle.
      killTimer = setTimeout(() => { proc.kill("SIGKILL"); }, this.cancelGraceMs);
    };

    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();

    handle.cleanup = (): void => {
      if (killTimer) clearTimeout(killTimer);
      signal.removeEventListener("abort", onAbort);
    };
    return handle;
  }

  /**
   * Build acpx arg lists for a subcommand. Global flags (--cwd, --model,
   * --format) precede the command. For `command` agents the custom ACP server
   * is selected via the `--agent` escape hatch; for `builtin` agents the
   * adapter name is the command prefix.
   */
  private argsBuilder(agent: AgentSpec, cwd: string): (global: string[], sub: string[]) => string[] {
    const globalBase = [
      "--cwd",
      cwd,
      ...(agent.model ? ["--model", agent.model] : [])
    ];
    if (agent.type === "command") {
      const command = agent.use ?? "";
      return (global, sub) => ["--agent", command, ...globalBase, ...global, ...sub];
    }
    // builtin (default): adapter name from `use`.
    const adapter = agent.use ?? "";
    return (global, sub) => [...globalBase, ...global, adapter, ...sub];
  }

  /** Resolve how to invoke acpx: an explicit path, or the resolved package bin via node. */
  private resolveInvoker(): { command: string; prefixArgs: string[] } {
    if (this.acpxPath) return { command: this.acpxPath, prefixArgs: [] };
    const req = createRequire(import.meta.url);
    const pkgJsonPath = req.resolve("acpx/package.json");
    const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8")) as { bin?: string | Record<string, string> };
    const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.acpx ?? "dist/cli.js";
    return { command: process.execPath, prefixArgs: [resolve(dirname(pkgJsonPath), bin)] };
  }

  private sessionName(runId: string, nodeKey: string, sessionKey: string | undefined): string {
    const key = sessionKey === undefined ? sanitizeNodeKeySession(nodeKey) : encodeSessionKey(sessionKey);
    return `acpus-${runId}-${key}`;
  }

  private resolveCwd(cwd: unknown, context: ExpressionContext): string {
    if (typeof cwd === "string" && cwd.length > 0) {
      return resolve(this.evaluator.evaluateTemplate(cwd, context));
    }
    return process.cwd();
  }

  private resolveTimeoutSeconds(timeout: unknown): string | undefined {
    const milliseconds = typeof timeout === "number"
      ? timeout
      : typeof timeout === "string"
        ? parseDurationMs(timeout)
        : undefined;
    if (milliseconds === undefined || milliseconds <= 0) return undefined;
    return String(milliseconds / 1000);
  }

  private stringEnv(env: Record<string, unknown> | undefined, context: ExpressionContext): Record<string, string> {
    if (!env) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(env)) out[k] = typeof v === "string" ? this.evaluator.evaluateTemplate(v, context) : String(v);
    return out;
  }
}

/** Replace characters not safe for an acpx `-s <name>` value in generated node keys. */
function sanitizeNodeKeySession(nodeKey: string): string {
  return nodeKey.replace(/\//g, "__").replace(/:/g, "-");
}

/** Encode author-controlled session keys without collisions from normalization. */
function encodeSessionKey(sessionKey: string): string {
  if (sessionKey.trim().length === 0) {
    throw new Error("session_key must render to a non-empty string");
  }
  return `key-${Buffer.from(sessionKey, "utf8").toString("base64url")}`;
}

/** Render the declared output schema as an explicit contract section appended to the prompt. */
function schemaSection(outputSchema: Record<string, unknown>): string {
  return `\n\n# OUTPUT SCHEMA\n**After completing the task, your final response MUST be exactly one JSON object that conforms to this schema, with no Markdown, prose, or extra keys.**\n${JSON.stringify(outputSchema, null, 2)}`;
}

/**
 * Decide the prompt text for an agent turn:
 *   - first run        → rendered task template
 *   - continuation     → fixed continuation prompt
 *   - parse/schema retry→ fixed continuation prompt
 * When an output schema is declared it is appended as a `# OUTPUT SCHEMA`
 * section on the first run and on retries, but NOT on a plain continuation
 * (the original task is still live in the acpx session there).
 */
export function buildAgentPrompt(
  renderedTask: string,
  outputSchema: Record<string, unknown> | undefined,
  continuation: boolean,
  retry: boolean
): string {
  if (retry) {
    return outputSchema ? CONTINUATION_PROMPT + schemaSection(outputSchema) : CONTINUATION_PROMPT;
  }
  if (continuation) {
    return CONTINUATION_PROMPT;
  }
  return outputSchema ? renderedTask + schemaSection(outputSchema) : renderedTask;
}

/** Render the exact Agent request prompt that will be sent to acpx. */
export function renderAgentRequestPrompt(
  node: { metadata: Record<string, unknown> },
  context: ExpressionContext,
  evaluator: ExpressionEvaluator,
  continuation: boolean,
  retry: boolean
): string {
  const renderedTask = evaluator.evaluateTemplate((node.metadata.prompt as string) ?? "", context);
  const outputSchema = node.metadata.output as Record<string, unknown> | undefined;
  return buildAgentPrompt(renderedTask, outputSchema, continuation, retry);
}

/** Render the optional Agent Step session key using the workflow evaluator. */
export function renderAgentSessionKey(
  node: { metadata: Record<string, unknown> },
  context: ExpressionContext,
  evaluator: ExpressionEvaluator
): string | undefined {
  const sessionKey = node.metadata.session_key;
  if (typeof sessionKey !== "string") return undefined;
  const rendered = evaluator.evaluateTemplate(sessionKey, context);
  if (rendered.trim().length === 0) {
    throw new Error("session_key must render to a non-empty string");
  }
  return rendered;
}

/**
 * Extract a JSON value from an agent reply that may wrap JSON in prose and/or
 * Markdown code fences. Three tiers, strictest first:
 *   1. Strict fast path: parse the whole trimmed reply (pure-JSON response).
 *   2. Independent balanced scan: try every `{...}`/`[...]` candidate from each
 *      opening brace/bracket so unbalanced prose/code cannot block later JSON.
 *   3. Candidate-local jsonrepair fallback: for each later candidate, try strict
 *      parse first, then repair that same candidate before moving earlier.
 * Returns `undefined` when no JSON can be recovered (→ retryable parse failure).
 */
export function extractJson(text: string): unknown | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;

  // Tier 1: strict fast path.
  try {
    return JSON.parse(trimmed);
  } catch {
    // fall through
  }

  // Tier 2/3: latest balanced candidate wins; repair is candidate-local so a
  // malformed final answer is preferred over an earlier strict-JSON draft.
  const candidates = balancedJsonCandidates(text);
  for (let i = candidates.length - 1; i >= 0; i--) {
    const candidate = candidates[i];
    try {
      return JSON.parse(candidate);
    } catch {
      // try jsonrepair for this same candidate before moving earlier
    }
    const repaired = repairJsonCandidate(candidate);
    if (repaired !== undefined) {
      return repaired;
    }
  }

  return undefined;
}

type JsonCandidate = {
  start: number;
  end: number;
  value: string;
};

/**
 * Collect independently balanced `{...}` / `[...]` substrings from `text`.
 * Each opening brace/bracket is treated as a potential candidate start, so a
 * stray prose/code `{` cannot keep depth open and hide a later final JSON block.
 */
function balancedJsonCandidates(text: string): string[] {
  const out: JsonCandidate[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "{" && text[i] !== "[") continue;
    const end = balancedCandidateEnd(text, i);
    if (end !== undefined) {
      out.push({ start: i, end, value: text.slice(i, end) });
    }
  }

  const outer = out.filter((candidate) => !out.some((other) =>
    other !== candidate && other.start < candidate.start && candidate.end < other.end
  ));

  // Source order here is by candidate end position, not start position. This
  // keeps an outer final JSON object ahead of its nested children when iterated
  // backwards, and still lets later independent JSON blocks supersede drafts.
  outer.sort((a, b) => a.end - b.end || a.start - b.start);
  return outer.map((candidate) => candidate.value);
}

function balancedCandidateEnd(text: string, start: number): number | undefined {
  const stack = [text[start] === "{" ? "}" : "]"];
  let inString = false;
  let escaped = false;

  for (let i = start + 1; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{" || ch === "[") {
      stack.push(ch === "{" ? "}" : "]");
    } else if (ch === "}" || ch === "]") {
      if (stack.length === 0 || ch !== stack[stack.length - 1]) {
        return undefined;
      }
      stack.pop();
      if (stack.length === 0) return i + 1;
    }
  }
  return undefined;
}

function repairJsonCandidate(candidate: string): unknown | undefined {
  if (!isRepairableJsonCandidate(candidate)) return undefined;
  try {
    const repaired: unknown = JSON.parse(jsonrepair(candidate));
    if (typeof repaired === "object" && repaired !== null) return repaired;
  } catch {
    // fall through
  }
  return undefined;
}

function isRepairableJsonCandidate(candidate: string): boolean {
  const trimmed = candidate.trim();
  // Keep repair intentionally narrow. jsonrepair can turn prose snippets like
  // `[1-9]` into `["1-9"]`; in this runtime, malformed final outputs we want to
  // save are object-shaped contracts with key/value separators.
  return trimmed.startsWith("{") && trimmed.includes(":");
}
