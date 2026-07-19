import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, matchesGlob, relative } from "node:path";
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

const packages = await verifyPackages();
await verifyPackedWorkflowCompiler(packages);
await verifyPackedCli(packages);

const workspace = await mkdtemp(join(tmpdir(), "acpus-dist-smoke-"));

try {
  await symlink(join(root, "node_modules"), join(workspace, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  const workflow = join(workspace, "workflow.ts");
  await cp(join(root, "packages/cli/test/fixtures/workflows/concurrency/short-task.workflow.ts"), workflow);
  await writeFile(join(workspace, "input.json"), "{}\n");

  const { stdout, stderr } = await execFileAsync(process.execPath, [
    join(root, "packages/cli/dist/cli.js"), "workflow", "run", workflow, "--input", "input.json", "--json",
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
    kind: "done",
    name: "cli-concurrency-short-task",
    status: "completed",
    output: { ok: true },
  });
} finally {
  await requestDaemonShutdown(workspace);
  await rm(workspace, { recursive: true, force: true });
}

function pickRunResult(record) {
  return {
    ok: record?.ok,
    phase: record?.phase,
    kind: record?.kind,
    name: record?.run?.name,
    status: record?.run?.status,
    ...(record?.output === undefined ? {} : { output: record.output }),
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
  return packages;
}

async function verifyPackedWorkflowCompiler(packages) {
  const workspace = await mkdtemp(join(tmpdir(), "acpus-packed-consumer-"));
  try {
    const tarballsDirectory = join(workspace, "tarballs");
    const consumerDirectory = join(workspace, "consumer");
    await mkdir(tarballsDirectory);
    await mkdir(consumerDirectory);

    const packagesByName = new Map(packages.map(pkg => [pkg.manifest.name, pkg]));
    const packageNames = localDependencyClosure("@acpus/workflow-compiler", packagesByName);
    const tarballs = new Map();
    for (const name of packageNames) {
      const pkg = packagesByName.get(name);
      assert.ok(pkg, `packed smoke dependency is not publishable: ${name}`);
      tarballs.set(name, await pnpmPack(pkg.packageDirectory, tarballsDirectory));
    }

    const fileSpecs = Object.fromEntries([...tarballs].map(([name, tarball]) => [
      name,
      localFileSpec(consumerDirectory, tarball),
    ]));
    await writeFile(join(consumerDirectory, "package.json"), `${JSON.stringify({
      name: "acpus-packed-consumer-smoke",
      private: true,
      type: "module",
      dependencies: {
        "@acpus/workflow-compiler": fileSpecs["@acpus/workflow-compiler"],
      },
      pnpm: {
        overrides: fileSpecs,
      },
    }, null, 2)}\n`);
    await writeFile(join(consumerDirectory, "valid.workflow.ts"), `import { defineWorkflow, z } from "acpus/core";

export default defineWorkflow({
  name: "packed-consumer",
  inputSchema: z.object({ value: z.string() }),
}).build(({ input }) => ({ value: input.value }));
`);
    await writeFile(join(consumerDirectory, "invalid.workflow.ts"), `import { defineWorkflow, z } from "acpus/core";

const incompatible: number = "not-a-number";

export default defineWorkflow({
  name: "packed-consumer-invalid",
  inputSchema: z.object({ value: z.string() }),
}).build(({ input }) => ({ value: input.value, incompatible }));
`);
    await writeFile(join(consumerDirectory, "smoke.mjs"), `import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { prepareWorkflow, tryPrepareWorkflow } from "@acpus/workflow-compiler";

const consumerNodeModules = resolve("node_modules");
const require = createRequire(import.meta.url);
const compilerEntry = require.resolve("@acpus/workflow-compiler");
assert.ok(compilerEntry.startsWith(consumerNodeModules), "workflow compiler resolved outside the packed consumer");

const compilerRequire = createRequire(compilerEntry);
const typescriptEntry = compilerRequire.resolve("typescript");
const typescriptRequire = createRequire(typescriptEntry);
const typescript = typescriptRequire("typescript");
const typescriptManifest = typescriptRequire("typescript/package.json");
assert.equal(typescript.version, "7.0.2");
assert.ok(typescriptEntry.startsWith(consumerNodeModules), "TypeScript resolved outside the packed consumer");

const installedPlatformPackages = Object.keys(typescriptManifest.optionalDependencies ?? {}).filter(name => {
  try {
    typescriptRequire.resolve(name + "/package.json");
    return true;
  } catch {
    return false;
  }
});
assert.equal(installedPlatformPackages.length, 1, "expected exactly one TypeScript platform binary");
const platformManifestPath = typescriptRequire.resolve(installedPlatformPackages[0] + "/package.json");
assert.ok(platformManifestPath.startsWith(consumerNodeModules), "TypeScript platform binary resolved outside the packed consumer");
assert.equal(typescriptRequire(installedPlatformPackages[0] + "/package.json").version, "7.0.2");

const prepared = await prepareWorkflow({ workflow: "valid.workflow.ts", cwd: process.cwd() });
assert.equal(prepared.ir.name, "packed-consumer");
assert.deepEqual(prepared.ir.diagnostics, []);

const checked = await tryPrepareWorkflow({ workflow: "invalid.workflow.ts", cwd: process.cwd() });
assert.equal(checked.isErr(), true, "invalid workflow unexpectedly prepared");
if (checked.isOk()) throw new Error("invalid workflow unexpectedly prepared");
assert.equal(checked.error.type, "check-failed");
assert.ok(checked.error.diagnostics.some(diagnostic => diagnostic.code === "TS2322"), "TS7 check did not report TS2322");
`);

    await runPnpm(["install", "--ignore-scripts", "--no-frozen-lockfile", "--reporter=append-only"], consumerDirectory);
    const lockfile = await readFile(join(consumerDirectory, "pnpm-lock.yaml"), "utf8");
    for (const tarball of tarballs.values()) {
      assert.ok(lockfile.includes(tarball.split(/[\\/]/).at(-1)), `consumer lockfile did not use local tarball: ${tarball}`);
    }
    await execFileAsync(process.execPath, [join(consumerDirectory, "smoke.mjs")], {
      cwd: consumerDirectory,
      env: smokeEnvironment(),
    });
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

async function verifyPackedCli(packages) {
  const workspace = await mkdtemp(join(tmpdir(), "acpus-packed-cli-"));
  try {
    const tarballsDirectory = join(workspace, "tarballs");
    const consumerDirectory = join(workspace, "consumer");
    await mkdir(tarballsDirectory);
    await mkdir(consumerDirectory);

    const packagesByName = new Map(packages.map(pkg => [pkg.manifest.name, pkg]));
    const packageNames = localDependencyClosure("acpus", packagesByName);
    const tarballs = new Map();
    for (const name of packageNames) {
      const pkg = packagesByName.get(name);
      assert.ok(pkg, `packed CLI dependency is not publishable: ${name}`);
      tarballs.set(name, await pnpmPack(pkg.packageDirectory, tarballsDirectory));
    }
    const fileSpecs = Object.fromEntries([...tarballs].map(([name, tarball]) => [
      name,
      localFileSpec(consumerDirectory, tarball),
    ]));
    await writeFile(join(consumerDirectory, "package.json"), `${JSON.stringify({
      name: "acpus-packed-cli-smoke",
      private: true,
      type: "module",
      dependencies: { acpus: fileSpecs.acpus },
      pnpm: { overrides: fileSpecs },
    }, null, 2)}\n`);
    await runPnpm(["install", "--ignore-scripts", "--no-frozen-lockfile", "--reporter=append-only"], consumerDirectory);

    const cliEntry = join(consumerDirectory, "node_modules", "acpus", "dist", "cli.js");
    const codexHome = join(consumerDirectory, "codex-home");
    const claudeHome = join(consumerDirectory, "claude-home");
    const environment = { ...smokeEnvironment(), CODEX_HOME: codexHome, CLAUDE_CONFIG_DIR: claudeHome };
    const runCli = args => execFileAsync(process.execPath, [cliEntry, ...args], { cwd: consumerDirectory, env: environment });

    const doctor = JSON.parse((await runCli(["doctor", "--json"])).stdout);
    assert.equal(doctor.ok, true);
    assert.equal(doctor.authoring.cli.version, packagesByName.get("acpus").manifest.version);
    assert.ok(doctor.authoring.cli.packageRoot.startsWith(consumerDirectory));
    assert.equal(doctor.authoring.skills.bundled.status, "aligned");
    for (const authority of Object.values(doctor.authoring.imports)) {
      assert.equal(authority.packageRoot.startsWith(consumerDirectory), true);
      assert.equal(existsSync(authority.packageRoot), true);
      assert.equal(existsSync(authority.typesPath), true);
    }

    const examplesRoot = join(consumerDirectory, "node_modules", "acpus", "skills", "acpus", "examples", "workflows");
    for (const entry of await readdir(examplesRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const workflow = join(examplesRoot, entry.name, "workflow.ts");
      if (!existsSync(workflow)) continue;
      const checked = JSON.parse((await runCli(["workflow", "check", workflow, "--json"])).stdout);
      assert.equal(checked.ok, true, `packed skill example failed: ${entry.name}`);
    }

    await mkdir(join(consumerDirectory, ".agents", "skills"), { recursive: true });
    await mkdir(join(consumerDirectory, ".claude", "skills"), { recursive: true });
    const installed = JSON.parse((await runCli(["skill", "install", "--json"])).stdout);
    assert.equal(installed.skill.version, doctor.authoring.cli.version);
    const aligned = JSON.parse((await runCli(["doctor", "--json"])).stdout);
    assert.deepEqual(aligned.authoring.skills.installed.map(skill => skill.status), ["aligned", "aligned"]);

    const installedSkill = join(consumerDirectory, ".agents", "skills", "acpus", "SKILL.md");
    await writeFile(installedSkill, (await readFile(installedSkill, "utf8")).replace(/acpus-version:\s*[^\s]+/, "acpus-version: 0.0.0"));
    const stale = JSON.parse((await runCli(["doctor", "--json"])).stdout);
    assert.equal(stale.ok, true);
    assert.ok(stale.checks.some(check => check.area === "skill" && check.status === "warn" && check.details?.remediation === "acpus skill install --project"));

    const installedManifestPath = join(consumerDirectory, "node_modules", "acpus", "package.json");
    const installedManifestSource = await readFile(installedManifestPath, "utf8");
    const installedManifest = JSON.parse(installedManifestSource);
    installedManifest.dependencies["@acpus/core"] = "0.0.0";
    await writeFile(installedManifestPath, `${JSON.stringify(installedManifest, null, 2)}\n`);
    await assert.rejects(runCli(["doctor", "--json"]), error => {
      const failed = JSON.parse(error.stdout);
      return failed.ok === false && failed.checks.some(check => check.area === "authoring" && check.status === "fail");
    });
    await writeFile(installedManifestPath, installedManifestSource);

    const bundledSkill = join(consumerDirectory, "node_modules", "acpus", "skills", "acpus", "SKILL.md");
    await writeFile(bundledSkill, (await readFile(bundledSkill, "utf8")).replace(/acpus-version:\s*[^\s]+/, "acpus-version: 0.0.0"));
    await assert.rejects(runCli(["doctor", "--json"]), error => {
      const failed = JSON.parse(error.stdout);
      return failed.ok === false && failed.checks.some(check => check.area === "skill" && check.status === "fail");
    });
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

function localDependencyClosure(rootName, packagesByName) {
  const names = new Set();
  const pending = [rootName];
  while (pending.length > 0) {
    const name = pending.pop();
    if (names.has(name)) continue;
    const pkg = packagesByName.get(name);
    assert.ok(pkg, `packed smoke root is not publishable: ${name}`);
    names.add(name);
    for (const dependency of Object.keys(pkg.manifest.dependencies ?? {})) {
      if (packagesByName.has(dependency)) pending.push(dependency);
    }
  }
  return [...names].sort();
}

async function pnpmPack(packageDirectory, destination) {
  const before = new Set(await readdir(destination));
  await runPnpm(["pack", "--pack-destination", destination], packageDirectory);
  const added = (await readdir(destination)).filter(file => file.endsWith(".tgz") && !before.has(file));
  assert.equal(added.length, 1, `${packageDirectory}: pnpm pack produced ${added.length} tarballs`);
  return join(destination, added[0]);
}

function runPnpm(args, cwd) {
  const options = { cwd, env: smokeEnvironment() };
  if (process.env.npm_execpath && existsSync(process.env.npm_execpath)) {
    return execFileAsync(process.execPath, [process.env.npm_execpath, ...args], options);
  }
  return process.platform === "win32"
    ? execFileAsync(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", "pnpm", ...args], options)
    : execFileAsync("pnpm", args, options);
}

function smokeEnvironment() {
  return {
    ...process.env,
    CI: "1",
    FORCE_COLOR: "0",
    NODE_NO_WARNINGS: "1",
    NODE_OPTIONS: "",
    NODE_PATH: "",
  };
}

function localFileSpec(fromDirectory, target) {
  const path = relative(fromDirectory, target).replaceAll("\\", "/");
  return `file:${path.startsWith(".") ? path : `./${path}`}`;
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
