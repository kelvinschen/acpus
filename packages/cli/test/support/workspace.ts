import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getRuntimeHealth, requestDaemonShutdown } from "@acpus/runtime";
import { setRuntimeHomeForTest } from "../../../runtime/src/runtime-layout.js";
import { registerTestProcessHome, repoRoot } from "./cli-runner.js";

export async function withTestWorkspace<T>(
  name: string,
  fn: (workspace: string, home: string) => Promise<T>,
): Promise<T> {
  const root = join(repoRoot, ".tmp-tests");
  await mkdir(root, { recursive: true });
  const workspace = await mkdtemp(join(root, `${name}-`));
  const home = await mkdtemp(join(root, `${name}-home-`));
  const restoreRuntimeHome = setRuntimeHomeForTest(workspace, join(home, ".acpus"));
  const restoreProcessHome = registerTestProcessHome(workspace, home);
  try {
    await symlink(join(repoRoot, "node_modules"), join(workspace, "node_modules"), "dir");
    await linkWorkspaceCore(workspace);
    await writeWorkspaceTsconfig(workspace);
    return await fn(workspace, home);
  } finally {
    await stopWorkspaceDaemon(workspace);
    restoreProcessHome();
    restoreRuntimeHome();
    await Promise.all([
      rm(workspace, { recursive: true, force: true }),
      rm(home, { recursive: true, force: true }),
    ]);
  }
}

async function writeWorkspaceTsconfig(workspace: string): Promise<void> {
  await writeFile(join(workspace, "tsconfig.json"), `${JSON.stringify({
    compilerOptions: {
      target: "ES2022",
      lib: ["ES2022"],
      module: "NodeNext",
      moduleResolution: "NodeNext",
      strict: true,
      esModuleInterop: true,
      forceConsistentCasingInFileNames: true,
      skipLibCheck: true,
      noEmit: true,
      types: ["node"],
      customConditions: ["development"],
    },
    include: ["*.ts"],
  }, null, 2)}\n`);
}

async function linkWorkspaceCore(workspace: string): Promise<void> {
  await mkdir(join(workspace, "packages"), { recursive: true });
  await symlink(join(repoRoot, "packages", "core"), join(workspace, "packages", "core"), "dir");
}

async function stopWorkspaceDaemon(workspace: string): Promise<void> {
  const pids = new Set([
    ...await workspaceDaemonPidsFromProcessTable(workspace),
    ...maybePid(await workspaceDaemonPid(workspace)),
  ]);
  try {
    await requestDaemonShutdown(workspace);
  } catch {
    // Active test runs can reject graceful shutdown. The workspace is about to be
    // deleted, so the test-owned daemon must not be allowed to outlive it.
  }
  for (const pid of pids) {
    if (pid !== process.pid) await terminateProcess(pid);
  }
}

async function workspaceDaemonPid(workspace: string): Promise<number | undefined> {
  try {
    const health = await getRuntimeHealth(workspace);
    const daemon = health.checks.find(check => check.area === "daemon");
    const pid = daemon?.details?.pid;
    return typeof pid === "number" ? pid : undefined;
  } catch {
    return undefined;
  }
}

async function terminateProcess(pid: number): Promise<void> {
  if (!isProcessAlive(pid)) return;
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return;
  }
  await waitForExit(pid, 1_000);
  if (!isProcessAlive(pid)) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    return;
  }
  await waitForExit(pid, 1_000);
}

async function workspaceDaemonPidsFromProcessTable(workspace: string): Promise<number[]> {
  if (process.platform !== "linux") return [];
  try {
    const entries = await readdir("/proc", { withFileTypes: true });
    const pids: number[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
      const pid = Number(entry.name);
      const cmdline = await readProcCmdline(pid);
      if (cmdline.includes("daemon-entry") && cmdline.includes(workspace)) pids.push(pid);
    }
    return pids;
  } catch {
    return [];
  }
}

async function readProcCmdline(pid: number): Promise<string> {
  try {
    return (await readFile(`/proc/${pid}/cmdline`, "utf8")).replaceAll("\0", " ");
  } catch {
    return "";
  }
}

function maybePid(pid: number | undefined): number[] {
  return pid === undefined ? [] : [pid];
}

async function waitForExit(pid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && isProcessAlive(pid)) {
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
