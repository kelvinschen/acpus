import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";

export const PROCESS_TREE_CLEANUP_BUDGET_MS = 5_000;

const TERM_GRACE_MS = 1_000;

export type ProcessIdentityLiveness = "match" | "absent" | "mismatch" | "unverified";
export type ProcessGroupLiveness = "live" | "dead" | "unverified";

export async function stopProcessTree(pid: number, deadline: number): Promise<boolean> {
  return (await stopProcessTreeWithDisposition(pid, deadline)).alive;
}

export async function stopProcessTreeWithDisposition(
  pid: number,
  deadline: number,
): Promise<Readonly<{
  alive: boolean;
  disposition: "cooperative" | "term" | "kill" | "unverified";
}>> {
  const initial = await processGroupLiveness(pid);
  if (initial === "dead") return { alive: false, disposition: "cooperative" };
  if (initial === "unverified") return { alive: true, disposition: "unverified" };
  terminateProcessTree(pid, "SIGTERM");
  await waitForTreeDeath(pid, Math.min(TERM_GRACE_MS, remaining(deadline)));
  if (await processGroupLiveness(pid) === "dead") return { alive: false, disposition: "term" };
  terminateProcessTree(pid, "SIGKILL");
  await waitForTreeDeath(pid, remaining(deadline));
  const liveness = await processGroupLiveness(pid);
  return { alive: liveness !== "dead", disposition: liveness === "dead" ? "kill" : "unverified" };
}

export async function matchesProcessStartToken(
  pid: number,
  expected: string | undefined,
): Promise<boolean | undefined> {
  const liveness = await processIdentityLiveness(pid, expected);
  return liveness === "match" ? true : liveness === "absent" || liveness === "mismatch" ? false : undefined;
}

export async function processIdentityLiveness(
  pid: number,
  expected: string | undefined,
): Promise<ProcessIdentityLiveness> {
  const existence = probeProcess(pid);
  if (existence === "dead") return "absent";
  if (existence === "unverified") return "unverified";
  if (expected === undefined) return "unverified";
  const actual = await processStartToken(pid);
  return actual === undefined ? "unverified" : actual === expected ? "match" : "mismatch";
}

export async function processGroupLiveness(pgid: number): Promise<ProcessGroupLiveness> {
  if (process.platform === "win32") {
    const process = probeProcess(pgid);
    return process === "alive" ? "live" : process;
  }
  return probeSignalTarget(-pgid);
}

export async function processStartToken(pid: number): Promise<string | undefined> {
  if (process.platform !== "linux") return undefined;
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    const close = stat.lastIndexOf(")");
    const fields = stat.slice(close + 2).trim().split(/\s+/u);
    const startTime = fields[19];
    return startTime ? `linux:${startTime}` : undefined;
  } catch {
    return undefined;
  }
}

function terminateProcessTree(pid: number, signal: NodeJS.Signals): void {
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(pid), "/T", ...(signal === "SIGKILL" ? ["/F"] : [])], { stdio: "ignore" }).unref();
      return;
    }
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {}
  }
}

function probeProcess(pid: number): "alive" | "dead" | "unverified" {
  const process = probeSignalTarget(pid);
  return process === "live" ? "alive" : process;
}

function probeSignalTarget(pid: number): ProcessGroupLiveness {
  try {
    process.kill(pid, 0);
    return "live";
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error
      ? (error as { code?: unknown }).code
      : undefined;
    return code === "EPERM" ? "live" : code === "ESRCH" ? "dead" : "unverified";
  }
}

async function waitForTreeDeath(pid: number, timeoutMs: number): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline && await processGroupLiveness(pid) === "live") {
    await new Promise(resolve => setTimeout(resolve, Math.min(50, Math.max(1, deadline - performance.now()))));
  }
}

function remaining(deadline: number): number {
  return Math.max(0, Math.floor(deadline - performance.now()));
}
