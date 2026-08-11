import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const projects = [
  { name: "unit", args: ["--project", "unit"], maxWorkers: "22%" },
  { name: "contract+type", args: ["--project", "contract", "--project", "type-contract"], maxWorkers: "13%" },
  { name: "integration:1", args: ["--project", "integration", "--shard=1/2"], maxWorkers: "24%" },
  { name: "integration:2", args: ["--project", "integration", "--shard=2/2"], maxWorkers: "24%" },
  { name: "e2e+regression", args: ["--project", "e2e", "--project", "regression"], maxWorkers: "3%" },
];
const require = createRequire(import.meta.url);
const vitestPackagePath = require.resolve("vitest/package.json");
const vitestCli = join(dirname(vitestPackagePath), require(vitestPackagePath).bin.vitest);
const root = fileURLToPath(new URL("..", import.meta.url));
const activeChildren = new Set();
let interrupted;

process.exitCode = await main();

async function main() {
  if (process.argv.length > 2) {
    console.error("pnpm test does not accept filters or Vitest options. Use pnpm test:<layer> instead.");
    return 2;
  }
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => {
      interrupted ??= signal;
      for (const child of activeChildren) killProcessTree(child, signal);
    });
  }
  const results = await Promise.all(projects.map(project => runProject(vitestCli, project)));

  if (interrupted) return interrupted === "SIGINT" ? 130 : 143;
  return results.some(code => code !== 0) ? 1 : 0;
}

function runProject(vitestCli, project) {
  return new Promise(resolve => {
    const output = [];
    const child = spawn(process.execPath, [vitestCli, "run", ...project.args, `--maxWorkers=${project.maxWorkers ?? "19%"}`], {
      cwd: root,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    let spawnError;

    activeChildren.add(child);
    child.stdout.on("data", chunk => output.push({ stream: process.stdout, chunk }));
    child.stderr.on("data", chunk => output.push({ stream: process.stderr, chunk }));
    child.once("error", error => {
      spawnError = error;
    });
    child.once("close", (code, signal) => {
      activeChildren.delete(child);
      printResult(project.name, output, code, signal, spawnError);
      resolve(code);
    });
  });
}

function killProcessTree(child, signal) {
  if (child.pid === undefined) return;
  try {
    if (process.platform === "win32") {
      const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      let fellBack = false;
      const fallback = () => {
        if (fellBack) return;
        fellBack = true;
        killChild(child, signal);
      };
      killer.once("error", fallback);
      killer.once("close", code => {
        if (code !== 0) fallback();
      });
      killer.unref();
    } else {
      process.kill(-child.pid, signal);
    }
  } catch {
    killChild(child, signal);
  }
}

function killChild(child, signal) {
  try {
    child.kill(signal);
  } catch {}
}

function printResult(name, output, code, signal, spawnError) {
  const status = interrupted ? "INTERRUPTED" : code === 0 ? "PASS" : `FAIL${signal ? ` (${signal})` : ""}`;
  process.stdout.write(`\n[test:${name}] ${status}\n`);
  for (const { stream, chunk } of output) stream.write(chunk);
  if (spawnError) process.stderr.write(`${spawnError.stack ?? spawnError.message}\n`);
}
