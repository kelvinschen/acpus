import type { Readable, Writable } from "node:stream";

type TtyInput = Readable & {
  isTTY?: boolean;
  setRawMode?(mode: boolean): TtyInput;
};

type TtyOutput = Writable & {
  isTTY?: boolean;
};

export type PromptIo = {
  stdin: Readable;
  stdout: Writable;
  stderr: Writable;
};

export function canPrompt(io: PromptIo): boolean {
  const stdin = io.stdin as TtyInput;
  return stdin.isTTY === true
    && typeof stdin.setRawMode === "function"
    && (io.stdout as TtyOutput).isTTY === true
    && (io.stderr as TtyOutput).isTTY === true;
}

export function clearSubmittedSelect(output: Writable): void {
  if ((output as TtyOutput).isTTY === true) output.write("\x1b[3A\x1b[J");
}
