import { createHash } from "node:crypto";
import { $ as zxDollar, quote as zxQuote } from "zx/core";
import { TASK } from "./internal.js";
import type { JsonObject, TaskBundleIR } from "./ir.js";
import type { ArtifactRef, InferSchema, Schema } from "./schema.js";

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

export type CommandBuilder = Promise<CommandResult> & {
  allowExitCode(codes: number[]): CommandBuilder;
  nothrow(): CommandBuilder;
  timeout(duration: string): CommandBuilder;
  env(values: Record<string, string | undefined>): CommandBuilder;
  cwd(path: string): CommandBuilder;
  text(): Promise<string>;
  json<T = unknown>(): Promise<T>;
  lines(): Promise<string[]>;
};

export type RawShellFragment = {
  readonly kind: "raw_shell_fragment";
  readonly value: string;
};

export type CommandOptions = {
  cwd?: string;
  env?: Record<string, string | undefined>;
  allowExitCode?: number[];
  timeout?: string;
};

export type Dollar = {
  (strings: TemplateStringsArray, ...values: unknown[]): CommandBuilder;
  cmd(exe: string, args?: string[], options?: CommandOptions): CommandBuilder;
  shell(strings: TemplateStringsArray, ...values: unknown[]): CommandBuilder;
  raw(value: string): RawShellFragment;
};

export type ArtifactApi = {
  writeText(name: string, content: string, options?: { mediaType?: string }): Promise<ArtifactRef>;
  writeJson(name: string, value: unknown): Promise<ArtifactRef>;
  writeBytes(name: string, value: Uint8Array, options?: { mediaType?: string }): Promise<ArtifactRef>;
  fromFile(path: string, options?: { name?: string; mediaType?: string }): Promise<ArtifactRef>;
};

export type LogApi = {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
};

export type TaskRuntime = {
  runId: string;
  nodeId: string;
  nodeKey: string;
  attempt: number;
  workDir: string;
  outputDir: string;
};

export type CommandSpan = {
  command: string;
  startedAt: string;
  endedAt?: string;
  exitCode?: number;
  durationMs?: number;
};

export type TaskContext<Input, Params extends JsonObject = JsonObject> = {
  input: Input;
  params: Params;
  $: Dollar;
  artifact: ArtifactApi;
  log: LogApi;
  env: Record<string, string>;
  runtime: TaskRuntime;
  signal: AbortSignal;
};

export type TaskFunction<Input, Output, Params extends JsonObject = JsonObject> = (ctx: TaskContext<Input, Params>) => Promise<Output> | Output;

export type TaskToken<Input = any, Output = any, Params extends JsonObject = JsonObject> = {
  readonly [TASK]: true;
  readonly kind: "inline" | "external";
  readonly input?: Schema<Input>;
  readonly output?: Schema<Output>;
  readonly params?: Params;
  readonly fn: TaskFunction<Input, Output, Params>;
  readonly source: string;
  readonly bundleId: string;
  readonly digest: string;
  toBundleIR(): TaskBundleIR;
};

export type DollarOptions = {
  cwd?: string;
  env?: Record<string, string | undefined>;
  onSpan?: (span: CommandSpan) => void;
  redact?: (text: string) => string;
};

/**
 * Creates the Acpus-observed zx runner. This is intentionally not a permission
 * gate. It preserves zx ergonomics while giving Acpus a single place to attach
 * spans, timeout/abort integration, stdout/stderr artifact capture, and redaction.
 */
export function createDollar(options: DollarOptions = {}): Dollar {
  const run = (strings: TemplateStringsArray, ...values: unknown[]): CommandBuilder => {
    const startedAt = new Date().toISOString();
    const command = renderCommand(strings, values, options.redact);
    const span: CommandSpan = { command, startedAt };
    options.onSpan?.(span);
    const proc = zxDollar(strings, ...values as any[]);
    if (options.cwd && typeof (proc as any).cwd === "function") (proc as any).cwd(options.cwd);
    if (options.env && typeof (proc as any).env === "function") (proc as any).env(options.env);
    return wrapProcess(proc, command, span, options);
  };
  const dollar = run as Dollar;
  dollar.cmd = (exe: string, args: string[] = [], commandOptions: CommandOptions = {}) => {
    const command = [exe, ...args].map(x => zxQuote(x)).join(" ");
    const fake = [command] as unknown as TemplateStringsArray;
    const builder = run(fake);
    if (commandOptions.timeout) builder.timeout(commandOptions.timeout);
    if (commandOptions.cwd) builder.cwd(commandOptions.cwd);
    if (commandOptions.env) builder.env(commandOptions.env);
    if (commandOptions.allowExitCode) return builder.allowExitCode(commandOptions.allowExitCode);
    return builder;
  };
  dollar.shell = run;
  dollar.raw = (value: string) => ({ kind: "raw_shell_fragment" as const, value });
  return dollar;
}

function wrapProcess(proc: any, command: string, span: CommandSpan, _options: DollarOptions): CommandBuilder {
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
    nothrow() { nothrow = true; return builder as CommandBuilder; },
    timeout(duration: string) { if (typeof proc.timeout === "function") proc.timeout(duration); return builder as CommandBuilder; },
    env(values: Record<string, string | undefined>) { if (typeof proc.env === "function") proc.env(values); return builder as CommandBuilder; },
    cwd(path: string) { if (typeof proc.cwd === "function") proc.cwd(path); return builder as CommandBuilder; },
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
    if (i < values.length) {
      const value = values[i] as any;
      out += value && value.kind === "raw_shell_fragment" ? value.value : zxQuote(String(value));
    }
  }
  return redact ? redact(out) : out;
}

function digest(source: string): string {
  return `sha256:${createHash("sha256").update(source).digest("hex")}`;
}

function makeTaskToken<Input, Output, Params extends JsonObject>(args: {
  kind: "inline" | "external";
  input?: Schema<Input>;
  output?: Schema<Output>;
  params?: Params;
  fn: TaskFunction<Input, Output, Params>;
  sourcePrefix?: string;
}): TaskToken<Input, Output, Params> {
  const source = `${args.sourcePrefix ?? ""}${args.fn.toString()}`;
  const hash = digest(source);
  const bundleId = `task_${hash.slice("sha256:".length, "sha256:".length + 16)}`;
  return {
    [TASK]: true as const,
    kind: args.kind,
    input: args.input,
    output: args.output,
    params: args.params,
    fn: args.fn,
    source,
    digest: hash,
    bundleId,
    toBundleIR() {
      return {
        id: bundleId,
        digest: hash,
        runtime: "node",
        source,
        inline: args.kind === "inline",
        note: "Core-alpha records Function#toString as a task source placeholder. Production must AST-extract and bundle task functions.",
      };
    },
  } as TaskToken<Input, Output, Params>;
}

export interface TaskFactory {
  <Output>(fn: TaskFunction<any, Output, any>): TaskToken<any, Output, any>;
  withParams<const Params extends JsonObject>(params: Params): <Output>(fn: TaskFunction<any, Output, Params>) => TaskToken<any, Output, Params>;
  define<InputSchema extends Schema<any>, OutputSchema extends Schema<any>>(config: { input: InputSchema; output: OutputSchema }): {
    input: InputSchema;
    output: OutputSchema;
    run(fn: TaskFunction<InferSchema<InputSchema>, InferSchema<OutputSchema>>): TaskToken<InferSchema<InputSchema>, InferSchema<OutputSchema>>;
  };
  isToken(value: unknown): value is TaskToken<any, any, any>;
}

export const task: TaskFactory = Object.assign(
  function task<Output>(fn: TaskFunction<any, Output, any>): TaskToken<any, Output, any> {
    return makeTaskToken({ kind: "inline", fn });
  },
  {
    withParams<const Params extends JsonObject>(params: Params) {
      return function withParams<Output>(fn: TaskFunction<any, Output, Params>): TaskToken<any, Output, Params> {
        return makeTaskToken({ kind: "inline", fn, params, sourcePrefix: JSON.stringify(params) });
      };
    },
    define<InputSchema extends Schema<any>, OutputSchema extends Schema<any>>(config: { input: InputSchema; output: OutputSchema }) {
      type Input = InferSchema<InputSchema>;
      type Output = InferSchema<OutputSchema>;
      return {
        input: config.input,
        output: config.output,
        run(fn: TaskFunction<Input, Output>): TaskToken<Input, Output> {
          return makeTaskToken({ kind: "external", input: config.input, output: config.output, fn });
        },
      };
    },
    isToken(value: unknown): value is TaskToken<any, any, any> {
      return Boolean(value && typeof value === "object" && (value as any)[TASK]);
    },
  },
);

export const defineTask = task.define;
