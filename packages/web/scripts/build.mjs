import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const root = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(root, "..");

await Promise.all([
  run(process.execPath, ["scripts/build-static-viz.mjs"]),
  run(bin("vite"), ["build", "--config", "vite.config.ts"]),
]);
await run(bin("tsc"), ["-p", "tsconfig.json", "--noCheck"]);

function bin(name) {
  return process.platform === "win32" ? `${name}.cmd` : name;
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: packageRoot,
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
