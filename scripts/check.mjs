import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { findPackageJSON } from "node:module";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import {
  CheckSelectionError,
  createCheckRunner,
} from "./check-plan.mjs";

let activeChild;
let interrupted;

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    interrupted ??= signal;
    process.exitCode = signalExitCode(interrupted);
    killProcessTree(activeChild, signal);
  });
}

process.exitCode = await main();

async function main() {
  try {
    await createCheckRunner(runTask)(process.argv.slice(2));
    return interrupted ? signalExitCode(interrupted) : 0;
  } catch (error) {
    if (interrupted) return signalExitCode(interrupted);
    console.error(error instanceof Error ? error.message : String(error));
    return error instanceof CheckSelectionError ? 2 : 1;
  }
}

async function runTask(task) {
  const startedAt = performance.now();
  try {
    for (const command of task.commands) {
      throwIfInterrupted();
      await runCommand(command);
      await new Promise(resolve => setTimeout(resolve, 0));
      throwIfInterrupted();
    }
  } catch (error) {
    console.error(`[check:${task.name}] ${interrupted ? "INTERRUPTED" : "FAIL"} ${duration(startedAt)}`);
    throw error;
  }
  console.log(`[check:${task.name}] PASS ${duration(startedAt)}`);
}

function runCommand(command) {
  const resolved = resolveCommand(command);
  return new Promise((resolve, reject) => {
    const child = spawn(resolved.file, resolved.args, {
      cwd: command.cwd,
      detached: process.platform !== "win32",
      stdio: "inherit",
    });
    let settled = false;
    activeChild = child;
    child.once("error", error => {
      if (settled) return;
      settled = true;
      activeChild = undefined;
      reject(new Error(`Check command could not start: ${resolved.file}`, { cause: error }));
    });
    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      activeChild = undefined;
      if (code === 0) resolve();
      else {
        reject(new Error(
          `Check command ${signal ? `terminated by ${signal}` : `exited with ${code}`}`,
        ));
      }
    });
  });
}

function resolveCommand(command) {
  if (command.packageBin) {
    return {
      file: process.execPath,
      args: [resolvePackageBin(...command.packageBin), ...command.args],
    };
  }
  if (!command.packageManager) return command;
  const packageManagerCli = process.env.npm_execpath;
  if (!packageManagerCli) {
    throw new Error("Package-manager checks must be invoked through pnpm.");
  }
  return {
    file: process.execPath,
    args: [packageManagerCli, ...command.args],
  };
}

function resolvePackageBin(packageName, binName) {
  const manifestPath = findPackageJSON(packageName, import.meta.url);
  if (!manifestPath) throw new Error(`${packageName} package manifest was not found`);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const bin = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.[binName];
  if (bin === undefined) throw new Error(`${packageName} does not provide the ${binName} executable`);
  return join(dirname(manifestPath), bin);
}

function throwIfInterrupted() {
  if (interrupted) throw new Error(`Check interrupted by ${interrupted}`);
}

function killProcessTree(child, signal) {
  if (!child?.pid) return;
  try {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch {}
}

function signalExitCode(signal) {
  return signal === "SIGINT" ? 130 : 143;
}

function duration(startedAt) {
  return `${((performance.now() - startedAt) / 1_000).toFixed(2)}s`;
}
