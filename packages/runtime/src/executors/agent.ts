import { execa, type ResultPromise } from "execa";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { AgentSpec } from "@acpus/core";
import type { ExpressionContext, ExecutorResult } from "../types.js";
import type { ExecutorAdapter, ExecutionRequest } from "./types.js";
import { ExpressionEvaluator } from "../evaluator.js";
import { Ajv } from "ajv";
import { jsonrepair } from "jsonrepair";

/** Fixed runtime prompt used when resuming a paused agent turn. */
const CONTINUATION_PROMPT = "Continue the previous task from where you left off.";

/** Grace period (ms) to wait for a cooperative cancel before SIGKILL. */
const DEFAULT_CANCEL_GRACE_MS = 5000;

/**
 * Drives an ACP agent through the `acpx` CLI. Acpus owns scheduling/state;
 * acpx owns the ACP session lifecycle (load/resume/cancel, dead-pid recovery).
 *
 * - Session name is derived from the resolved node key (stable, unique per
 *   loop round / fanout lane / subworkflow nesting).
 * - First run: `sessions ensure` then `prompt -s <session>` with the rendered
 *   prompt; resume: same session with a fixed continuation prompt.
 * - Cancel is cooperative: on abort we run `acpx cancel -s <session>` and wait
 *   for the in-flight prompt to settle (SIGKILL only as a last resort).
 * - Output is the concatenation of `agent_message_chunk` text from the ACP
 *   NDJSON stream; the full stream is returned as `stdout` for transcript
 *   capture by the interpreter.
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

  async execute({ node, context, signal, nodeKey, resume, retry }: ExecutionRequest): Promise<ExecutorResult> {
    const agent = node.metadata.agent as AgentSpec | undefined;
    if (!agent) {
      return { failureKind: "spawn", error: `Agent step '${node.id}' has no resolved agent definition` };
    }

    const outputSchema = node.metadata.output as Record<string, unknown> | undefined;
    const cwd = this.resolveCwd(agent.cwd, context);
    const sessionName = this.sessionName(context.run_id, nodeKey);
    const env = { ...process.env, ...this.stringEnv(agent.env) };

    // Prompt text. Base is the rendered task template on a fresh first run, or a
    // fixed continuation prompt when resuming a paused turn or auto-retrying a
    // parse/schema failure. When an output schema is declared we append it as an
    // explicit contract — on the first run and on retries, but NOT on a plain
    // operator resume (the agent already has the original task in-session there).
    const renderedTask = this.evaluator.evaluateTemplate((node.metadata.prompt as string) ?? "", context);
    const prompt = buildAgentPrompt(renderedTask, outputSchema, Boolean(resume), Boolean(retry));

    if (signal.aborted) {
      return { partial: true, error: "Aborted before execution" };
    }

    const invoker = this.resolveInvoker();
    const build = this.argsBuilder(agent, cwd);

    try {
      // Ensure a saved session exists (idempotent). acpx requires a session
      // record before prompt commands route to it.
      await execa(invoker.command, [...invoker.prefixArgs, ...build([], ["sessions", "ensure", "--name", sessionName])], {
        reject: false,
        env
      });

      if (signal.aborted) {
        return { partial: true, error: "Aborted before prompt" };
      }

      // Run the prompt, streaming the ACP protocol as NDJSON.
      const promptArgs = [...invoker.prefixArgs, ...build(["--format", "json"], ["prompt", "-s", sessionName, prompt])];
      const proc = execa(invoker.command, promptArgs, { reject: false, env });

      const cancellation = this.wireCooperativeCancel(proc, signal, invoker, build, sessionName, env);

      const result = await proc;
      cancellation.cleanup();

      const stdout = result.stdout ?? "";
      const stderr = result.stderr ?? "";
      const { text, stopReason } = parseAcpStream(stdout);

      // Cooperative cancel (or any cancelled turn) → paused with partial transcript.
      if (cancellation.cancelled || stopReason === "cancelled") {
        return { partial: true, output: { text }, stdout, stderr, error: "Aborted" };
      }

      // Spawn failure (no exit code) → non-recoverable.
      if (result.failed && (result.exitCode === undefined || result.exitCode === null)) {
        return { failureKind: "spawn", error: result.shortMessage || "Failed to spawn acpx", stdout, stderr };
      }

      // Non-zero exit (and not cancelled) → non-recoverable agent failure.
      if (result.exitCode !== 0) {
        return { failureKind: "exit", exitCode: result.exitCode ?? 1, error: stderr || `acpx exited with code ${result.exitCode}`, stdout, stderr };
      }

      // Assemble structured output. When a schema is declared, extract a JSON
      // object from the (possibly prose-wrapped) reply; failure to extract is a
      // retryable parse failure. Otherwise wrap as { text }.
      let output: unknown;
      if (outputSchema) {
        const parsed = extractJson(text);
        if (parsed === undefined) {
          return { failureKind: "parse", error: "Failed to parse agent output as JSON", output: { text }, stdout, stderr };
        }
        const validate = this.ajv.compile(outputSchema);
        if (!validate(parsed)) {
          return { failureKind: "schema", error: `Output validation failed: ${this.ajv.errorsText(validate.errors)}`, output: parsed, stdout, stderr };
        }
        output = parsed;
      } else {
        output = { text };
      }

      return { exitCode: 0, output, stdout, stderr };
    } catch (error) {
      return { failureKind: "spawn", error: error instanceof Error ? error.message : String(error) };
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
    const globalBase = ["--cwd", cwd, ...(agent.model ? ["--model", agent.model] : [])];
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

  private sessionName(runId: string, nodeKey: string): string {
    return `acpus-${runId}-${sanitizeSession(nodeKey)}`;
  }

  private resolveCwd(cwd: unknown, context: ExpressionContext): string {
    if (typeof cwd === "string" && cwd.length > 0) {
      return resolve(this.evaluator.evaluateTemplate(cwd, context));
    }
    return process.cwd();
  }

  private stringEnv(env: Record<string, unknown> | undefined): Record<string, string> {
    if (!env) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(env)) out[k] = String(v);
    return out;
  }
}

/** Replace characters not safe for an acpx `-s <name>` value, reversibly enough to stay unique. */
function sanitizeSession(nodeKey: string): string {
  return nodeKey.replace(/\//g, "__").replace(/:/g, "-");
}

/** Render the declared output schema as an explicit contract section appended to the prompt. */
function schemaSection(outputSchema: Record<string, unknown>): string {
  return `\n\n# OUTPUT SCHEMA\n${JSON.stringify(outputSchema, null, 2)}`;
}

/**
 * Decide the prompt text for an agent turn:
 *   - first run        → rendered task template
 *   - operator resume  → fixed continuation prompt
 *   - parse/schema retry→ fixed continuation prompt
 * When an output schema is declared it is appended as a `# OUTPUT SCHEMA`
 * section on the first run and on retries, but NOT on a plain operator resume
 * (the original task is still live in the acpx session there).
 */
export function buildAgentPrompt(
  renderedTask: string,
  outputSchema: Record<string, unknown> | undefined,
  resume: boolean,
  retry: boolean
): string {
  const base = resume || retry ? CONTINUATION_PROMPT : renderedTask;
  return outputSchema && !(resume && !retry) ? base + schemaSection(outputSchema) : base;
}

/**
 * Parse an ACP NDJSON stream: concatenate `agent_message_chunk` text and
 * surface the final turn `stopReason`. Unparseable lines are ignored.
 */
function parseAcpStream(ndjson: string): { text: string; stopReason?: string } {
  let text = "";
  let stopReason: string | undefined;
  for (const line of ndjson.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let msg: unknown;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (typeof msg !== "object" || msg === null) continue;
    const obj = msg as Record<string, unknown>;
    const params = obj.params as Record<string, unknown> | undefined;
    const update = params?.update as Record<string, unknown> | undefined;
    if (update?.sessionUpdate === "agent_message_chunk") {
      const content = update.content as Record<string, unknown> | undefined;
      if (content?.type === "text" && typeof content.text === "string") {
        text += content.text;
      }
    }
    const result = obj.result as Record<string, unknown> | undefined;
    if (result && typeof result.stopReason === "string") {
      stopReason = result.stopReason;
    }
  }
  return { text, stopReason };
}

/**
 * Extract a JSON value from an agent reply that may wrap JSON in prose and/or
 * Markdown code fences. Three tiers, strictest first:
 *   1. Strict fast path: parse the whole trimmed reply (pure-JSON response).
 *   2. Balanced strict scan: collect every top-level balanced `{...}`/`[...]`
 *      substring (backtick fences do not affect brace pairing) and parse them
 *      from last to first, returning the last valid JSON.
 *   3. jsonrepair fallback (only after strict tiers fail, so a genuinely wrong
 *      reply still routes to a retryable parse failure): repair the last
 *      balanced candidate, or the whole reply when there is no candidate.
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

  // Tier 2: balanced strict scan, last valid JSON wins.
  const candidates = balancedJsonCandidates(text);
  for (let i = candidates.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(candidates[i]);
    } catch {
      // try the next-earlier candidate
    }
  }

  // Tier 3: jsonrepair fallback. Only a structured result (object/array)
  // counts: jsonrepair will coerce arbitrary prose into a quoted string, which
  // is not a meaningful extraction and must still route to a parse failure.
  const repairTarget = candidates.length > 0 ? candidates[candidates.length - 1] : text;
  try {
    const repaired: unknown = JSON.parse(jsonrepair(repairTarget));
    if (typeof repaired === "object" && repaired !== null) return repaired;
  } catch {
    // fall through
  }
  return undefined;
}

/**
 * Collect top-level balanced `{...}` / `[...]` substrings from `text`, ignoring
 * braces inside JSON string literals. Nested objects are absorbed into their
 * enclosing top-level candidate; only the outermost balanced spans are returned,
 * in source order.
 */
function balancedJsonCandidates(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
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
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}" || ch === "]") {
      if (depth > 0) {
        depth--;
        if (depth === 0 && start >= 0) {
          out.push(text.slice(start, i + 1));
          start = -1;
        }
      }
    }
  }
  return out;
}
