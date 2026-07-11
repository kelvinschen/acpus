import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const webRoot = join(root, "packages", "web");

await run(bin(root, "tsc"), ["-b", "tsconfig.build.foundation.json"], root);

const vite = settle(run(bin(webRoot, "vite"), ["build", "--config", "vite.config.ts"], webRoot));
const staticViz = await settle(run(process.execPath, ["scripts/build-static-viz.mjs"], webRoot));
if (!staticViz.ok) {
  throwFailures([staticViz, await vite]);
}

const typescript = settle(run(bin(root, "tsc"), ["-b", "tsconfig.build.json"], root));
throwFailures(await Promise.all([vite, typescript]));

function bin(cwd, name) {
  return join(cwd, "node_modules", ".bin", process.platform === "win32" ? `${name}.cmd` : name);
}

function run(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: "inherit",
      shell: process.platform === "win32",
    });
    child.on("error", reject);
    child.on("exit", code => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} exited with ${code}`));
    });
  });
}

function settle(promise) {
  return promise.then(
    () => ({ ok: true }),
    error => ({ ok: false, error }),
  );
}

function throwFailures(results) {
  const failures = results.filter(result => !result.ok).map(result => result.error);
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, "Build stages failed");
}
