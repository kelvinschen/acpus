import { access, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const projects = {
  "agent-executor": [],
  expression: [],
  core: ["expression"],
  tasks: ["core"],
  loader: [],
  "workflow-compiler": ["core", "expression", "loader"],
  runtime: ["agent-executor", "core", "expression", "loader"],
  web: ["core", "expression", "runtime", "workflow-compiler"],
  cli: ["core", "expression", "loader", "runtime", "tasks", "web", "workflow-compiler"],
};
const foundation = ["agent-executor", "expression", "core", "tasks", "loader", "workflow-compiler", "runtime"];
const allProjects = [...foundation, "web", "cli"];

const rootManifest = await json("package.json");
const manifests = new Map();

for (const [name, dependencies] of Object.entries(projects)) {
  const packageRoot = `packages/${name}`;
  const manifest = await json(`${packageRoot}/package.json`);
  const development = await json(`${packageRoot}/tsconfig.json`);
  const build = await json(`${packageRoot}/tsconfig.build.json`);

  manifests.set(name, manifest);
  equal(development.compilerOptions?.customConditions, ["development"], `${name} development conditions`);
  equal(build.extends, "./tsconfig.json", `${name} build config base`);
  equal(build.compilerOptions?.composite, true, `${name} composite build`);
  equal(build.compilerOptions?.customConditions, [], `${name} build conditions`);
  equal(build.compilerOptions?.tsBuildInfoFile, "./tsconfig.build.tsbuildinfo", `${name} build cache`);
  equal(build.references ?? [], dependencies.map(dependency => ({ path: `../${dependency}/tsconfig.build.json` })), `${name} project references`);

  if (name === "web") {
    equal(build.include, ["src/index.ts", "src/server/**/*.ts"], "web server-only TypeScript build boundary");
    equal(manifest.scripts?.build, "node scripts/build.mjs", "web build script");
    equal(manifest.scripts?.clean, "rm -rf dist .static-viz-build tsconfig.build.tsbuildinfo", "web clean script");
  } else {
    equal(manifest.scripts?.build, "tsc -b tsconfig.build.json", `${name} build script`);
    equal(manifest.scripts?.clean, "rm -rf dist tsconfig.build.tsbuildinfo", `${name} clean script`);
  }
}

equal((await json("tsconfig.build.foundation.json")).references, solutionReferences(foundation), "foundation solution");
equal((await json("tsconfig.build.json")).references, solutionReferences(allProjects), "full solution");
equal(rootManifest.scripts?.build, "node scripts/build.mjs", "root build script");
equal(rootManifest.scripts?.["build:clean"], "pnpm clean && pnpm build", "clean build script");
equal(rootManifest.scripts?.typecheck, "pnpm -r typecheck", "root typecheck script");
equal(rootManifest.scripts?.["check:build-toolchain"], "node scripts/verify-build-toolchain.mjs", "toolchain check script");
equal(rootManifest.scripts?.["version-packages"], "changeset version && node scripts/sync-acpus-skill-version.mjs && pnpm install --lockfile-only", "version packages script");
const cliManifest = manifests.get("cli");
const skillVersion = (await text("packages/cli/skills/acpus/SKILL.md")).match(/^\s+acpus-version:\s*([^\s#]+)/mu)?.[1];
equal(skillVersion, cliManifest.version, "bundled Acpus skill version");

const buildScript = await text("scripts/build.mjs");
ordered(buildScript, ["tsconfig.build.foundation.json", "build-static-viz.mjs", "tsconfig.build.json"], "root build stages");
assert(!buildScript.includes("packages/web/scripts/build.mjs"), "root build MUST overlap the Web bundle and full TypeScript build");
assert((await text(".gitignore")).split(/\r?\n/u).includes("*.tsbuildinfo"), ".gitignore MUST ignore package build caches");

equal(rootManifest.devDependencies?.typescript, "7.0.2", "root TypeScript version");
equal(manifests.get("workflow-compiler").dependencies?.typescript, "7.0.2", "workflow compiler TypeScript version");
equal(rootManifest.devDependencies?.vitest, "^4.1.10", "Vitest version");

const webDependencies = manifests.get("web").devDependencies;
equal(webDependencies?.vite, "^8.1.4", "Vite version");
equal(webDependencies?.["@vitejs/plugin-react"], "^6.0.3", "Vite React plugin version");
equal(webDependencies?.tailwindcss, "^4.3.2", "Tailwind version");
equal(webDependencies?.["@tailwindcss/vite"], "^4.3.2", "Tailwind Vite plugin version");

for (const [name, manifest] of [["workspace", rootManifest], ...manifests]) {
  equal(manifest.engines?.node, ">=22.12", `${name} Node engine`);
  const declarations = { ...manifest.dependencies, ...manifest.devDependencies };
  if (declarations.typescript !== undefined) equal(declarations.typescript, "7.0.2", `${name} TypeScript declaration`);
  if (declarations.tsx !== undefined) equal(declarations.tsx, "^4.23.0", `${name} tsx declaration`);
  if (declarations["@types/node"] !== undefined) equal(declarations["@types/node"], "^22.20.1", `${name} Node types declaration`);
  for (const forbidden of ["@typescript/native-preview", "@typescript/typescript6", "turbo", "nx"]) {
    assert(declarations[forbidden] === undefined, `${name} MUST NOT declare ${forbidden}`);
  }
  for (const script of Object.values(manifest.scripts ?? {})) {
    assert(!/(?:^|\s)(?:turbo|nx)(?:\s|$)/u.test(script), `${name} scripts MUST NOT invoke Turbo or Nx`);
  }
}

for (const forbiddenConfig of ["turbo.json", "nx.json"]) {
  assert(!(await exists(forbiddenConfig)), `${forbiddenConfig} MUST NOT exist`);
}

console.log("Build toolchain configuration is valid.");

function solutionReferences(names) {
  return names.map(name => ({ path: `./packages/${name}/tsconfig.build.json` }));
}

async function json(path) {
  return JSON.parse(await text(path));
}

async function text(path) {
  return readFile(join(root, path), "utf8");
}

async function exists(path) {
  try {
    await access(join(root, path));
    return true;
  } catch {
    return false;
  }
}

function ordered(value, markers, label) {
  let position = -1;
  for (const marker of markers) {
    const next = value.indexOf(marker, position + 1);
    assert(next > position, `${label} MUST contain ${marker} in order`);
    position = next;
  }
}

function equal(actual, expected, label) {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  assert(actualJson === expectedJson, `${label}: expected ${expectedJson}, received ${actualJson}`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
