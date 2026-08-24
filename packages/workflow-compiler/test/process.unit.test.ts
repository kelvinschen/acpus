import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";
import { runProcess } from "../src/compiler/process.js";

describe("compile worker process", () => {
  it("retains only bounded stdout and stderr tails", async () => {
    const result = await Effect.runPromise(runProcess(process.execPath, [
      "--eval",
      `process.stdout.write("x".repeat(10_000) + "stdout-end"); process.stderr.write("y".repeat(10_000) + "stderr-end");`,
    ]));

    expect(result.ok).toBe(true);
    if (!result.ok) throw result.error;
    expect(Buffer.byteLength(result.stdoutTail)).toBeLessThanOrEqual(8 * 1024);
    expect(Buffer.byteLength(result.stderrTail)).toBeLessThanOrEqual(8 * 1024);
    expect(result.stdoutTail).toMatch(/stdout-end$/);
    expect(result.stderrTail).toMatch(/stderr-end$/);
  });
});
