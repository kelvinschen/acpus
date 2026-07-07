import type { Readable, Writable } from "node:stream";
import { confirm, isCancel, multiselect, select } from "@clack/prompts";
import type { RunRecord } from "@acpus/runtime";

type TtyInput = Readable & {
  isTTY?: boolean;
  setRawMode?(mode: boolean): TtyInput;
};

type TtyOutput = Writable & {
  isTTY?: boolean;
};

export type RunPickerIo = {
  stdin: Readable;
  stdout: Writable;
  stderr: Writable;
};

export type DeleteRunChoice = {
  run: RunRecord;
  disabled?: boolean;
  hint?: string;
};

export type DeleteRunSelection = {
  runIds: string[];
  selectedAll: boolean;
};

const allDeletableRunsValue = "__acpus_all_deletable_runs__";

export function canPickRun(io: RunPickerIo): boolean {
  const stdin = io.stdin as TtyInput;
  return stdin.isTTY === true
    && typeof stdin.setRawMode === "function"
    && (io.stdout as TtyOutput).isTTY === true
    && (io.stderr as TtyOutput).isTTY === true;
}

export async function pickRunId(runs: RunRecord[], io: RunPickerIo): Promise<string | undefined> {
  const picked = await select({
    message: "Select a run to inspect:",
    options: runs.map(run => ({
      value: run.id,
      label: formatRunLabel(run),
      hint: formatRunHint(run),
    })),
    input: io.stdin,
    output: io.stderr,
  });
  if (isCancel(picked)) return undefined;
  clearSubmittedSelect(io.stderr);
  return picked;
}

export async function pickRunsToDelete(choices: DeleteRunChoice[], io: RunPickerIo): Promise<DeleteRunSelection | undefined> {
  const deletable = choices.filter(choice => choice.disabled !== true).map(choice => choice.run.id);
  const picked = await multiselect({
    message: "Select runs to delete:",
    required: true,
    options: [
      {
        value: allDeletableRunsValue,
        label: "All deletable runs",
        hint: `${deletable.length} runs`,
        disabled: deletable.length === 0,
      },
      ...choices.map(choice => ({
        value: choice.run.id,
        label: formatRunLabel(choice.run),
        hint: choice.hint ? `${choice.hint} · ${formatRunHint(choice.run)}` : formatRunHint(choice.run),
        ...(choice.disabled === true ? { disabled: true } : {}),
      })),
    ],
    input: io.stdin,
    output: io.stderr,
  });
  if (isCancel(picked)) return undefined;
  const selectedAll = picked.includes(allDeletableRunsValue);
  return { runIds: selectedAll ? deletable : picked, selectedAll };
}

export async function confirmDelete(count: number, io: RunPickerIo): Promise<boolean | undefined> {
  const confirmed = await confirm({
    message: `Delete ${count} ${count === 1 ? "run" : "runs"}?`,
    initialValue: false,
    input: io.stdin,
    output: io.stderr,
  });
  return isCancel(confirmed) ? undefined : confirmed;
}

function formatRunLabel(run: RunRecord): string {
  return run.id;
}

function formatRunHint(run: RunRecord): string {
  return `${run.status} · ${run.name} · ${formatUpdatedAt(run.updatedAt)}`;
}

function formatUpdatedAt(updatedAt: string): string {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(updatedAt);
  return match ? `${match[1]} ${match[2]}` : updatedAt;
}

function clearSubmittedSelect(output: Writable): void {
  if ((output as TtyOutput).isTTY === true) output.write("\x1b[3A\x1b[J");
}
