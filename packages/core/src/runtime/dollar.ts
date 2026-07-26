import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { $ as zxDollar, within as zxWithin } from "zx/core";
import type { Options as ZxOptions, ProcessPromise } from "zx/core";

const execFileAsync = promisify(execFile);

export type CommandResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
  signal?: string;
  durationMs: number;
  command: string;
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

export type DollarOptions = {
  cwd?: string;
  env?: Record<string, string | undefined>;
  signal?: AbortSignal;
};

export function createDollar(options: DollarOptions = {}, config: DollarConfig = {}): Dollar {
  const dollar = ((arg: TemplateStringsArray | DollarConfig, ...values: unknown[]): CommandBuilder | Dollar => {
    if (!Array.isArray(arg)) return createDollar(options, { ...config, ...(arg as DollarConfig) });
    const strings = arg as TemplateStringsArray;
    const cwd = config.cwd ?? options.cwd ?? process.cwd();
    const env = config.env ?? options.env ?? process.env;
    const shell = zxDollar({
      cwd,
      env: env as Record<string, string>,
      quiet: true,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    const proc = shell(strings, ...values as any[]);
    const builder = wrapProcess(proc);
    if (config.timeout !== undefined) builder.timeout(config.timeout);
    if (config.nothrow) builder.nothrow();
    if (config.allowExitCode) builder.allowExitCode(config.allowExitCode);
    return builder;
  }) as Dollar;
  return dollar;
}

function wrapProcess(proc: ProcessPromise): CommandBuilder {
  const command = proc.cmd;
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
    timeout(duration, signal) {
      zxWithin(() => {
        // zx carries this override only into the timeout timer's async context.
        zxDollar.kill = killProcessTree;
        proc.timeout(duration, signal);
      });
      return builder as CommandBuilder;
    },
    async text() { return (await run()).stdout; },
    async json<T = unknown>() { return JSON.parse((await run()).stdout) as T; },
    async lines() { return (await run()).stdout.split(/\r?\n/).filter(Boolean); },
    [Symbol.toStringTag]: "AcpusCommandBuilder",
  };
  return builder as CommandBuilder;
}

async function killProcessTree(pid: string | number, signal: NodeJS.Signals = "SIGTERM"): Promise<void> {
  const rootPid = Number(pid);
  if (process.platform === "win32") {
    try {
      await execFileAsync("taskkill.exe", ["/PID", String(rootPid), "/T", "/F"]);
      return;
    } catch {
      killProcess(rootPid, signal);
      return;
    }
  }

  try {
    const { stdout } = await execFileAsync("ps", ["-A", "-o", "pid=,ppid="], { encoding: "utf8" });
    const children = new Map<number, number[]>();
    for (const line of stdout.split(/\r?\n/)) {
      const [child, parent] = line.trim().split(/\s+/, 2);
      const childPid = Number(child);
      const parentPid = Number(parent);
      if (!Number.isInteger(childPid) || !Number.isInteger(parentPid)) continue;
      const siblings = children.get(parentPid) ?? [];
      siblings.push(childPid);
      children.set(parentPid, siblings);
    }
    const visit = (parentPid: number): void => {
      for (const childPid of children.get(parentPid) ?? []) {
        visit(childPid);
        killProcess(childPid, signal);
      }
    };
    visit(rootPid);
  } catch {}

  try {
    process.kill(-rootPid, signal);
  } catch {
    killProcess(rootPid, signal);
  }
}

function killProcess(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch {}
}
