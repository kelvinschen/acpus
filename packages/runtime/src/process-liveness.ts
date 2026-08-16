import { readFileSync } from "node:fs";

export type ProcessLiveness = "alive" | "dead" | "unknown";

export type ProcessIdentity = {
  pid: number;
  startToken?: string;
};

export function captureProcessIdentity(pid: number = process.pid): ProcessIdentity {
  const startToken = readProcessStartToken(pid);
  return {
    pid,
    ...(startToken === undefined ? {} : { startToken }),
  };
}

export function probeProcessIdentity(identity: ProcessIdentity): ProcessLiveness {
  const liveness = probeProcessLiveness(identity.pid);
  if (liveness === "dead" || identity.startToken === undefined) return liveness;
  const actual = readProcessStartToken(identity.pid);
  if (actual === undefined) return "unknown";
  return actual === identity.startToken ? "alive" : "dead";
}

export function probeProcessLiveness(pid: number): ProcessLiveness {
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error
      ? (error as { code?: unknown }).code
      : undefined;
    if (code === "ESRCH") return "dead";
    return code === "EPERM" ? "alive" : "unknown";
  }
}

function readProcessStartToken(pid: number): string | undefined {
  if (process.platform !== "linux") return undefined;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = stat.lastIndexOf(")");
    const fields = stat.slice(close + 2).trim().split(/\s+/u);
    const startTime = fields[19];
    return startTime ? `linux:${startTime}` : undefined;
  } catch {
    return undefined;
  }
}
