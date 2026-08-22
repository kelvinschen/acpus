import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { findPackageJSON } from "node:module";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const entry = fileURLToPath(import.meta.url);
const root = resolve(dirname(entry), "..", "..");
const dshRoot = join(root, "packages", "dsh");
const dshRemoteCheck = {
  file: process.execPath,
  args: [join(dshRoot, "scripts", "remote-artifacts.mjs"), "check"],
  cwd: dshRoot,
};
const sourceGraphIssues = [
  "files",
  "exports",
  "nsExports",
  "types",
  "nsTypes",
  "enumMembers",
  "namespaceMembers",
  "duplicates",
  "dependencies",
  "unlisted",
  "binaries",
  "unresolved",
  "catalog",
].join(",");
const tasks = new Map([
  ["toolchain", {
    name: "toolchain",
    commands: [nodeCommand("scripts/checks/toolchain.mjs")],
  }],
  ["dsh:remote", {
    name: "dsh:remote",
    commands: [dshRemoteCheck],
  }],
  ["effect:architecture", {
    name: "effect:architecture",
    commands: [nodeCommand("scripts/checks/effect-architecture.mjs")],
  }],
  ["graph:source", {
    name: "graph:source",
    commands: [{
      packageBin: ["knip", "knip"],
      args: [
        "--include",
        sourceGraphIssues,
        "--treat-config-hints-as-errors",
      ],
      cwd: root,
    }],
  }],
  ["graph:strict", {
    name: "graph:strict",
    commands: [{
      packageBin: ["knip", "knip"],
      args: [
        "--strict",
        "--dependencies",
        "--treat-config-hints-as-errors",
      ],
      cwd: root,
    }],
  }],
  ["docs", {
    name: "docs",
    commands: [nodeCommand("scripts/checks/docs.mjs")],
  }],
  ["security", {
    name: "security",
    commands: [{
      packageManager: true,
      args: ["audit", "--audit-level", "high"],
      cwd: root,
    }],
  }],
  ["release", {
    name: "release",
    commands: [dshRemoteCheck, nodeCommand("scripts/checks/release.mjs")],
  }],
]);

export const checkNames = Object.freeze([...tasks.keys()]);
export const defaultCheckNames = Object.freeze([
  "toolchain",
  "dsh:remote",
  "effect:architecture",
  "graph:source",
  "graph:strict",
  "docs",
  "security",
]);

export class CheckSelectionError extends Error {}

export function resolveCheckPlan(selection = []) {
  if (selection.length > 1) {
    throw new CheckSelectionError("Expected at most one check name.");
  }
  const names = selection.length === 0 ? defaultCheckNames : selection;
  return names.map(name => {
    const task = tasks.get(name);
    if (!task) {
      throw new CheckSelectionError(
        `Unknown check '${name}'. Expected one of: ${checkNames.join(", ")}.`,
      );
    }
    return task;
  });
}

export async function runChecks(selection = []) {
  const completed = [];
  for (const task of resolveCheckPlan(selection)) {
    await runTask(task);
    completed.push(task.name);
  }
  return completed;
}

let activeChild;
let interrupted;

if (process.argv[1] !== undefined && resolve(process.argv[1]) === entry) {
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => {
      interrupted ??= signal;
      process.exitCode = signalExitCode(interrupted);
      killProcessTree(activeChild, signal);
    });
  }
  process.exitCode = await main(process.argv.slice(2));
}

async function main(selection) {
  try {
    await runChecks(selection);
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
      await new Promise(resolveTask => setTimeout(resolveTask, 0));
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
  return new Promise((resolveTask, reject) => {
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
      if (code === 0) resolveTask();
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

function nodeCommand(relativePath) {
  return {
    file: process.execPath,
    args: [join(root, relativePath)],
    cwd: root,
  };
}
