import type { CliResult, ResultPhase } from "./output.js";

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

export function notFoundError(message: string): CliError {
  return new CliError(1, { ok: false, phase: "inspect", message });
}

export function validationError(message: string): CliError {
  return new CliError(1, { ok: false, phase: "validate", message });
}

export function controlError(message: string): CliError {
  return new CliError(1, { ok: false, phase: "control", message });
}
