import type { CliResult, CliUnappliedControl, ResultPhase } from "./output.js";

export class CliError extends Error {
  constructor(
    readonly exitCode: number,
    readonly result: CliResult & { ok: false; phase: ResultPhase },
  ) {
    super(result.message);
  }
}

export function usageError(message: string): CliError {
  return new CliError(2, { ok: false, phase: "usage", message });
}

export function notFoundError(
  message: string,
  details: Pick<CliResult, "errorCode" | "inspectionError"> = {},
): CliError {
  return new CliError(1, { ok: false, phase: "inspect", message, ...details });
}

export function validationError(message: string): CliError {
  return new CliError(1, { ok: false, phase: "validate", message });
}

export function importError(message: string, details: Pick<CliResult, "errorCode"> = {}): CliError {
  return new CliError(1, { ok: false, phase: "import", message, ...details });
}

export function runError(message: string, details: Pick<CliResult, "errorCode" | "run"> = {}): CliError {
  return new CliError(1, { ok: false, phase: "run", message, ...details });
}

export function controlError(message: string, details: Pick<CliResult, "errorCode" | "run"> & { control?: CliUnappliedControl } = {}): CliError {
  return new CliError(1, { ok: false, phase: "control", message, ...details });
}

export function deleteError(message: string, details: Pick<CliResult, "errorCode" | "run"> = {}): CliError {
  return new CliError(1, { ok: false, phase: "delete", message, ...details });
}

export function vizError(message: string): CliError {
  return new CliError(1, { ok: false, phase: "viz", message });
}

export function skillError(message: string, details: Pick<CliResult, "skill" | "errorCode"> = {}): CliError {
  return new CliError(1, { ok: false, phase: "skill", message, ...details });
}
