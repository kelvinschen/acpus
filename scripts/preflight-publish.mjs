import { execFileSync } from "node:child_process";

const packages = ["@acpus/core", "@acpus/runtime", "@acpus/tui", "acpus"];

function run(command, args) {
  return execFileSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();
}

try {
  const user = run("npm", ["whoami"]);
  console.log(`Authenticated to npm as ${user}.`);
} catch (error) {
  console.error("npm authentication failed. Set NODE_AUTH_TOKEN or run npm login before publishing.");
  process.exit(1);
}

for (const packageName of packages) {
  try {
    run("npm", ["view", packageName, "name"]);
    console.log(`${packageName} exists on npm.`);
  } catch {
    console.log(`${packageName} is not published yet; publish will create it if this account has permission.`);
  }
}

try {
  run("npm", ["access", "ls-packages", "@acpus"]);
  console.log("npm @acpus scope access check completed.");
} catch (error) {
  console.error("Unable to verify @acpus npm scope access. Resolve npm permissions before creating a release tag.");
  process.exit(1);
}
