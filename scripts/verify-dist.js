import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, matchesGlob, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const require = createRequire(join(root, "packages/cli/package.json"));
const semver = require("semver");
const pnpmOutputMaxBuffer = 16 * 1024 * 1024;
const pnpmState = JSON.parse(await readFile(join(root, "node_modules/.modules.yaml"), "utf8"));
assert.equal(typeof pnpmState.storeDir, "string", "root pnpm install has no store directory");
const packageMap = JSON.parse(await readFile(join(root, "node_modules/.package-map.json"), "utf8")).packages;
assert.ok(packageMap && typeof packageMap === "object", "root pnpm install has no package map");
const packageCacheRoot = process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache");
const temporaryRoot = await mkdtemp(join(dirname(root), ".acpus-dist-"));
const subprocesses = new Set();
let cleanupPromise;
let interruptedSignal;
let failure;

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, async () => {
    interruptedSignal = signal;
    try {
      await cleanup();
    } catch (error) {
      failure ??= error;
    }
    process.kill(process.pid, signal);
  });
}

try {
  const packages = await packPublishedPackages(join(temporaryRoot, "artifacts"));
  const consumerDirectory = join(temporaryRoot, "consumer");
  await createConsumer(consumerDirectory, packages);
  await runPnpm([
    "install",
    "--prefer-offline",
    "--ignore-scripts",
    "--no-frozen-lockfile",
    "--reporter=append-only",
  ], consumerDirectory);
  await assertConsumerUsesTarballs(consumerDirectory, packages);
  await verifyPublicEntries(consumerDirectory, packages);
  await verifyPackedCli(consumerDirectory);
} catch (error) {
  failure = error;
} finally {
  await cleanup();
}

if (interruptedSignal) process.kill(process.pid, interruptedSignal);
if (failure) throw failure;

async function cleanup() {
  cleanupPromise ??= (async () => {
    const running = [...subprocesses];
    for (const subprocess of running) subprocess.kill();
    await Promise.all(running.map(subprocess => (
      subprocess.exitCode === null && subprocess.signalCode === null
        ? once(subprocess, "close")
        : undefined
    )));
    await rm(temporaryRoot, { recursive: true, force: true });
  })();
  await cleanupPromise;
}

async function packPublishedPackages(destination) {
  await mkdir(destination);
  const packagesRoot = join(root, "packages");
  const packageDirectories = (await readdir(packagesRoot, { withFileTypes: true }))
    .filter(entry => entry.isDirectory() && existsSync(join(packagesRoot, entry.name, "package.json")))
    .map(entry => join(packagesRoot, entry.name))
    .sort();

  const discovered = await Promise.all(packageDirectories.map(async packageDirectory => ({
    packageDirectory,
    manifest: JSON.parse(await readFile(join(packageDirectory, "package.json"), "utf8")),
  })));
  const published = discovered.filter(({ manifest }) => manifest.private !== true);
  assert.ok(published.length > 0, "no published packages were discovered");

  const artifacts = await Promise.all(published.map(async ({ packageDirectory, manifest }) => {
    const artifact = await packPackage(packageDirectory, manifest, destination);
    await verifyPackage(packageDirectory, manifest, artifact.files);
    return [manifest.name, { packageDirectory, manifest, tarball: artifact.tarball }];
  }));
  const packages = new Map(artifacts);
  assert.equal(packages.size, artifacts.length, "duplicate published package name");
  return packages;
}

async function packPackage(packageDirectory, manifest, destination) {
  const { stdout } = await runPnpm(["pack", "--json", "--pack-destination", destination], packageDirectory);
  const report = JSON.parse(stdout);
  const name = manifest.name ?? packageDirectory;
  assert.equal(report?.name, manifest.name, `${name}: pnpm pack returned a different package name`);
  assert.equal(report?.version, manifest.version, `${name}: pnpm pack returned a different package version`);
  assert.equal(typeof report?.filename, "string", `${name}: pnpm pack did not return a tarball path`);
  assert.ok(Array.isArray(report?.files), `${name}: pnpm pack did not return a file inventory`);
  assert.ok(report.files.every(file => file && typeof file.path === "string"), `${name}: pnpm pack returned an invalid file inventory`);
  const tarball = resolve(packageDirectory, report.filename);
  assert.equal(resolve(dirname(tarball)), resolve(destination), `${name}: pnpm pack wrote outside the artifact directory`);
  assert.ok(existsSync(tarball), `${name}: pnpm pack did not create ${tarball}`);
  return { tarball, files: report.files };
}

async function verifyPackage(packageDirectory, manifest, files) {
  const name = manifest.name ?? packageDirectory;
  const packed = new Set(files.map(file => normalizePackagePath(file.path)));

  assert.ok(packed.has("package.json"), `${name}: package.json is not packed`);
  const caches = [...packed].filter(path => path.endsWith(".tsbuildinfo"));
  assert.equal(caches.length, 0, `${name}: packed build cache: ${caches.join(", ")}`);

  for (const entry of manifest.files ?? []) {
    const existingFiles = await filesForManifestEntry(packageDirectory, entry);
    assert.ok(existingFiles.length > 0, `${name}: files entry is missing or empty: ${entry}`);
    const missing = existingFiles.filter(path => !packed.has(path));
    assert.deepEqual(missing, [], `${name}: files entry omitted paths from the tarball: ${entry}`);
  }

  for (const { field, target } of packageTargets(manifest)) {
    const path = normalizePackagePath(target);
    assert.ok(existsSync(join(packageDirectory, path)), `${name}: ${field} target is missing: ${target}`);
    assert.ok(packed.has(path), `${name}: ${field} target is not packed: ${target}`);
  }

  for (const { target } of binTargets(manifest.bin)) {
    assert.match(
      await readFile(join(packageDirectory, normalizePackagePath(target)), "utf8"),
      /^#![^\n]+/,
      `${name}: bin has no shebang: ${target}`,
    );
  }

  if (name === "@acpus/dsh") {
    assertPackedPaths(name, packed, [
      "acp-agent/cordis.yml",
      "preset/acpus/agent.cordis.yml",
      "preset/acpus/preset.yml",
    ]);
  }
  if (name === "acpus") {
    assertPackedPaths(name, packed, [
      "skills/acpus/SKILL.md",
      "dist/update-awareness-worker.js",
      "dist/update-awareness-worker.d.ts",
    ]);
  }
  if (name === "@acpus/web") {
    const entry = "dist/client/index.html";
    const script = [...packed].find(path => path.startsWith("dist/client/assets/") && path.endsWith(".js"));
    const stylesheet = [...packed].find(path => path.startsWith("dist/client/assets/") && path.endsWith(".css"));
    assertPackedPaths(name, packed, [entry, script, stylesheet]);
    for (const path of [entry, script, stylesheet]) {
      assert.ok((await stat(join(packageDirectory, path))).size > 0, `${name}: packed client output is empty: ${path}`);
    }
  }
}

async function filesForManifestEntry(packageDirectory, entry) {
  const normalized = normalizePackagePath(entry).replace(/\/$/, "");
  if (hasGlob(normalized)) {
    const files = await walkFiles(packageDirectory);
    return files.filter(path => matchesGlob(path, normalized));
  }
  const target = join(packageDirectory, normalized);
  if (!existsSync(target)) return [];
  const metadata = await stat(target);
  return metadata.isDirectory() ? walkFiles(target, normalized) : [normalized];
}

async function walkFiles(directory, prefix = "") {
  const entries = await readdir(directory, { withFileTypes: true });
  return (await Promise.all(entries.map(entry => {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    return entry.isDirectory() ? walkFiles(join(directory, entry.name), path) : [path];
  }))).flat();
}

function hasGlob(path) {
  return /[*?[\]{}]/u.test(path);
}

function assertPackedPaths(name, packed, paths) {
  for (const path of paths) {
    assert.equal(typeof path, "string", `${name}: required package asset is missing`);
    assert.ok(packed.has(path), `${name}: required package path is not packed: ${path}`);
  }
}

async function createConsumer(consumerDirectory, packages) {
  await mkdir(consumerDirectory);
  const tarballs = Object.fromEntries([...packages].map(([name, { tarball }]) => [
    name,
    localFileSpec(consumerDirectory, tarball),
  ]));
  const peers = requiredPeers(packages);
  const dependencies = {
    ...tarballs,
    ...peers,
  };
  const externalOverrides = installedDependencyOverrides(packages, Object.keys(peers));
  for (const [name, range] of Object.entries(peers)) {
    assert.ok(
      semver.satisfies(externalOverrides[name], range, { includePrerelease: true }),
      `root install resolves required peer ${name} to ${externalOverrides[name]}, outside ${range}`,
    );
  }
  await Promise.all([
    writeFile(join(consumerDirectory, "package.json"), `${JSON.stringify({
      name: "acpus-packed-consumer",
      private: true,
      type: "module",
      dependencies,
    }, null, 2)}\n`),
    writeFile(join(consumerDirectory, "pnpm-workspace.yaml"), `${JSON.stringify({
      overrides: { ...externalOverrides, ...tarballs },
      storeDir: pnpmState.storeDir,
      minimumReleaseAge: 0,
      trustLockfile: true,
    }, null, 2)}\n`),
    writeFile(join(consumerDirectory, "workflow.ts"), `import { defineWorkflow } from "acpus/core";

export default defineWorkflow({ name: "packed-cli-smoke" }).build(() => ({ ok: true }));
`),
  ]);
}

function installedDependencyOverrides(packages, peerNames) {
  const packageDependencies = [];
  const pending = [];
  for (const { packageDirectory, manifest } of packages.values()) {
    const workspacePackage = packageMap[normalizePackagePath(relative(root, packageDirectory))];
    assert.ok(workspacePackage, `${manifest.name}: missing from root pnpm package map`);
    const dependencies = [
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.optionalDependencies ?? {}),
      ...Object.keys(manifest.peerDependencies ?? {}).filter(
        name => manifest.peerDependenciesMeta?.[name]?.optional !== true,
      ),
    ];
    for (const name of dependencies) {
      if (packages.has(name)) continue;
      const packageId = workspacePackage.dependencies?.[name];
      assert.equal(typeof packageId, "string", `${manifest.name}: ${name} is missing from the root install`);
      packageDependencies.push({ manifest, name, packageId });
      pending.push(packageId);
    }
  }

  const visited = new Set();
  while (pending.length > 0) {
    const packageId = pending.pop();
    if (visited.has(packageId)) continue;
    visited.add(packageId);
    const installed = packageMap[packageId];
    assert.ok(installed, `${packageId}: missing from root pnpm package map`);
    for (const childId of Object.values(installed.dependencies ?? {})) {
      if (childId === packageId || childId.startsWith("packages/")) continue;
      pending.push(childId);
    }
  }

  const versions = new Map();
  for (const packageId of visited) {
    const { name, version } = parsePackageId(packageId);
    const installed = versions.get(name) ?? new Set();
    installed.add(version);
    versions.set(name, installed);
  }

  const overrides = new Map();
  for (const [name, installed] of versions) {
    if (installed.size === 1) setOverride(overrides, name, [...installed][0]);
  }
  for (const packageId of visited) {
    const parent = parsePackageId(packageId);
    for (const [name, childId] of Object.entries(packageMap[packageId].dependencies ?? {})) {
      if (childId === packageId || childId.startsWith("packages/") || versions.get(name)?.size === 1) continue;
      setOverride(overrides, `${parent.name}@${parent.version}>${name}`, parsePackageId(childId).version);
    }
  }
  for (const { manifest, name, packageId } of packageDependencies) {
    const version = parsePackageId(packageId).version;
    if (versions.get(name)?.size !== 1) {
      setOverride(overrides, `${manifest.name}@${manifest.version}>${name}`, version);
    }
    if (peerNames.includes(name)) setOverride(overrides, name, version);
  }
  return Object.fromEntries([...overrides].sort(([left], [right]) => left.localeCompare(right)));
}

function parsePackageId(packageId) {
  const plain = packageId.replace(/\(.*/u, "");
  const separator = plain.startsWith("@")
    ? plain.indexOf("@", plain.indexOf("/") + 1)
    : plain.indexOf("@");
  assert.ok(separator > 0, `invalid pnpm package id: ${packageId}`);
  return { name: plain.slice(0, separator), version: plain.slice(separator + 1) };
}

function setOverride(overrides, selector, version) {
  const existing = overrides.get(selector);
  assert.ok(
    existing === undefined || existing === version,
    `root install resolves ${selector} to both ${existing} and ${version}`,
  );
  overrides.set(selector, version);
}

function requiredPeers(packages) {
  const constraints = new Map();
  for (const { manifest } of packages.values()) {
    for (const [name, range] of Object.entries(manifest.peerDependencies ?? {})) {
      if (manifest.peerDependenciesMeta?.[name]?.optional === true) continue;
      if (packages.has(name)) {
        assert.ok(
          semver.satisfies(packages.get(name).manifest.version, range, { includePrerelease: true }),
          `${manifest.name}: internal peer ${name}@${packages.get(name).manifest.version} is outside ${range}`,
        );
        continue;
      }
      const entries = constraints.get(name) ?? [];
      entries.push({ packageName: manifest.name, range });
      constraints.set(name, entries);
    }
  }

  return Object.fromEntries([...constraints].sort(([left], [right]) => left.localeCompare(right)).map(([name, entries]) => {
    const range = intersectRanges(name, entries);
    return [name, range];
  }));
}

function intersectRanges(name, entries) {
  let sets = [[]];
  for (const { packageName, range } of entries) {
    assert.equal(typeof range, "string", `${packageName}: peer dependency ${name} has an invalid range`);
    const parsed = new semver.Range(range);
    sets = sets.flatMap(current => parsed.set.map(next => [...current, ...next]));
  }
  for (const comparators of sets) {
    const intersection = comparators.map(String).join(" ");
    if (semver.minVersion(intersection)) return intersection || "*";
  }
  assert.fail(`incompatible required peer ${name}: ${entries.map(({ packageName, range }) => `${packageName} ${range}`).join(", ")}`);
}

async function assertConsumerUsesTarballs(consumerDirectory, packages) {
  const { stdout } = await runPnpm(["list", "--json", "--depth", "Infinity"], consumerDirectory);
  const pending = JSON.parse(stdout);
  assert.ok(Array.isArray(pending), "pnpm list did not return a dependency graph");
  const resolutions = new Map([...packages].map(([name]) => [name, new Set()]));
  while (pending.length > 0) {
    const dependency = pending.pop();
    if (!dependency || typeof dependency !== "object") continue;
    if (resolutions.has(dependency.from) && typeof dependency.resolved === "string") {
      resolutions.get(dependency.from).add(dependency.resolved);
    }
    pending.push(...Object.values(dependency.dependencies ?? {}));
  }
  for (const [name, { tarball }] of packages) {
    assert.deepEqual(
      [...resolutions.get(name)],
      [localFileSpec(consumerDirectory, tarball)],
      `consumer resolved ${name} outside its local tarball`,
    );
  }
}

async function verifyPublicEntries(consumerDirectory, packages) {
  const specifiers = [...packages.values()].flatMap(({ manifest }) => runtimeSpecifiers(manifest));
  await writeFile(join(consumerDirectory, "imports.mjs"), [
    ...specifiers
      .filter(specifier => specifier !== "@acpus/dsh/client")
      .map(specifier => `await import(${JSON.stringify(specifier)}).catch(cause => {
  throw new Error(${JSON.stringify("Packed export failed: ")} + ${JSON.stringify(specifier)}, { cause });
});`),
    `import assert from "node:assert/strict";`,
    `import { readFile } from "node:fs/promises";`,
    `import { createRequire } from "node:module";`,
    `import { runInNewContext } from "node:vm";`,
    `const require = createRequire(import.meta.url);`,
    `const browserRequire = specifier => specifier === "@deepseek-ai/dsh-client-ui-primitives"`,
    `  ? { IconUserOutline16() {} }`,
    `  : require(specifier);`,
    `let handoff;`,
    `runInNewContext(await readFile(require.resolve("@acpus/dsh/client"), "utf8"), {`,
    `  window: { __ModuleLoader__: { load(value) { handoff = value; } } },`,
    `});`,
    `assert.equal(handoff.id, "@acpus/dsh");`,
    `assert.equal(typeof handoff.factory, "function");`,
    `assert.equal(typeof handoff.factory(browserRequire).apply, "function");`,
    "",
  ].join("\n"));
  await execFileAsync(process.execPath, [join(consumerDirectory, "imports.mjs")], {
    cwd: consumerDirectory,
    env: smokeEnvironment(consumerDirectory),
  });
}

function runtimeSpecifiers(manifest) {
  if (!manifest.exports) {
    return hasJavaScriptTarget(manifest.main) ? [manifest.name] : [];
  }
  if (!isSubpathExports(manifest.exports)) {
    return hasJavaScriptTarget(manifest.exports) ? [manifest.name] : [];
  }
  return Object.entries(manifest.exports)
    .filter(([, target]) => hasJavaScriptTarget(target))
    .map(([subpath]) => subpath === "." ? manifest.name : `${manifest.name}${subpath.slice(1)}`);
}

function isSubpathExports(exports) {
  return exports && typeof exports === "object" && !Array.isArray(exports)
    && Object.keys(exports).some(key => key.startsWith("."));
}

function hasJavaScriptTarget(value, condition = "") {
  if (condition === "development" || condition === "types") return false;
  if (typeof value === "string") return /\.(?:c|m)?js$/u.test(value);
  if (Array.isArray(value)) return value.some(target => hasJavaScriptTarget(target));
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(([key, target]) => hasJavaScriptTarget(target, key));
}

async function verifyPackedCli(consumerDirectory) {
  const cliEntry = join(consumerDirectory, "node_modules", "acpus", "dist", "cli.js");
  const { stdout, stderr } = await execFileAsync(process.execPath, [
    cliEntry,
    "workflow",
    "check",
    join(consumerDirectory, "workflow.ts"),
  ], {
    cwd: consumerDirectory,
    env: smokeEnvironment(consumerDirectory),
  });
  assert.equal(stderr, "", "packed CLI workflow check wrote to stderr");
  assert.match(stdout, /WorkflowIR\s+0 errors/u, "packed CLI workflow check failed");
}

function execFileAsync(file, args, options) {
  return new Promise((resolvePromise, reject) => {
    const subprocess = execFile(file, args, options, (error, stdout, stderr) => {
      subprocesses.delete(subprocess);
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolvePromise({ stdout, stderr });
    });
    subprocesses.add(subprocess);
  });
}

function runPnpm(args, cwd) {
  const options = { cwd, env: smokeEnvironment(temporaryRoot), maxBuffer: pnpmOutputMaxBuffer };
  if (process.env.npm_execpath && existsSync(process.env.npm_execpath)) {
    return execFileAsync(process.execPath, [process.env.npm_execpath, ...args], options);
  }
  return process.platform === "win32"
    ? execFileAsync(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", "pnpm", ...args], options)
    : execFileAsync("pnpm", args, options);
}

function smokeEnvironment(home) {
  const environment = {
    ...process.env,
    CI: "1",
    FORCE_COLOR: "0",
    HOME: home,
    USERPROFILE: home,
    XDG_CACHE_HOME: packageCacheRoot,
    XDG_CONFIG_HOME: join(home, ".config"),
    NODE_NO_WARNINGS: "1",
    NODE_OPTIONS: "",
    NODE_PATH: "",
  };
  for (const name of Object.keys(environment)) {
    if (/^npm_config_/iu.test(name)) delete environment[name];
  }
  return environment;
}

function localFileSpec(fromDirectory, target) {
  const path = relative(fromDirectory, target).replaceAll("\\", "/");
  return `file:${path.startsWith(".") ? path : `./${path}`}`;
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

function normalizePackagePath(path) {
  return path.replace(/^\.\//, "").replaceAll("\\", "/");
}
