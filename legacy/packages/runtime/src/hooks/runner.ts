import { execa } from "execa";
import {
  parseDurationMs,
  type AgentInjectorResult,
  type EventHookHandler,
  type EventName,
  type HookConfig,
  type HookHandler,
  type InjectorHookHandler,
  type HookPayload,
  type InjectorName,
  type InjectorResult,
  type ProgramInjectorResult
} from "@acpus/core";

const DEFAULT_INJECTOR_TIMEOUT_MS = 5_000;
const DEFAULT_EVENT_TIMEOUT_MS = 30_000;

/**
 * Thrown when an injector handler fails under the `on_failure: "fail"` policy.
 * The interpreter maps this to a node failure with `failureKind: "hook_failure"`.
 */
export class HookFailureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HookFailureError";
  }
}

/** Outcome of running one handler. */
interface HandlerOutcome {
  ok: boolean;
  /** Parsed injector result (only for injectors with valid JSON output). */
  result?: InjectorResult;
  /** Diagnostic when the handler failed (non-zero exit, timeout, parse error). */
  error?: string;
}

/**
 * Executes hook command handlers. Injectors run sequentially and may fail the
 * node; events never affect outcome. The runner holds the frozen, merged
 * configuration for a single Run.
 */
export class HookRunner {
  constructor(private readonly config: HookConfig) {}

  hasInjector(name: InjectorName): boolean {
    return (this.config.injectors?.[name]?.length ?? 0) > 0;
  }

  hasEvent(name: EventName): boolean {
    return (this.config.events?.[name]?.length ?? 0) > 0;
  }

  injectorHandlers(name: InjectorName): InjectorHookHandler[] {
    return this.config.injectors?.[name] ?? [];
  }

  /**
   * Run all handlers for an injector sequentially, merging their results.
   * `prependPrompt` is concatenated in order for beforeAgentExec; `env` maps
   * merge with later handlers overriding earlier ones for beforeProgramExec.
   * A failing handler under `fail` throws
   * HookFailureError; under `skip` it logs a warning and injects nothing.
   *
   * `onHandler` is called once per handler with the resolved per-handler result
   * (for journaling).
   */
  async runInjector(
    name: InjectorName,
    payload: HookPayload,
    onHandler?: (handlerIndex: number, result: InjectorResult, durationMs: number) => void
  ): Promise<InjectorResult> {
    const handlers = this.injectorHandlers(name);
    const contexts: string[] = [];
    let env: Record<string, string> | undefined;

    for (let i = 0; i < handlers.length; i++) {
      const handler = handlers[i];
      const started = Date.now();
      const outcome = await this.runHandler(handler, payload, DEFAULT_INJECTOR_TIMEOUT_MS, true);
      const durationMs = Date.now() - started;

      if (!outcome.ok) {
        const policy = handler.on_failure ?? "fail";
        if (policy === "fail") {
          throw new HookFailureError(`Injector '${name}' handler #${i} failed: ${outcome.error ?? "unknown error"}`);
        }
        console.warn(`Injector '${name}' handler #${i} failed (skipped): ${outcome.error ?? "unknown error"}`);
        onHandler?.(i, {}, durationMs);
        continue;
      }

      const result = outcome.result ?? {};
      if (name === "beforeAgentExec") {
        const agentResult = result as AgentInjectorResult;
        if (typeof agentResult.prependPrompt === "string" && agentResult.prependPrompt.length > 0) {
          contexts.push(agentResult.prependPrompt);
        }
      }
      if (name === "beforeProgramExec") {
        const programResult = result as ProgramInjectorResult;
        if (programResult.env && Object.keys(programResult.env).length > 0) {
          env = { ...(env ?? {}), ...programResult.env };
        }
      }
      onHandler?.(i, result, durationMs);
    }

    if (name === "beforeAgentExec") {
      const merged: AgentInjectorResult = {};
      if (contexts.length > 0) merged.prependPrompt = contexts.join("\n");
      return merged;
    }
    const merged: ProgramInjectorResult = {};
    if (env) merged.env = env;
    return merged;
  }

  /**
   * Fire all handlers for an event. Event handlers are async by default;
   * `sync: true` handlers are awaited. Event handlers never throw and never
   * affect Run/Node outcome — failures are logged as warnings.
   */
  async emitEvent(name: EventName, payload: HookPayload): Promise<void> {
    const handlers: EventHookHandler[] = this.config.events?.[name] ?? [];
    for (let i = 0; i < handlers.length; i++) {
      const handler = handlers[i];
      const run = this.runHandler(handler, payload, DEFAULT_EVENT_TIMEOUT_MS, false)
        .then((outcome) => {
          if (!outcome.ok) {
            console.warn(`Event '${name}' handler #${i} failed (ignored): ${outcome.error ?? "unknown error"}`);
          }
        })
        .catch((error: unknown) => {
          console.warn(`Event '${name}' handler #${i} threw (ignored): ${error instanceof Error ? error.message : String(error)}`);
        });
      if (handler.sync) await run;
    }
  }

  /** Dispatch a single command handler. `parseResult` only for injectors. */
  private async runHandler(
    handler: HookHandler,
    payload: HookPayload,
    defaultTimeoutMs: number,
    parseResult: boolean
  ): Promise<HandlerOutcome> {
    const timeoutMs = handler.timeout ? parseDurationMs(handler.timeout) || defaultTimeoutMs : defaultTimeoutMs;
    return this.runCommand(handler, payload, timeoutMs, parseResult);
  }

  private async runCommand(
    handler: HookHandler,
    payload: HookPayload,
    timeoutMs: number,
    parseResult: boolean
  ): Promise<HandlerOutcome> {
    try {
      const result = await execa(handler.command, {
        shell: true,
        cwd: handler.cwd ?? process.cwd(),
        timeout: timeoutMs > 0 ? timeoutMs : undefined,
        reject: false,
        input: JSON.stringify(payload),
        env: handler.env
          ? { ...(Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== undefined)) as Record<string, string>), ...handler.env }
          : undefined
      });
      if (result.timedOut) {
        return { ok: false, error: `timed out after ${timeoutMs}ms` };
      }
      if ((result.exitCode ?? 0) !== 0) {
        return { ok: false, error: `exit code ${result.exitCode}: ${stderrTail(result.stderr)}` };
      }
      if (!parseResult) return { ok: true };
      return this.parseInjectorStdout(result.stdout ?? "");
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /** Parse handler stdout as an InjectorResult. Empty output → empty result. */
  private parseInjectorStdout(raw: string): HandlerOutcome {
    const trimmed = raw.trim();
    if (trimmed.length === 0) return { ok: true, result: {} };
    try {
      const parsed = JSON.parse(trimmed) as InjectorResult;
      return { ok: true, result: parsed ?? {} };
    } catch {
      return { ok: false, error: "stdout is not valid JSON" };
    }
  }
}

/** Last few lines of stderr for a concise failure summary. */
function stderrTail(stderr: string | undefined): string {
  if (!stderr) return "";
  return stderr.replace(/\s+$/u, "").split(/\r?\n/u).slice(-5).join("\n");
}
