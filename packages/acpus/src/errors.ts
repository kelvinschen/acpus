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

export function runtimeUnavailableError(): CliError {
  return usageError("Runtime scheduler is not implemented yet. Use --dry-run to typecheck, compile, and validate the workflow.");
}
