import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";

export const PROCESS_TREE_CLEANUP_BUDGET_MS = 5_000;

const TERM_GRACE_MS = 1_000;

export async function stopProcessTree(pid: number, deadline: number): Promise<boolean> {
  if (!await treeAlive(pid)) return false;
  terminateProcessTree(pid, "SIGTERM");
  await waitForTreeDeath(pid, Math.min(TERM_GRACE_MS, remaining(deadline)));
  if (!await treeAlive(pid)) return false;
  terminateProcessTree(pid, "SIGKILL");
  await waitForTreeDeath(pid, remaining(deadline));
  return await treeAlive(pid);
}

export async function matchesProcessStartToken(
  pid: number,
  expected: string | undefined,
): Promise<boolean | undefined> {
  if (expected === undefined) return await processAlive(pid) ? undefined : false;
  const actual = await processStartToken(pid);
  if (actual === undefined) return await processAlive(pid) ? undefined : false;
  return actual === expected;
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

async function processAlive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error
      ? (error as { code?: unknown }).code
      : undefined;
    return code === "EPERM";
  }
}

async function treeAlive(pid: number): Promise<boolean> {
  if (process.platform === "win32") return processAlive(pid);
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error
      ? (error as { code?: unknown }).code
      : undefined;
    return code === "EPERM";
  }
}

async function waitForTreeDeath(pid: number, timeoutMs: number): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline && await treeAlive(pid)) {
    await new Promise(resolve => setTimeout(resolve, Math.min(50, Math.max(1, deadline - performance.now()))));
  }
}

function remaining(deadline: number): number {
  return Math.max(0, Math.floor(deadline - performance.now()));
}
