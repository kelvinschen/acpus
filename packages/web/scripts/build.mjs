import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const root = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(root, "..");

const clientBuild = run(bin("vite"), ["build", "--config", "vite.config.ts"]);
const serverBuild = run(process.execPath, ["scripts/build-static-viz.mjs"])
  .then(() => run(bin("tsc"), ["-b", "tsconfig.build.json"]));
const [clientResult, serverResult] = await Promise.allSettled([clientBuild, serverBuild]);

if (clientResult.status === "rejected") throw clientResult.reason;
if (serverResult.status === "rejected") throw serverResult.reason;

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
