import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const expectedEngine = "^22.18.0 || >=24.0.0";
const expectedPublicPackages = new Set([
  "@acpus/acp",
  "@acpus/agent-executor",
  "@acpus/agent-teams",
  "acpus",
  "@acpus/core",
  "@acpus/dsh",
  "@acpus/expression",
  "@acpus/loader",
  "@acpus/owned-process",
  "@acpus/runtime",
  "@acpus/tasks",
  "@acpus/web",
  "@acpus/workflow-compiler",
]);
const failures = [];

const packageFiles = [path.join(root, "package.json")];
for (const entry of await readdir(path.join(root, "packages"), { withFileTypes: true })) {
  if (entry.isDirectory()) packageFiles.push(path.join(root, "packages", entry.name, "package.json"));
}

const packages = [];
for (const file of packageFiles) {
  if (!existsSync(file)) continue;
  const manifest = JSON.parse(await readFile(file, "utf8"));
  packages.push({ file, manifest });
  if (manifest.engines?.node !== expectedEngine) {
    failures.push(`${manifest.name}: engines.node must be ${expectedEngine}`);
  }
  if (!manifest.private && !/^\d+\.\d+\.\d+(?:\+[\dA-Za-z.-]+)?$/.test(manifest.version)) {
    failures.push(`${manifest.name}: version ${manifest.version} is not stable semver`);
  }
}

const publicPackages = packages.filter(({ manifest }) => !manifest.private);
const actualPublicPackages = new Set(publicPackages.map(({ manifest }) => manifest.name));
for (const name of expectedPublicPackages) {
  if (!actualPublicPackages.has(name)) failures.push(`missing public package ${name}`);
}
for (const name of actualPublicPackages) {
  if (!expectedPublicPackages.has(name)) failures.push(`unexpected public package ${name}`);
}

if (existsSync(path.join(root, ".changeset", "pre.json"))) {
  failures.push("Changesets prerelease mode is still active");
}

const pendingChangesets = (await readdir(path.join(root, ".changeset"))).filter(
  (name) => name.endsWith(".md") && name !== "README.md",
);
if (pendingChangesets.length > 0) {
  failures.push(`pending changesets: ${pendingChangesets.join(", ")}`);
}

const cliVersion = packages.find(({ manifest }) => manifest.name === "acpus")?.manifest.version;
const skill = await readFile(path.join(root, "packages", "cli", "skills", "acpus", "SKILL.md"), "utf8");
const skillVersion = skill.match(/^\s*acpus-version:\s*(\S+)\s*$/m)?.[1];
if (skillVersion !== cliVersion) {
  failures.push(`bundled skill version ${skillVersion ?? "missing"} does not match acpus ${cliVersion}`);
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log(`Verified stable release state for ${publicPackages.length} public packages.`);
