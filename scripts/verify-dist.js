import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdtemp, readFile, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, matchesGlob } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { requestDaemonShutdown } from "@acpus/runtime";

const root = fileURLToPath(new URL("..", import.meta.url));
const execFileAsync = promisify(execFile);
const publishedPackageNames = [
  "@acpus/agent-executor",
  "@acpus/core",
  "@acpus/expression",
  "@acpus/loader",
  "@acpus/runtime",
  "@acpus/tasks",
  "@acpus/web",
  "@acpus/workflow-compiler",
  "acpus",
];

await verifyPackages();

const workspace = await mkdtemp(join(tmpdir(), "acpus-dist-smoke-"));

try {
  await symlink(join(root, "node_modules"), join(workspace, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  const workflow = join(workspace, "workflow.ts");
  await cp(join(root, "packages/cli/test/fixtures/workflows/concurrency/short-task.workflow.ts"), workflow);

  const { stdout, stderr } = await execFileAsync(process.execPath, [
    join(root, "packages/cli/dist/cli.js"), "workflow", "run", workflow, "--json",
  ], {
    cwd: workspace,
    env: { ...process.env, FORCE_COLOR: "0", NODE_NO_WARNINGS: "1", NODE_OPTIONS: "" },
  });
  assert.equal(stderr, "");

  const records = stdout.trim().split("\n").map(line => JSON.parse(line));
  assert.deepEqual(pickRunResult(records[0]), {
    ok: true,
    phase: "run",
    kind: "admitted",
    name: "cli-concurrency-short-task",
    status: "pending",
  });
  assert.deepEqual(pickRunResult(records.at(-1)), {
    ok: true,
    phase: "run",
    kind: "terminal summary",
    name: "cli-concurrency-short-task",
    status: "completed",
    output: { ok: true },
  });
} finally {
  await requestDaemonShutdown(workspace).catch(() => undefined);
  await rm(workspace, { recursive: true, force: true });
}

function pickRunResult(record) {
  return {
    ok: record?.ok,
    phase: record?.phase,
    kind: record?.kind,
    name: record?.run?.name,
    status: record?.run?.status,
    ...(record?.run?.output === undefined ? {} : { output: record.run.output }),
  };
}

async function verifyPackages() {
  const packagesRoot = join(root, "packages");
  const packageDirectories = (await readdir(packagesRoot, { withFileTypes: true }))
    .filter(entry => entry.isDirectory() && existsSync(join(packagesRoot, entry.name, "package.json")))
    .map(entry => join(packagesRoot, entry.name))
    .sort();

  const packages = [];
  for (const packageDirectory of packageDirectories) {
    const manifest = JSON.parse(await readFile(join(packageDirectory, "package.json"), "utf8"));
    if (manifest.private === true) continue;
    packages.push({ packageDirectory, manifest });
  }
  assert.deepEqual(packages.map(({ manifest }) => manifest.name).sort(), publishedPackageNames, "published package inventory changed");
  for (const { packageDirectory, manifest } of packages) await verifyPackage(packageDirectory, manifest);
}

async function verifyPackage(packageDirectory, manifest) {
  const name = manifest.name ?? packageDirectory;
  const { stdout } = await npmPack(packageDirectory);
  const results = JSON.parse(stdout);
  assert.equal(results.length, 1, `${name}: npm pack returned ${results.length} results`);
  const packed = new Set(results[0].files.map(file => normalizePackagePath(file.path)));

  const caches = [...packed].filter(path => path.endsWith(".tsbuildinfo"));
  assert.equal(caches.length, 0, `${name}: packed build cache: ${caches.join(", ")}`);
  assert.ok(packed.has("package.json"), `${name}: package.json is not packed`);

  for (const entry of manifest.files ?? []) {
    const matches = [...packed].some(path => matchesFilesEntry(path, entry));
    const kind = isDocumentEntry(entry) ? "declared document" : "files entry";
    assert.ok(matches, `${name}: ${kind} does not match a packed path: ${entry}`);
  }

  const targets = packageTargets(manifest);
  for (const { field, target } of targets) {
    const path = normalizePackagePath(target);
    assert.ok(existsSync(join(packageDirectory, path)), `${name}: ${field} target is missing: ${target}`);
    assert.ok(packed.has(path), `${name}: ${field} target is not packed: ${target}`);
  }

  if (name === "acpus") {
    for (const path of ["skills/acpus/SKILL.md", "dist/commands/skill.js", "dist/commands/skill.d.ts"]) {
      assert.ok(packed.has(path), `${name}: required package path is not packed: ${path}`);
    }
    for (const { target } of binTargets(manifest.bin)) {
      const path = normalizePackagePath(target);
      assert.match(await readFile(join(packageDirectory, path), "utf8"), /^#![^\n]+/, `${name}: CLI bin has no shebang: ${target}`);
    }
  }
}

function npmPack(packageDirectory) {
  const args = ["pack", "--dry-run", "--json", "--ignore-scripts"];
  return process.platform === "win32"
    ? execFileAsync(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", "npm", ...args], { cwd: packageDirectory })
    : execFileAsync("npm", args, { cwd: packageDirectory });
}

function packageTargets(manifest) {
  return [
    ...(typeof manifest.main === "string" ? [{ field: "main", target: manifest.main }] : []),
    ...(typeof manifest.types === "string" ? [{ field: "types", target: manifest.types }] : []),
    ...binTargets(manifest.bin),
    ...exportTargets(manifest.exports),
  ];
}

function binTargets(bin) {
  if (typeof bin === "string") return [{ field: "bin", target: bin }];
  if (!bin || typeof bin !== "object") return [];
  return Object.entries(bin).map(([command, target]) => ({ field: `bin.${command}`, target }));
}

function exportTargets(value, field = "exports") {
  if (typeof value === "string") return [{ field, target: value }];
  if (Array.isArray(value)) return value.flatMap((target, index) => exportTargets(target, `${field}[${index}]`));
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([condition, target]) => condition === "development"
    ? []
    : exportTargets(target, `${field}.${condition}`));
}

function matchesFilesEntry(path, entry) {
  const pattern = normalizePackagePath(entry).replace(/\/$/, "");
  return path === pattern || path.startsWith(`${pattern}/`) || matchesGlob(path, pattern);
}

function isDocumentEntry(entry) {
  const name = normalizePackagePath(entry).split("/").at(-1);
  return /^(?:readme|licen[cs]e)(?:[.*]|$)/i.test(name);
}

function normalizePackagePath(path) {
  return path.replace(/^\.\//, "").replaceAll("\\", "/");
}
