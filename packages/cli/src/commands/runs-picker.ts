import { emitKeypressEvents } from "node:readline";
import type { Readable, Writable } from "node:stream";
import type { RunRecord } from "@acpus/runtime";

type TtyInput = Readable & {
  isRaw?: boolean;
  isTTY?: boolean;
  setRawMode?(mode: boolean): TtyInput;
};

type TtyOutput = Writable & {
  columns?: number;
  isTTY?: boolean;
};

type Key = {
  ctrl?: boolean;
  name?: string;
};

export type RunPickerIo = {
  stdin: Readable;
  stdout: Writable;
  stderr: Writable;
};

export function canPickRun(io: RunPickerIo): boolean {
  const stdin = io.stdin as TtyInput;
  return stdin.isTTY === true
    && typeof stdin.setRawMode === "function"
    && (io.stdout as TtyOutput).isTTY === true
    && (io.stderr as TtyOutput).isTTY === true;
}

export async function pickRunId(runs: RunRecord[], io: RunPickerIo): Promise<string | undefined> {
  const input = io.stdin as TtyInput;
  const output = io.stderr as TtyOutput;
  let selected = 0;
  let renderedLines = 0;
  let settled = false;
  const wasRaw = input.isRaw === true;

  // If this grows beyond simple arrow selection, replace the stdlib TTY code with @clack/prompts.
  emitKeypressEvents(input);
  input.setRawMode?.(true);
  input.resume();
  output.write("\x1b[?25l");

  return await new Promise(resolve => {
    const finish = (runId: string | undefined): void => {
      if (settled) return;
      settled = true;
      input.off("keypress", onKeypress);
      clear();
      output.write("\x1b[?25h");
      input.setRawMode?.(wasRaw);
      input.pause();
      resolve(runId);
    };

    const onKeypress = (_text: string, key: Key): void => {
      if (key.ctrl && key.name === "c") {
        finish(undefined);
        return;
      }
      if (key.name === "escape" || key.name === "q") {
        finish(undefined);
        return;
      }
      if (key.name === "return" || key.name === "enter") {
        finish(runs[selected]?.id);
        return;
      }
      if (key.name === "up") {
        selected = selected === 0 ? runs.length - 1 : selected - 1;
        render();
        return;
      }
      if (key.name === "down") {
        selected = (selected + 1) % runs.length;
        render();
      }
    };

    function render(): void {
      clear();
      const width = terminalWidth(output);
      const lines = [
        "Select a run to inspect:",
        "",
        ...runs.map((run, index) => formatRun(run, index === selected, width)),
        "",
        "Use Up/Down to choose, Enter to inspect, q/Esc to cancel.",
      ];
      output.write(`${lines.join("\n")}\n`);
      renderedLines = lines.length;
    }

    function clear(): void {
      if (renderedLines === 0) return;
      output.write(`\x1b[${renderedLines}A\x1b[J`);
      renderedLines = 0;
    }

    input.on("keypress", onKeypress);
    render();
  });
}

function formatRun(run: RunRecord, selected: boolean, width: number): string {
  return truncate(`${selected ? ">" : " "} ${run.id} ${run.status} ${run.updatedAt} ${run.name} ${run.workflowEntry}`, width);
}

function terminalWidth(output: TtyOutput): number {
  return Math.max(20, output.columns ?? 80);
}

function truncate(text: string, width: number): string {
  if (text.length <= width) return text;
  if (width <= 3) return text.slice(0, width);
  return `${text.slice(0, width - 3)}...`;
}
