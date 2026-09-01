import { access, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const projects = {
  "owned-process": [],
  acp: ["owned-process"],
  "agent-executor": ["acp", "owned-process"],
  "agent-teams": ["agent-executor", "owned-process"],
  expression: [],
  core: ["expression"],
  tasks: ["core"],
  loader: [],
  "workflow-compiler": ["core", "expression", "loader", "owned-process"],
  runtime: ["agent-executor", "core", "expression", "loader", "owned-process"],
  dsh: ["agent-executor", "core", "expression", "loader", "runtime", "workflow-compiler"],
  web: ["core", "expression", "runtime", "workflow-compiler"],
  cli: ["core", "expression", "loader", "runtime", "tasks", "web", "workflow-compiler"],
};
const foundation = ["owned-process", "acp", "agent-executor", "expression", "core", "tasks", "loader", "workflow-compiler", "runtime"];
const allProjects = ["owned-process", "acp", "agent-executor", "agent-teams", "dsh", "expression", "core", "tasks", "loader", "workflow-compiler", "runtime", "web", "cli"];
const expectedPnpmWorkspace = `packages:
  - "packages/*"

allowBuilds:
  '@deepseek-ai/dsh-subprocess-local': true
  '@google/genai': false
  esbuild: true
  koffi: true
  msgpackr-extract: false
  node-pty: true
  protobufjs: false
blockExoticSubdeps: true
minimumReleaseAge: 0
strictDepBuilds: true
trustLockfile: false
`;

const rootManifest = await json("package.json");
const packageConfig = await json("tsconfig.package.json");
const testConfig = await json("tsconfig.vitest.json");
const manifests = new Map();

equal(packageConfig, {
  extends: "./tsconfig.base.json",
  compilerOptions: {
    types: ["node"],
    lib: ["ES2022"],
    customConditions: ["development"],
    exactOptionalPropertyTypes: true,
    noUncheckedIndexedAccess: true,
    verbatimModuleSyntax: true,
  },
}, "shared package TypeScript configuration");
equal(testConfig, {
  extends: "./tsconfig.package.json",
  compilerOptions: {
    lib: ["ES2022", "DOM", "DOM.Iterable"],
    jsx: "react-jsx",
    types: ["node", "vitest"],
    noEmit: true,
  },
  include: [
    "packages/*/src/**/*.ts",
    "packages/*/src/**/*.tsx",
    "packages/*/test/**/*.ts",
  ],
}, "test TypeScript configuration");

for (const [name, dependencies] of Object.entries(projects)) {
  const packageRoot = `packages/${name}`;
  const manifest = await json(`${packageRoot}/package.json`);
  const development = await json(`${packageRoot}/tsconfig.json`);
  const build = await json(`${packageRoot}/tsconfig.build.json`);

  manifests.set(name, manifest);
  equal(development.extends, "../../tsconfig.package.json", `${name} shared development configuration`);
  equal(
    development.compilerOptions,
    {
      rootDir: "src",
      outDir: "dist",
      ...(name === "core" ? { lib: ["ES2022", "DOM"] } : {}),
      ...(name === "web" ? {
        lib: ["ES2022", "DOM", "DOM.Iterable"],
        jsx: "react-jsx",
      } : {}),
      ...(name === "dsh" ? {
        jsx: "react-jsx",
        lib: ["ES2022", "DOM"],
      } : {}),
    },
    `${name} development compiler overrides`,
  );
  equal(build.extends, "./tsconfig.json", `${name} build config base`);
  equal(build.compilerOptions, {
    composite: true,
    customConditions: [],
    tsBuildInfoFile: "./tsconfig.build.tsbuildinfo",
  }, `${name} build compiler overrides`);
  equal(build.references ?? [], dependencies.map(dependency => ({ path: `../${dependency}/tsconfig.build.json` })), `${name} project references`);

  if (name === "web") {
    equal(manifest.scripts?.build, "node ../../scripts/build.mjs package", "web build script");
    equal(manifest.scripts?.clean, "rm -rf dist .static-viz-build tsconfig.build.tsbuildinfo", "web clean script");
  } else if (name === "dsh") {
    equal(
      manifest.scripts?.build,
      "node scripts/generate-supervisor-preset.mjs && tsc -b tsconfig.build.json && node scripts/remote-artifacts.mjs publish && node scripts/build-client.mjs",
      "dsh build script",
    );
    equal(manifest.scripts?.["remote:generate"], "node scripts/remote-artifacts.mjs generate", "dsh Remote generation script");
    equal(manifest.scripts?.["remote:check"], "node scripts/remote-artifacts.mjs check", "dsh Remote check script");
    equal(manifest.scripts?.clean, "rm -rf dist tsconfig.build.tsbuildinfo", "dsh clean script");
  } else {
    equal(manifest.scripts?.build, "tsc -b tsconfig.build.json", `${name} build script`);
    equal(manifest.scripts?.clean, "rm -rf dist tsconfig.build.tsbuildinfo", `${name} clean script`);
  }
}

equal((await json("tsconfig.build.foundation.json")).references, solutionReferences(foundation), "foundation solution");
equal((await json("tsconfig.build.json")).references, solutionReferences(allProjects), "full solution");
equal(rootManifest.packageManager, "pnpm@11.15.1", "pnpm version");
equal(await text("pnpm-workspace.yaml"), expectedPnpmWorkspace, "pnpm workspace policy");
equal(rootManifest.scripts?.build, "node scripts/build.mjs workspace", "root build script");
equal(rootManifest.scripts?.["build:clean"], "pnpm clean && pnpm build", "clean build script");
equal(rootManifest.scripts?.clean, "pnpm -r run clean", "root clean script");
equal(rootManifest.scripts?.typecheck, "pnpm -r typecheck && pnpm typecheck:tests", "root typecheck script");
equal(rootManifest.scripts?.["typecheck:tests"], "tsc -p tsconfig.vitest.json --noEmit", "test typecheck script");
equal(rootManifest.scripts?.check, "node scripts/checks/index.mjs", "root check script");
for (const legacy of [
  "check:build-toolchain",
  "check:dead-code",
  "check:dependencies",
  "check:dependencies:strict",
  "check:docs",
  "check:release",
  "check:security",
]) {
  equal(rootManifest.scripts?.[legacy], undefined, `${legacy} legacy check script`);
}
equal(rootManifest.scripts?.["version-packages"], "changeset version && node scripts/sync-acpus-skill-version.mjs && pnpm install --lockfile-only", "version packages script");
equal(rootManifest.scripts?.["ci:publish"], "pnpm check release && changeset publish", "publish script");

for (const path of [
  "scripts/checks/index.mjs",
  "scripts/checks/docs.mjs",
  "scripts/checks/effect-architecture.mjs",
  "scripts/checks/release.mjs",
  "scripts/checks/toolchain.mjs",
  "packages/dsh/scripts/remote-artifacts.mjs",
]) {
  assert(await exists(path), `${path} MUST exist`);
}

const ciWorkflow = await text(".github/workflows/ci.yml");
const publishWorkflow = await text(".github/workflows/publish.yml");
assert(ciWorkflow.includes("        node-version:\n          - 22.18.0\n          - 24.x\n"), "CI MUST test only the minimum and latest Node versions");
equal(checkCommands(ciWorkflow), ["pnpm check toolchain", "pnpm check"], "CI check commands");
equal(checkCommands(publishWorkflow), ["pnpm check", "pnpm check security"], "publish check commands");
assert(
  ciWorkflow.includes("if: matrix.node-version == '22.18.0'\n        run: pnpm check toolchain"),
  "CI MUST run the toolchain check on the minimum Node version",
);
assert(
  ciWorkflow.includes("if: matrix.node-version == '24.x'\n        run: pnpm check"),
  "CI MUST run repository policy once on the primary Node version",
);
assert(!ciWorkflow.includes("pnpm check:"), "CI MUST use the canonical check interface");
assert(!publishWorkflow.includes("pnpm check:"), "publish MUST use the canonical check interface");
for (const [name, workflow, expectedSetups] of [["CI", ciWorkflow, 1], ["publish", publishWorkflow, 2]]) {
  const setupBlocks = workflow.split(/(?=^\s*- uses:)/mu).filter(block => block.includes("pnpm/action-setup@"));
  equal(setupBlocks.length, expectedSetups, `${name} pnpm setup count`);
  for (const block of setupBlocks) assert(!/^\s+version:/mu.test(block), `${name} pnpm setup MUST use packageManager`);
}
assert(/^\s+PNPM_CONFIG_PROVENANCE: true$/mu.test(publishWorkflow), "publish workflow MUST enable pnpm provenance");
assert(!/^\s+NPM_CONFIG_PROVENANCE:/mu.test(publishWorkflow), "publish workflow MUST NOT use npm provenance configuration");
assert(
  publishWorkflow.includes(`test "pnpm@$(pnpm --version)" = "$(node -p 'require("./package.json").packageManager')"`),
  "publish workflow MUST verify pnpm against the root packageManager",
);
assert(!publishWorkflow.includes(rootManifest.packageManager), "publish workflow MUST NOT duplicate the pinned pnpm version");
assert(publishWorkflow.includes('test "$(pnpm config get provenance)" = "true"'), "publish workflow MUST verify provenance");

const cliManifest = manifests.get("cli");
const skillVersion = (await text("packages/cli/skills/acpus/SKILL.md")).match(/^\s+acpus-version:\s*([^\s#]+)/mu)?.[1];
equal(skillVersion, cliManifest.version, "bundled Acpus skill version");

assert((await text(".gitignore")).split(/\r?\n/u).includes("*.tsbuildinfo"), ".gitignore MUST ignore package build caches");

equal(rootManifest.devDependencies?.typescript, "7.0.2", "root TypeScript version");
equal(manifests.get("workflow-compiler").dependencies?.typescript, "7.0.2", "workflow compiler TypeScript version");
equal(rootManifest.devDependencies?.vitest, "^4.1.10", "Vitest version");

const webManifest = manifests.get("web");
const webDependencies = webManifest.devDependencies;
equal(webDependencies?.vite, "^8.1.4", "Vite version");
equal(webDependencies?.["@vitejs/plugin-react"], "^6.0.3", "Vite React plugin version");
equal(webDependencies?.tailwindcss, "^4.3.2", "Tailwind version");
equal(webDependencies?.["@tailwindcss/vite"], "^4.3.2", "Tailwind Vite plugin version");
for (const field of ["optionalDependencies", "peerDependencies", "peerDependenciesMeta", "bundledDependencies", "bundleDependencies"]) {
  equal(webManifest[field], undefined, `web ${field}`);
}

for (const [name, manifest] of [["workspace", rootManifest], ...manifests]) {
  equal(manifest.engines?.node, "^22.18.0 || >=24.0.0", `${name} Node engine`);
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

function checkCommands(workflow) {
  return [...workflow.matchAll(/^\s+(?:-\s+)?run: (pnpm check(?:[ \t]+\S+)*)$/gmu)]
    .map(match => match[1]);
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

function equal(actual, expected, label) {
  assert(
    isDeepStrictEqual(actual, expected),
    `${label}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`,
  );
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
