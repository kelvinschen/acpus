import { $ as zxDollar, quote as zxQuote } from "zx/core";
import type { Options as ZxOptions, ProcessPromise } from "zx/core";
import type { ArtifactRef } from "./task-context.js";

export type CommandResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
  signal?: string;
  durationMs: number;
  command: string;
  stdoutArtifact?: ArtifactRef;
  stderrArtifact?: ArtifactRef;
};

type ZxReaders = Pick<ProcessPromise, "text" | "json" | "lines">;

type ZxChain = {
  [K in "nothrow" | "timeout"]: (...args: Parameters<ProcessPromise[K]>) => CommandBuilder;
};

export type CommandBuilder = Promise<CommandResult> & ZxReaders & ZxChain & {
  allowExitCode(codes: number[]): CommandBuilder;
};

export type DollarConfig = Partial<Pick<ZxOptions, "cwd" | "env" | "timeout" | "nothrow">> & {
  allowExitCode?: number[];
};

export type Dollar = {
  (strings: TemplateStringsArray, ...values: unknown[]): CommandBuilder;
  (config: DollarConfig): Dollar;
};

export type CommandSpan = {
  command: string;
  startedAt: string;
  endedAt?: string;
  exitCode?: number;
  durationMs?: number;
};

export type DollarOptions = {
  cwd?: string;
  env?: Record<string, string | undefined>;
  onSpan?: (span: CommandSpan) => void;
  redact?: (text: string) => string;
};

export function createDollar(options: DollarOptions = {}, config: DollarConfig = {}): Dollar {
  const dollar = ((arg: TemplateStringsArray | DollarConfig, ...values: unknown[]): CommandBuilder | Dollar => {
    if (!Array.isArray(arg)) return createDollar(options, { ...config, ...(arg as DollarConfig) });
    const strings = arg as TemplateStringsArray;
    const startedAt = new Date().toISOString();
    const command = renderCommand(strings, values, options.redact);
    const span: CommandSpan = { command, startedAt };
    options.onSpan?.(span);
    const cwd = config.cwd ?? options.cwd;
    const env = config.env ?? options.env;
    const shell = cwd || env ? zxDollar({ ...(cwd ? { cwd } : {}), ...(env ? { env: env as Record<string, string> } : {}) }) : zxDollar;
    const proc = shell(strings, ...values as any[]);
    const builder = wrapProcess(proc, command, span);
    if (config.timeout !== undefined) builder.timeout(config.timeout);
    if (config.nothrow) builder.nothrow();
    if (config.allowExitCode) builder.allowExitCode(config.allowExitCode);
    return builder;
  }) as Dollar;
  return dollar;
}

function wrapProcess(proc: any, command: string, span: CommandSpan): CommandBuilder {
  let allowCodes: number[] | undefined;
  let nothrow = false;
  let promise: Promise<CommandResult> | undefined;

  const run = async (): Promise<CommandResult> => {
    if (promise) return promise;
    promise = (async () => {
      const started = Date.now();
      const p = allowCodes || nothrow ? proc.nothrow() : proc;
      const out = await p;
      const exitCode = Number(out.exitCode ?? 0);
      const durationMs = Date.now() - started;
      span.endedAt = new Date().toISOString();
      span.exitCode = exitCode;
      span.durationMs = durationMs;
      if (allowCodes && !allowCodes.includes(exitCode)) {
        throw new Error(`Command exited with ${exitCode}; expected one of ${allowCodes.join(", ")}: ${command}`);
      }
      const result: CommandResult = {
        stdout: String(out.stdout ?? ""),
        stderr: String(out.stderr ?? ""),
        exitCode,
        durationMs,
        command,
      };
      if (out.signal !== undefined && out.signal !== null) result.signal = String(out.signal);
      return result;
    })();
    return promise;
  };

  const builder: Partial<CommandBuilder> = {
    then: ((onfulfilled: any, onrejected: any) => run().then(onfulfilled, onrejected)) as any,
    catch: ((onrejected: any) => run().catch(onrejected)) as any,
    finally: ((onfinally: any) => run().finally(onfinally)) as any,
    allowExitCode(codes: number[]) { allowCodes = codes; return builder as CommandBuilder; },
    nothrow(v = true) { nothrow = v; return builder as CommandBuilder; },
    timeout(duration, signal) { if (typeof proc.timeout === "function") proc.timeout(duration, signal); return builder as CommandBuilder; },
    async text() { return (await run()).stdout; },
    async json<T = unknown>() { return JSON.parse((await run()).stdout) as T; },
    async lines() { return (await run()).stdout.split(/\r?\n/).filter(Boolean); },
    [Symbol.toStringTag]: "AcpusCommandBuilder",
  };
  return builder as CommandBuilder;
}

function renderCommand(strings: TemplateStringsArray, values: unknown[], redact?: (text: string) => string): string {
  let out = "";
  for (let i = 0; i < strings.length; i += 1) {
    out += strings[i] ?? "";
    if (i < values.length) out += zxQuote(String(values[i]));
  }
  return redact ? redact(out) : out;
}
