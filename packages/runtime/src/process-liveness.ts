import {
  captureProcessIdentity as captureOwnedProcessIdentity,
  probeProcessIdentity as probeOwnedProcessIdentity,
  probeProcessTarget,
  type ProcessIdentity,
  type ProcessLiveness as OwnedProcessLiveness,
} from "@acpus/owned-process";

export type ProcessLiveness = "alive" | "dead" | "unknown";

export type { ProcessIdentity } from "@acpus/owned-process";

export function captureProcessIdentity(pid: number = process.pid): ProcessIdentity {
  return captureOwnedProcessIdentity(pid);
}

export function probeProcessIdentity(identity: ProcessIdentity): ProcessLiveness {
  if (identity.startToken === undefined) return probeProcessLiveness(identity.pid);
  const liveness = probeOwnedProcessIdentity(identity);
  return liveness === "match"
    ? "alive"
    : liveness === "absent" || liveness === "mismatch"
      ? "dead"
      : "unknown";
}

function probeProcessLiveness(pid: number): ProcessLiveness {
  return runtimeLiveness(probeProcessTarget({ pid }));
}

function runtimeLiveness(liveness: OwnedProcessLiveness): ProcessLiveness {
  return liveness === "live" ? "alive" : liveness === "dead" ? "dead" : "unknown";
}
