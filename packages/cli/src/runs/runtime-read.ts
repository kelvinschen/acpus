import type { RuntimeReadFailure } from "@acpus/runtime";

export function runtimeReadFailureCode(failure: RuntimeReadFailure): string {
  return failure.type.replaceAll("-", "_").toUpperCase();
}

export function runtimeReadFailureMessage(failure: RuntimeReadFailure): string {
  if (failure.type === "runtime-store-repair-required") {
    return `${failure.message}\nRun: acpus doctor --fix`;
  }
  if (failure.type === "runtime-store-unsupported") {
    return `${failure.message}\nRun: acpus doctor`;
  }
  return `${failure.message}\nRun: acpus doctor`;
}
