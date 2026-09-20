import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getRuntimeHealth, requestDaemonShutdown } from "@acpus/runtime";
import * as Effect from "effect/Effect";
import { setRuntimeHomeForTest } from "../../../runtime/src/runtime-layout.js";
import { registerTestProcessHome, repoRoot } from "./cli-runner.js";

export async function withPlainTestWorkspace<T>(
  name: string,
  fn: (workspace: string, home: string) => Promise<T>,
): Promise<T> {
  return withWorkspace(name, "plain", fn);
}

export async function withAuthoringTestWorkspace<T>(
  name: string,
  fn: (workspace: string, home: string) => Promise<T>,
): Promise<T> {
  return withWorkspace(name, "authoring", fn);
}

export async function withDaemonTestWorkspace<T>(
  name: string,
  fn: (workspace: string, home: string, registerDaemonHome: (acpusHome: string) => void) => Promise<T>,
): Promise<T> {
  return withWorkspace(name, "daemon", fn);
}

async function withWorkspace<T>(
  name: string,
  kind: "plain" | "authoring" | "daemon",
  fn: (workspace: string, home: string, registerDaemonHome: (acpusHome: string) => void) => Promise<T>,
): Promise<T> {
  const root = join(repoRoot, ".tmp-tests");
  await mkdir(root, { recursive: true });
  const workspace = await mkdtemp(join(root, `${name}-`));
  const home = await mkdtemp(join(root, `${name}-home-`));
  const daemonHomes = new Set([join(home, ".acpus")]);
  const restoreRuntimeHome = setRuntimeHomeForTest(workspace, join(home, ".acpus"));
  const restoreProcessHome = kind === "plain" ? undefined : registerTestProcessHome(workspace, home);
  try {
    if (kind !== "plain") {
      await symlink(join(repoRoot, "node_modules"), join(workspace, "node_modules"), "dir");
      await linkWorkspaceCore(workspace);
      await writeWorkspaceTsconfig(workspace);
    }
    return await fn(workspace, home, acpusHome => { daemonHomes.add(acpusHome); });
  } finally {
    if (kind === "daemon") await stopWorkspaceDaemon(workspace, daemonHomes);
    restoreProcessHome?.();
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

async function stopWorkspaceDaemon(workspace: string, homes: ReadonlySet<string>): Promise<void> {
  const pids = new Set(await workspaceDaemonPidsFromProcessTable(workspace));
  for (const home of homes) {
    const restoreHome = setRuntimeHomeForTest(workspace, home);
    try {
      const pid = await workspaceDaemonPid(workspace);
      if (pid !== undefined) pids.add(pid);
      await Effect.runPromise(requestDaemonShutdown(workspace));
    } catch {
      // Active Runs can reject shutdown; terminate only this fixture's daemons.
    } finally {
      restoreHome();
    }
  }
  await Promise.all([...pids].filter(pid => pid !== process.pid).map(terminateProcess));
}

async function workspaceDaemonPid(workspace: string): Promise<number | undefined> {
  try {
    const health = await Effect.runPromise(getRuntimeHealth(workspace));
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
    const candidates = entries.filter(entry => entry.isDirectory() && /^\d+$/.test(entry.name));
    const matching = await Promise.all(candidates.map(async entry => {
      const pid = Number(entry.name);
      const cmdline = await readProcCmdline(pid);
      return cmdline.includes("daemon-entry") && cmdline.includes(workspace) ? pid : undefined;
    }));
    return matching.filter((pid): pid is number => pid !== undefined);
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

async function waitForExit(pid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && isProcessAlive(pid)) {
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    // Orphaned daemon zombies remain visible to kill(pid, 0), but have exited.
    if (process.platform === "linux") return !/^\d+ \(.*\) [ZX] /s.test(readFileSync(`/proc/${pid}/stat`, "utf8"));
    return true;
  } catch {
    return false;
  }
}
