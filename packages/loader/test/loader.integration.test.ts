import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { access, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { importAuthoringModule, officialAuthoringEnvironment, officialAuthoringTypeScriptPaths } from "../src/index.js";

const execFileAsync = promisify(execFile);
const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const coreEntry = new URL("../../core/src/index.ts", import.meta.url).href;
const loaderEntry = pathToFileURL(fileURLToPath(new URL("../src/index.ts", import.meta.url))).href;
const tsxImport = import.meta.resolve("tsx");

describe("authoring loader", () => {
  it("imports a clean TypeScript task module through official facades without user config", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "acpus-loader-"));
    try {
      const workflow = join(cwd, "index.workflow.ts");
      await writeFile(workflow, "");
      await mkdir(join(cwd, "tasks"));
      await writeFile(join(cwd, "tasks", "normalize.task.ts"), `import { task, z } from "acpus/core";

export default task.define({
  inputSchema: z.object({ name: z.string() }),
  exec: async ({ input }) => ({ name: input.name.trim() }),
});
`);

      const stdout = await runNodeLoaderScript(`
import { task } from ${JSON.stringify(coreEntry)};
import { importAuthoringModule } from ${JSON.stringify(loaderEntry)};

const mod = await importAuthoringModule("./tasks/normalize.task.js", {
  parentURL: ${JSON.stringify(pathToFileURL(workflow).href)},
});
console.log(JSON.stringify({ token: task.isToken(mod.default) }));
`);

      expect(JSON.parse(stdout)).toEqual({ token: true });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("imports official facade modules directly", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "acpus-authoring-facade-"));
    try {
      const parentURL = pathToFileURL(join(cwd, "workflow.ts")).href;

      const mod = await importAuthoringModule("acpus/core", { parentURL });

      expect(typeof mod.defineWorkflow).toBe("function");
      expect(typeof mod.task).toBe("object");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("falls back to a nested package development export when the normal target is missing", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "acpus-authoring-development-export-"));
    try {
      const packageDir = join(cwd, "node_modules", "sample-task-package");
      await mkdir(join(packageDir, "src"), { recursive: true });
      await writeFile(join(cwd, "workflow.ts"), "");
      await writeFile(join(packageDir, "package.json"), JSON.stringify({
        name: "sample-task-package",
        type: "module",
        exports: {
          "./task": {
            development: { import: "./src/task.ts" },
            node: { import: "./dist/task.js" },
          },
        },
      }));
      await writeFile(join(packageDir, "src", "task.ts"), `import { task, z } from "acpus/core";

export const build = task.define({
  inputSchema: z.object({ value: z.string() }),
  exec: async ({ input }) => ({ value: input.value.toUpperCase() }),
});
`);

      const stdout = await runNodeLoaderScript(`
import { task } from ${JSON.stringify(coreEntry)};
import { importAuthoringModule } from ${JSON.stringify(loaderEntry)};

const mod = await importAuthoringModule("sample-task-package/task", {
  parentURL: ${JSON.stringify(pathToFileURL(join(cwd, "workflow.ts")).href)},
});
console.log(JSON.stringify({ token: task.isToken(mod.build) }));
`);

      expect(JSON.parse(stdout)).toEqual({ token: true });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("uses ESM import conditions for bare package specifiers", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "acpus-authoring-conditions-"));
    try {
      const packageDir = join(cwd, "node_modules", "conditional-task-package");
      await mkdir(packageDir, { recursive: true });
      await writeFile(join(cwd, "workflow.ts"), "");
      await writeFile(join(packageDir, "package.json"), JSON.stringify({
        name: "conditional-task-package",
        type: "module",
        exports: {
          "./task": {
            import: "./esm.js",
            require: "./cjs.cjs",
          },
        },
      }));
      await writeFile(join(packageDir, "esm.js"), "export const selected = 'import';\n");
      await writeFile(join(packageDir, "cjs.cjs"), "exports.selected = 'require';\n");

      const stdout = await runNodeLoaderScript(`
import { importAuthoringModule } from ${JSON.stringify(loaderEntry)};

const mod = await importAuthoringModule("conditional-task-package/task", {
  parentURL: ${JSON.stringify(pathToFileURL(join(cwd, "workflow.ts")).href)},
});
console.log(JSON.stringify({ selected: mod.selected }));
`);

      expect(JSON.parse(stdout)).toEqual({ selected: "import" });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("loads workspace dependencies for authoring sources outside the workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "acpus-authoring-dependency-authority-"));
    try {
      const workspace = join(root, "workspace");
      const sourceRoot = join(root, "outside-source");
      const packageDir = join(workspace, "node_modules", "workspace-only-package");
      await Promise.all([
        mkdir(join(sourceRoot, "tasks"), { recursive: true }),
        mkdir(packageDir, { recursive: true }),
      ]);
      await writeFile(join(sourceRoot, "workflow.ts"), "");
      await writeFile(join(packageDir, "package.json"), JSON.stringify({
        name: "workspace-only-package",
        type: "module",
        exports: "./index.mjs",
      }));
      await writeFile(join(packageDir, "index.mjs"), "export const value = 'from-workspace';\n");
      await writeFile(join(sourceRoot, "tasks", "relative.mjs"), [
        "import { value } from 'workspace-only-package';",
        "export const nestedValue = value;",
      ].join("\n"));

      const stdout = await runNodeLoaderScript(`
import { importAuthoringModule } from ${JSON.stringify(loaderEntry)};

const options = {
  parentURL: ${JSON.stringify(pathToFileURL(join(sourceRoot, "workflow.ts")).href)},
  sourceRoot: ${JSON.stringify(sourceRoot)},
  dependencyRoot: ${JSON.stringify(workspace)},
};
const bare = await importAuthoringModule("workspace-only-package", options);
const relative = await importAuthoringModule("./tasks/relative.mjs", options);
console.log(JSON.stringify({ bare: bare.value, nested: relative.nestedValue }));
`);

      expect(JSON.parse(stdout)).toEqual({ bare: "from-workspace", nested: "from-workspace" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not fallback when a nested normal target exists but its dependency is missing", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "acpus-authoring-transitive-miss-"));
    try {
      const packageDir = join(cwd, "node_modules", "broken-default-package");
      await mkdir(join(packageDir, "src"), { recursive: true });
      await mkdir(join(packageDir, "dist"), { recursive: true });
      await writeFile(join(cwd, "workflow.ts"), "");
      await writeFile(join(packageDir, "package.json"), JSON.stringify({
        name: "broken-default-package",
        type: "module",
        exports: {
          "./task": {
            development: "./src/task.ts",
            node: { import: "./dist/task.js" },
          },
        },
      }));
      await writeFile(join(packageDir, "dist", "task.js"), "import 'missing-transitive-dependency';\nexport const selected = 'default';\n");
      await writeFile(join(packageDir, "src", "task.ts"), "export const selected = 'development';\n");

      const stdout = await runNodeLoaderScript(`
import { importAuthoringModule } from ${JSON.stringify(loaderEntry)};

try {
  const mod = await importAuthoringModule("broken-default-package/task", {
    parentURL: ${JSON.stringify(pathToFileURL(join(cwd, "workflow.ts")).href)},
  });
  console.log(JSON.stringify({ loaded: true, selected: mod.selected }));
} catch (error) {
  console.log(JSON.stringify({
    loaded: false,
    code: error && typeof error === "object" && "code" in error ? error.code : undefined,
    message: error instanceof Error ? error.message : String(error),
  }));
}
`);

      const result = JSON.parse(stdout) as { loaded: boolean; code?: string; message: string };
      expect(result.loaded).toBe(false);
      expect(result.code).toBe("ERR_MODULE_NOT_FOUND");
      expect(result.message).toContain("missing-transitive-dependency");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("does not fallback when the default target is a directory", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "acpus-authoring-default-directory-"));
    try {
      const packageDir = join(cwd, "node_modules", "directory-default-package");
      await mkdir(join(packageDir, "src"), { recursive: true });
      await mkdir(join(packageDir, "dist", "task.js"), { recursive: true });
      await writeFile(join(cwd, "workflow.ts"), "");
      await writeFile(join(packageDir, "package.json"), JSON.stringify({
        name: "directory-default-package",
        type: "module",
        exports: {
          "./task": {
            development: "./src/task.ts",
            default: "./dist/task.js",
          },
        },
      }));
      await writeFile(join(packageDir, "src", "task.ts"), "export const selected = 'development';\n");

      const stdout = await runNodeLoaderScript(`
import { importAuthoringModule } from ${JSON.stringify(loaderEntry)};

try {
  const mod = await importAuthoringModule("directory-default-package/task", {
    parentURL: ${JSON.stringify(pathToFileURL(join(cwd, "workflow.ts")).href)},
  });
  console.log(JSON.stringify({ loaded: true, selected: mod.selected }));
} catch (error) {
  console.log(JSON.stringify({ loaded: false, code: error && typeof error === "object" && "code" in error ? error.code : undefined }));
}
`);

      expect(JSON.parse(stdout)).toMatchObject({ loaded: false });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("does not fallback when inspecting the default target hits a symlink loop", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "acpus-authoring-default-loop-"));
    try {
      const packageDir = join(cwd, "node_modules", "loop-default-package");
      await mkdir(join(packageDir, "src"), { recursive: true });
      await mkdir(join(packageDir, "dist"), { recursive: true });
      await writeFile(join(cwd, "workflow.ts"), "");
      await writeFile(join(packageDir, "package.json"), JSON.stringify({
        name: "loop-default-package",
        type: "module",
        exports: {
          "./task": {
            development: "./src/task.ts",
            default: "./dist/task.js",
          },
        },
      }));
      await writeFile(join(packageDir, "src", "task.ts"), "export const selected = 'development';\n");
      await symlink("task.js", join(packageDir, "dist", "task.js"));

      const stdout = await runNodeLoaderScript(`
import { importAuthoringModule } from ${JSON.stringify(loaderEntry)};

try {
  const mod = await importAuthoringModule("loop-default-package/task", {
    parentURL: ${JSON.stringify(pathToFileURL(join(cwd, "workflow.ts")).href)},
  });
  console.log(JSON.stringify({ loaded: true, selected: mod.selected }));
} catch (error) {
  console.log(JSON.stringify({ loaded: false, code: error && typeof error === "object" && "code" in error ? error.code : undefined }));
}
`);

      expect(JSON.parse(stdout)).toEqual({ loaded: false, code: "ELOOP" });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("loads TypeScript from the built package without ambient tsx or a module package boundary", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "acpus-authoring-no-ambient-"));
    const buildDir = await mkdtemp(join(packageRoot, ".test-loader-dist-"));
    try {
      await execFileAsync("pnpm", [
        "exec",
        "tsc",
        "-p",
        "packages/loader/tsconfig.json",
        "--outDir",
        buildDir,
      ], { cwd: repoRoot });
      const workflow = join(cwd, "index.workflow.ts");
      await writeFile(workflow, "");
      await mkdir(join(cwd, "tasks"));
      await writeFile(join(cwd, "tasks", "normalize.task.ts"), `import { task, z } from "acpus/core";

export default task.define({
  inputSchema: z.object({ name: z.string() }),
  exec: async ({ input }) => ({ name: input.name.trim() }),
});
`);

      const stdout = await runPlainNodeScript(`
import { importAuthoringModule } from ${JSON.stringify(pathToFileURL(join(buildDir, "index.js")).href)};

const mod = await importAuthoringModule("./tasks/normalize.task.js", {
  parentURL: ${JSON.stringify(pathToFileURL(workflow).href)},
});
const token = mod.default;
console.log(JSON.stringify({ taskish: Boolean(token && typeof token === "object" && "fn" in token) }));
`);

      expect(JSON.parse(stdout)).toEqual({ taskish: true });
    } finally {
      await rm(cwd, { recursive: true, force: true });
      await rm(buildDir, { recursive: true, force: true });
    }
  });

  it("returns usable official facade paths for scratch typecheck configs", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "acpus-authoring-paths-"));
    try {
      const result = officialAuthoringTypeScriptPaths(cwd);

      expect(Object.keys(result.paths).sort()).toEqual(["acpus/core", "acpus/expression", "acpus/tasks/git"]);
      for (const [specifier, targets] of Object.entries(result.paths)) {
        expect(targets, specifier).toHaveLength(1);
        const target = targets[0];
        if (!target) throw new Error(`expected path target for ${specifier}`);
        expect(target, specifier).toMatch(/^\.\.?\//);
        await access(join(cwd, target));
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("reports the same absolute authoring authority used by TypeScript paths", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "acpus-authoring-authority-"));
    try {
      const paths = officialAuthoringTypeScriptPaths(cwd);
      const environment = officialAuthoringEnvironment();

      for (const [specifier, authority] of Object.entries(environment.imports)) {
        const target = paths.paths[specifier]?.[0];
        if (!target) throw new Error(`missing TypeScript path for ${specifier}`);
        expect(realpathSync(resolve(cwd, target))).toBe(authority.typesPath);
        expect(isAbsolute(authority.packageRoot)).toBe(true);
        expect(isAbsolute(authority.typesPath)).toBe(true);
        expect(authority.version).not.toBe("");
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("returns declaration paths for installed package typecheck configs", async () => {
    const root = await mkdtemp(join(packageRoot, ".test-installed-"));
    try {
      const loaderDist = join(root, "node_modules", "@acpus", "loader", "dist");
      await execFileAsync("pnpm", [
        "exec",
        "tsc",
        "-p",
        "packages/loader/tsconfig.json",
        "--outDir",
        loaderDist,
      ], { cwd: repoRoot });
      await writeInstalledPackage(root, "@acpus/core", {
        ".": "dist/index",
      });
      await writeInstalledPackage(root, "@acpus/expression", {
        ".": "dist/index",
      });
      await writeInstalledPackage(root, "@acpus/tasks", {
        "./git": "dist/git",
      });

      const cwd = join(root, "workspace");
      await mkdir(cwd);
      const stdout = await runPlainNodeScript(`
import { officialAuthoringEnvironment, officialAuthoringTypeScriptPaths } from ${JSON.stringify(pathToFileURL(join(loaderDist, "index.js")).href)};
console.log(JSON.stringify({ paths: officialAuthoringTypeScriptPaths(${JSON.stringify(cwd)}), environment: officialAuthoringEnvironment() }));
`);
      const result = JSON.parse(stdout) as {
        paths: ReturnType<typeof officialAuthoringTypeScriptPaths>;
        environment: ReturnType<typeof officialAuthoringEnvironment>;
      };

      expect(result.paths.usesSource).toBe(false);
      expect(result.paths.paths["acpus/core"]?.[0]).toMatch(/@acpus\/core\/dist\/index\.d\.ts$/);
      expect(result.paths.paths["acpus/expression"]?.[0]).toMatch(/@acpus\/expression\/dist\/index\.d\.ts$/);
      expect(result.paths.paths["acpus/tasks/git"]?.[0]).toMatch(/@acpus\/tasks\/dist\/git\.d\.ts$/);
      expect(result.environment.imports["acpus/core"]).toMatchObject({ package: "@acpus/core", version: "1.0.0" });
      expect(result.environment.imports["acpus/expression"]).toMatchObject({ package: "@acpus/expression", version: "1.0.0" });
      expect(result.environment.imports["acpus/tasks/git"]).toMatchObject({ package: "@acpus/tasks", version: "1.0.0" });
      for (const authority of Object.values(result.environment.imports)) {
        expect(isAbsolute(authority.packageRoot)).toBe(true);
        expect(isAbsolute(authority.typesPath)).toBe(true);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function writeInstalledPackage(root: string, name: string, entries: Record<string, string>): Promise<void> {
  const packageDir = join(root, "node_modules", name);
  await mkdir(packageDir, { recursive: true });
  const exports = Object.fromEntries(Object.entries(entries).map(([specifier, target]) => [
    specifier,
    {
      types: `./${target}.d.ts`,
      default: `./${target}.js`,
    },
  ]));
  await writeFile(join(packageDir, "package.json"), JSON.stringify({
    name,
    version: "1.0.0",
    type: "module",
    exports: entries["."] ? exports["."] : exports,
  }));
  for (const target of Object.values(entries)) {
    await mkdir(dirname(join(packageDir, target)), { recursive: true });
    await writeFile(join(packageDir, `${target}.js`), "export {};\n");
    await writeFile(join(packageDir, `${target}.d.ts`), "export {};\n");
  }
}

async function runNodeLoaderScript(script: string): Promise<string> {
  const result = await execFileAsync(process.execPath, [
    "--import",
    tsxImport,
    "--input-type=module",
    "--eval",
    script,
  ], { cwd: repoRoot });
  return result.stdout.trim();
}

async function runPlainNodeScript(script: string): Promise<string> {
  const result = await execFileAsync(process.execPath, [
    "--input-type=module",
    "--eval",
    script,
  ], { cwd: repoRoot });
  return result.stdout.trim();
}
