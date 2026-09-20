import { AsyncLocalStorage } from "node:async_hooks";
import { homedir } from "node:os";
import { isAbsolute, join, normalize } from "node:path";

const homeContext = new AsyncLocalStorage<string>();

export class AcpusHomeError extends Error {
  readonly type = "acpus-home-invalid";
}

/** Resolve the data root without creating it or changing the OS user home. */
export function resolveAcpusHome(value = homeContext.getStore() ?? process.env.ACPUS_HOME, userHome = homedir()): string {
  if (value === undefined) return join(userHome, ".acpus");
  if (!value.trim() || !isAbsolute(value)) {
    throw new AcpusHomeError("ACPUS_HOME must be a nonempty absolute directory path (expand ~ before setting it).");
  }
  return normalize(value);
}

/** Executable/SDK adapters capture one Home for all work they launch. */
export function withAcpusHome<A>(home: string, action: () => A): A {
  return homeContext.run(resolveAcpusHome(home), action);
}
