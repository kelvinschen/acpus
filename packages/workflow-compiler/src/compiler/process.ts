import { spawn } from "node:child_process";

const OUTPUT_TAIL_LIMIT = 8 * 1024;

export type ProcessResult =
  | {
      ok: true;
      exitCode: number | null;
      signal: NodeJS.Signals | null;
      stdoutTail: string;
      stderrTail: string;
    }
  | {
      ok: false;
      error: NodeJS.ErrnoException;
      stdoutTail: string;
      stderrTail: string;
    };

export async function runProcess(command: string, args: string[], options: { cwd?: string } = {}): Promise<ProcessResult> {
  return new Promise(resolveProcess => {
    let child;
    try {
      child = spawn(command, args, { cwd: options.cwd, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      resolveProcess({
        ok: false,
        error: asErrnoError(error),
        stdoutTail: "",
        stderrTail: "",
      });
      return;
    }

    let stdoutTail: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let stderrTail: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let settled = false;
    child.stdout.on("data", chunk => {
      stdoutTail = appendTail(stdoutTail, Buffer.from(chunk));
    });
    child.stderr.on("data", chunk => {
      stderrTail = appendTail(stderrTail, Buffer.from(chunk));
    });
    child.on("close", (exitCode, signal) => {
      if (settled) return;
      settled = true;
      resolveProcess({
        ok: true,
        exitCode,
        signal,
        stdoutTail: stdoutTail.toString("utf8"),
        stderrTail: stderrTail.toString("utf8"),
      });
    });
    child.on("error", error => {
      if (settled) return;
      settled = true;
      resolveProcess({
        ok: false,
        error,
        stdoutTail: stdoutTail.toString("utf8"),
        stderrTail: stderrTail.toString("utf8"),
      });
    });
  });
}

function appendTail(current: Buffer<ArrayBufferLike>, chunk: Buffer<ArrayBufferLike>): Buffer<ArrayBufferLike> {
  if (chunk.length >= OUTPUT_TAIL_LIMIT) return chunk.subarray(chunk.length - OUTPUT_TAIL_LIMIT);
  const keep = Math.min(current.length, OUTPUT_TAIL_LIMIT - chunk.length);
  return Buffer.concat([current.subarray(current.length - keep), chunk]);
}

function asErrnoError(error: unknown): NodeJS.ErrnoException {
  return error instanceof Error ? error : new Error(String(error));
}
