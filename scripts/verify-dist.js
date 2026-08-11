import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, matchesGlob, relative, resolve, sep } from "node:path";
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

const artifactsRoot = await mkdtemp(join(tmpdir(), "acpus-packed-artifacts-"));
try {
  const packages = await packPublishedPackages(artifactsRoot);
  await verifyPackedWorkflowCompiler(packages);
  await verifyPackedCli(packages);
} finally {
  await rm(artifactsRoot, { recursive: true, force: true });
}

const workspace = await mkdtemp(join(tmpdir(), "acpus-dist-smoke-"));

try {
  await symlink(join(root, "node_modules"), join(workspace, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  const workflow = join(workspace, "workflow.ts");
  await cp(join(root, "packages/cli/test/fixtures/workflows/concurrency/short-task.workflow.ts"), workflow);
  await writeFile(join(workspace, "input.json"), "{}\n");

  const submitted = await execFileAsync(process.execPath, [
    join(root, "packages/cli/dist/cli.js"), "workflow", "run", workflow, "--input", "input.json",
  ], {
    cwd: workspace,
    env: cliEnvironment(),
  });
  assert.equal(submitted.stderr, "");

  const receipt = /^Run (\d{14}[A-F0-9]{20})  cli-concurrency-short-task  pending\nInspect: acpus runs inspect \1$/mu.exec(submitted.stdout);
  assert.ok(receipt, "workflow run must print a self-consistent inspection receipt");

  const followed = await execFileAsync(process.execPath, [
    join(root, "packages/cli/dist/cli.js"), "runs", "inspect", receipt[1], "--follow",
  ], {
    cwd: workspace,
    env: cliEnvironment(),
  });
  assert.equal(followed.stderr, "");
  assert.match(followed.stdout, new RegExp(`Run ${receipt[1]}  cli-concurrency-short-task  completed`));
  assert.match(followed.stdout, /Output:\n  \{\n    "ok": true\n  \}/u);
} finally {
  await requestDaemonShutdown(workspace);
  await rm(workspace, { recursive: true, force: true });
}

async function packPublishedPackages(destination) {
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
  const packed = new Map();
  for (const { packageDirectory, manifest } of packages) {
    const artifact = await packPackage(packageDirectory, manifest, destination);
    await verifyPackage(packageDirectory, manifest, artifact.files);
    assert.equal(packed.has(manifest.name), false, `duplicate published package: ${manifest.name}`);
    packed.set(manifest.name, { manifest, tarball: artifact.tarball });
  }
  return packed;
}

async function verifyPackedWorkflowCompiler(packages) {
  const workspace = await mkdtemp(join(tmpdir(), "acpus-packed-consumer-"));
  try {
    const consumerDirectory = join(workspace, "consumer");
    await mkdir(consumerDirectory);

    const tarballs = packedDependencyClosure("@acpus/workflow-compiler", packages);
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
    }, null, 2)}\n`);
    await writePnpmWorkspace(consumerDirectory, fileSpecs);
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

const prepared = await prepareWorkflow({
  workspaceDir: process.cwd(),
  source: { kind: "path", entry: "valid.workflow.ts" },
});
assert.equal(prepared.ir.name, "packed-consumer");
assert.deepEqual(prepared.ir.diagnostics, []);

const checked = await tryPrepareWorkflow({
  workspaceDir: process.cwd(),
  source: { kind: "path", entry: "invalid.workflow.ts" },
});
assert.equal(checked.isErr(), true, "invalid workflow unexpectedly prepared");
if (checked.isOk()) throw new Error("invalid workflow unexpectedly prepared");
assert.equal(checked.error.type, "check-failed");
assert.ok(checked.error.diagnostics.some(diagnostic => diagnostic.code === "TS2322"), "TS7 check did not report TS2322");
`);

    await runPnpm(["install", "--ignore-scripts", "--no-frozen-lockfile", "--reporter=append-only"], consumerDirectory);
    await assertConsumerUsesTarballs(consumerDirectory, tarballs);
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
    const consumerDirectory = join(workspace, "consumer");
    await mkdir(consumerDirectory);

    const tarballs = packedDependencyClosure("acpus", packages);
    const fileSpecs = Object.fromEntries([...tarballs].map(([name, tarball]) => [
      name,
      localFileSpec(consumerDirectory, tarball),
    ]));
    await writeFile(join(consumerDirectory, "package.json"), `${JSON.stringify({
      name: "acpus-packed-cli-smoke",
      private: true,
      type: "module",
      dependencies: { acpus: fileSpecs.acpus },
    }, null, 2)}\n`);
    await writePnpmWorkspace(consumerDirectory, fileSpecs);
    await runPnpm(["install", "--ignore-scripts", "--no-frozen-lockfile", "--reporter=append-only"], consumerDirectory);
    await assertConsumerUsesTarballs(consumerDirectory, tarballs);

    const cliEntry = join(consumerDirectory, "node_modules", "acpus", "dist", "cli.js");
    const homeDirectory = join(consumerDirectory, "home");
    await mkdir(homeDirectory);
    const environment = { ...cliEnvironment(), HOME: homeDirectory, USERPROFILE: homeDirectory };
    const runCli = async (args, cwd = consumerDirectory) => {
      const result = await execFileAsync(process.execPath, [cliEntry, ...args], { cwd, env: environment });
      assert.equal(result.stderr, "", `packed CLI wrote to stderr: ${args.join(" ")}`);
      return result;
    };

    const help = await runCli(["--help"]);
    assert.match(help.stdout, /Usage: acpus/u);
    const version = await runCli(["--version"]);
    assert.equal(version.stdout.trim(), packages.get("acpus").manifest.version);

    const doctor = await runCli(["doctor"]);
    assert.match(doctor.stdout, /^Doctor checks passed\.$/mu);
    const authoringTypes = doctor.stdout.split("\n")
      .filter(line => line.startsWith("  acpus/"))
      .map(line => {
        const [specifier, typesPath] = line.trim().split(/\s{2,}/u);
        return { specifier, typesPath };
      });
    assert.deepEqual(authoringTypes.map(({ specifier }) => specifier), [
      "acpus/core",
      "acpus/expression",
      "acpus/tasks/git",
    ]);
    for (const { specifier, typesPath } of authoringTypes) {
      assert.equal(typeof typesPath, "string", `${specifier} has no declaration path`);
      assert.equal(isAbsolute(typesPath), true, `${specifier} declaration path is not absolute`);
      const consumerRelativePath = relative(consumerDirectory, typesPath);
      assert.equal(
        consumerRelativePath === ".." || consumerRelativePath.startsWith(`..${sep}`) || isAbsolute(consumerRelativePath),
        false,
        `${specifier} declaration path resolved outside the packed consumer`,
      );
      assert.equal(existsSync(typesPath), true, `${specifier} declaration path is missing`);
    }

    const workflowSource = `import { defineWorkflow } from "acpus/core";

export default defineWorkflow({ name: "packed-cli-smoke" }).build(({ step }) => {
  const result = step("produce").task({
    input: null,
    exec: async () => ({ ok: true }),
  });
  return { ok: result.output.ok };
});
`;
    const representativeWorkflow = join(consumerDirectory, "packed-cli.workflow.ts");
    await writeFile(representativeWorkflow, workflowSource);
    const checked = await runCli(["workflow", "check", representativeWorkflow]);
    assert.match(checked.stdout, /WorkflowIR\s+0 errors/u, "packed CLI workflow check failed");

    const externalPackageRoot = join(workspace, "external-installation", "node_modules", "acpus");
    await mkdir(dirname(externalPackageRoot), { recursive: true });
    await cp(join(consumerDirectory, "node_modules", "acpus"), externalPackageRoot, {
      recursive: true,
      dereference: true,
    });
    const externalWorkspace = join(workspace, "external-workspace");
    await mkdir(externalWorkspace);
    await Promise.all([
      writeFile(join(externalWorkspace, "tsconfig.json"), `${JSON.stringify({
        compilerOptions: { noLib: true, types: [] },
        files: ["unrelated.ts"],
      }, null, 2)}\n`),
      writeFile(join(externalWorkspace, "unrelated.ts"), "const value: string = 1;\n"),
    ]);
    const externalWorkflow = join(externalPackageRoot, "packed-cli.workflow.ts");
    await writeFile(externalWorkflow, workflowSource);
    const externalChecked = await runCli(["workflow", "check", externalWorkflow], externalWorkspace);
    assert.match(
      externalChecked.stdout,
      /WorkflowIR\s+0 errors/u,
      "packed CLI failed to check an installed workflow from an external workspace",
    );

    const visualizationPath = join(consumerDirectory, "workflow-viz.html");
    await runCli(["workflow", "viz", representativeWorkflow, "--out", visualizationPath]);
    const visualizationHtml = await readFile(visualizationPath, "utf8");
    const marker = "window.__ACPUS_WORKFLOW_VIZ__=";
    const bundleStart = visualizationHtml.indexOf(marker);
    const bundleJsonStart = bundleStart + marker.length;
    const bundleJsonEnd = visualizationHtml.indexOf(";\n</script>", bundleJsonStart);
    assert.ok(bundleStart >= 0 && bundleJsonEnd >= 0, "packed CLI HTML visualization has no embedded bundle");
    const visualization = JSON.parse(visualizationHtml.slice(bundleJsonStart, bundleJsonEnd));
    assert.equal(visualization.workflow.name, "packed-cli-smoke");
    assert.equal(visualization.graph.mode, "static");
    assert.ok(
      visualization.graph.nodes.some(node => node.id === "produce" && node.kind === "task"),
      "packed CLI HTML visualization omitted the workflow graph",
    );
    assert.match(visualization.sourceGraphDigest, /^sha256:[a-f0-9]{64}$/u);

    const installed = await runCli(["skill", "install", "--project", "--agent", "universal,claude"]);
    assert.match(installed.stdout, /installed\s+universal/u);
    assert.match(installed.stdout, /installed\s+claude/u);
    const aligned = await runCli(["doctor"]);
    assert.match(aligned.stdout, /^Doctor checks passed\.$/mu);
    assert.doesNotMatch(aligned.stdout, /\bstale\b/iu);

    const installedSkill = join(consumerDirectory, ".agents", "skills", "acpus", "SKILL.md");
    await writeFile(installedSkill, (await readFile(installedSkill, "utf8")).replace(/acpus-version:\s*[^\s]+/, "acpus-version: 0.0.0"));
    const stale = await runCli(["doctor"]);
    assert.match(stale.stdout, /^Doctor checks passed with warnings\.$/mu);
    assert.match(
      stale.stdout,
      /^warn\s+skill\s+Installed universal Acpus skill is stale; run 'acpus skill install --project --agent universal'\.$/mu,
    );

    const installedManifestPath = join(consumerDirectory, "node_modules", "acpus", "package.json");
    const installedManifestSource = await readFile(installedManifestPath, "utf8");
    const installedManifest = JSON.parse(installedManifestSource);
    installedManifest.dependencies["@acpus/core"] = "0.0.0";
    await writeFile(installedManifestPath, `${JSON.stringify(installedManifest, null, 2)}\n`);
    await assert.rejects(runCli(["doctor"]), error => {
      assert.equal(error.code, 1);
      assert.equal(error.stdout, "");
      assert.match(error.stderr, /^Doctor checks failed\.$/mu);
      assert.match(
        error.stderr,
        /^fail\s+authoring\s+Resolved authoring package versions do not match the acpus package manifest\.$/mu,
      );
      return true;
    });
    await writeFile(installedManifestPath, installedManifestSource);

    const bundledSkill = join(consumerDirectory, "node_modules", "acpus", "skills", "acpus", "SKILL.md");
    await writeFile(bundledSkill, (await readFile(bundledSkill, "utf8")).replace(/acpus-version:\s*[^\s]+/, "acpus-version: 0.0.0"));
    await assert.rejects(runCli(["skill", "read"]), error => {
      assert.equal(error.code, 1);
      assert.equal(error.stdout, "");
      assert.equal(
        error.stderr,
        "Bundled Acpus skill is missing or does not match this acpus package version.\n",
      );
      return true;
    });
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

function packedDependencyClosure(rootName, packages) {
  const closure = new Map();
  const pending = [rootName];
  while (pending.length > 0) {
    const name = pending.pop();
    if (closure.has(name)) continue;
    const pkg = packages.get(name);
    assert.ok(pkg, `packed smoke root is not publishable: ${name}`);
    closure.set(name, pkg.tarball);
    for (const [dependency, specifier] of Object.entries(pkg.manifest.dependencies ?? {})) {
      if (packages.has(dependency)) pending.push(dependency);
      else assert.ok(
        typeof specifier !== "string" || !specifier.startsWith("workspace:"),
        `${name}: workspace dependency is not publishable: ${dependency}`,
      );
    }
  }
  return new Map([...closure].sort(([left], [right]) => left.localeCompare(right)));
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

async function assertConsumerUsesTarballs(consumerDirectory, tarballs) {
  const { stdout } = await runPnpm(["list", "--json", "--depth", "Infinity"], consumerDirectory);
  const pending = JSON.parse(stdout);
  assert.ok(Array.isArray(pending), "pnpm list did not return a dependency graph");
  const installed = new Set();
  while (pending.length > 0) {
    const dependency = pending.pop();
    if (!dependency || typeof dependency !== "object") continue;
    if (typeof dependency.from === "string" && typeof dependency.resolved === "string") {
      installed.add(JSON.stringify([dependency.from, dependency.resolved]));
    }
    pending.push(...Object.values(dependency.dependencies ?? {}));
  }
  for (const [name, tarball] of tarballs) {
    const resolution = localFileSpec(consumerDirectory, tarball);
    assert.ok(
      installed.has(JSON.stringify([name, resolution])),
      `consumer did not install ${name} from ${resolution}`,
    );
  }
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

function writePnpmWorkspace(directory, overrides) {
  return writeFile(join(directory, "pnpm-workspace.yaml"), `${JSON.stringify({ overrides }, null, 2)}\n`);
}

function smokeEnvironment() {
  return {
    ...cliEnvironment(),
    NODE_NO_WARNINGS: "1",
    NODE_OPTIONS: "",
  };
}

function cliEnvironment() {
  const environment = { ...process.env, CI: "1", FORCE_COLOR: "0", NODE_PATH: "" };
  delete environment.NODE_NO_WARNINGS;
  delete environment.NODE_OPTIONS;
  return environment;
}

function localFileSpec(fromDirectory, target) {
  const path = relative(fromDirectory, target).replaceAll("\\", "/");
  return `file:${path.startsWith(".") ? path : `./${path}`}`;
}

async function verifyPackage(packageDirectory, manifest, files) {
  const name = manifest.name ?? packageDirectory;
  const packed = new Set(files.map(file => normalizePackagePath(file.path)));

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

  if (name === "@acpus/web") {
    const clientEntry = "dist/client/index.html";
    const clientAssets = [...packed].filter(path => path.startsWith("dist/client/assets/"));
    const clientScript = clientAssets.find(path => path.endsWith(".js"));
    const clientStylesheet = clientAssets.find(path => path.endsWith(".css"));
    assert.ok(packed.has(clientEntry), `${name}: Vite client entry is not packed`);
    assert.ok(clientScript, `${name}: Vite client script is not packed`);
    assert.ok(clientStylesheet, `${name}: Vite client stylesheet is not packed`);
    for (const path of [clientEntry, clientScript, clientStylesheet]) {
      assert.ok((await readFile(join(packageDirectory, path))).byteLength > 0, `${name}: packed client output is empty: ${path}`);
    }

    const declarationPath = "dist/server/static-viz-assets.generated.d.ts";
    assert.ok(packed.has(declarationPath), `${name}: static visualization declaration is not packed`);
    const declaration = await readFile(join(packageDirectory, declarationPath), "utf8");
    assert.ok(
      Buffer.byteLength(declaration) < 4 * 1024,
      `${name}: static visualization declaration embeds its asset payload`,
    );
    assert.deepEqual(
      [...declaration.matchAll(/^export declare const (\w+): ([^;]+);$/gmu)]
        .map(([, identifier, type]) => [identifier, type]),
      [["staticVizJs", "string"], ["staticVizCss", "string"]],
      `${name}: static visualization declarations must expose two opaque strings`,
    );
  }

  if (name === "acpus") {
    for (const path of [
      "skills/acpus/SKILL.md",
      "dist/skill/command.js",
      "dist/skill/command.d.ts",
      "dist/update-awareness-worker.js",
      "dist/update-awareness-worker.d.ts",
    ]) {
      assert.ok(packed.has(path), `${name}: required package path is not packed: ${path}`);
    }
  }
  for (const { target } of binTargets(manifest.bin)) {
    const path = normalizePackagePath(target);
    assert.match(await readFile(join(packageDirectory, path), "utf8"), /^#![^\n]+/, `${name}: bin has no shebang: ${target}`);
  }
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
