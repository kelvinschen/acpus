import { describe, expect, it } from "vitest";
import { clearTerminalViewport } from "../src/index.js";

function fakeStdout(isTTY: boolean): NodeJS.WriteStream {
  const writes: string[] = [];
  return {
    isTTY,
    writes,
    write(chunk: string) {
      writes.push(chunk);
      return true;
    }
  } as unknown as NodeJS.WriteStream;
}

describe("clearTerminalViewport", () => {
  it("clears TTY output and leaves non-TTY output untouched", () => {
    const tty = fakeStdout(true);
    expect(clearTerminalViewport(tty)).toBe(true);
    expect((tty as unknown as { writes: string[] }).writes).toEqual(["\x1b[2J\x1b[H"]);

    const pipe = fakeStdout(false);
    expect(clearTerminalViewport(pipe)).toBe(false);
    expect((pipe as unknown as { writes: string[] }).writes).toEqual([]);
  });
});
