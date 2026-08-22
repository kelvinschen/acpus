import { makeNodeProcessHost } from "@acpus/owned-process";
import type { OwnedProcessError, ProcessHostShape } from "@acpus/owned-process";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";

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
      error: OwnedProcessError;
      stdoutTail: string;
      stderrTail: string;
    };

export function runProcess(
  command: string,
  args: string[],
  options: { cwd?: string } = {},
  processes: ProcessHostShape = makeNodeProcessHost(),
): Effect.Effect<ProcessResult> {
  return Effect.scoped(Effect.gen(function* () {
    const stdoutTail = yield* Ref.make<Buffer<ArrayBufferLike>>(Buffer.alloc(0));
    const stderrTail = yield* Ref.make<Buffer<ArrayBufferLike>>(Buffer.alloc(0));
    const settled = yield* Effect.result(Effect.gen(function* () {
      const child = yield* processes.spawn({
        command,
        args,
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      const [, , exit] = yield* Effect.all([
        Stream.runForEach(child.stdout, chunk => Ref.update(stdoutTail, current => appendTail(current, Buffer.from(chunk)))),
        Stream.runForEach(child.stderr, chunk => Ref.update(stderrTail, current => appendTail(current, Buffer.from(chunk)))),
        child.closed,
      ], { concurrency: "unbounded" });
      return exit;
    }));
    const stdout = (yield* Ref.get(stdoutTail)).toString("utf8");
    const stderr = (yield* Ref.get(stderrTail)).toString("utf8");
    return Result.match(settled, {
      onSuccess: ({ exitCode, signal }) => ({ ok: true as const, exitCode, signal, stdoutTail: stdout, stderrTail: stderr }),
      onFailure: error => ({ ok: false as const, error, stdoutTail: stdout, stderrTail: stderr }),
    });
  }));
}

function appendTail(current: Buffer<ArrayBufferLike>, chunk: Buffer<ArrayBufferLike>): Buffer<ArrayBufferLike> {
  if (chunk.length >= OUTPUT_TAIL_LIMIT) return chunk.subarray(chunk.length - OUTPUT_TAIL_LIMIT);
  const keep = Math.min(current.length, OUTPUT_TAIL_LIMIT - chunk.length);
  return Buffer.concat([current.subarray(current.length - keep), chunk]);
}
