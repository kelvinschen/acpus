import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { access, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { importAuthoringModule, officialAuthoringEnvironment, officialAuthoringTypeScriptPaths } from "../src/index.js";

const execFileAsync = promisify(execFile);
const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const coreEntry = new URL("../../core/src/index.ts", import.meta.url).href;
const loaderEntry = pathToFileURL(fileURLToPath(new URL("../src/index.ts", import.meta.url))).href;
const tsxImport = import.meta.resolve("tsx");

describe("authoring loader source mode", () => {
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

  it("uses the most specific dependency authority for overlapping source roots", async () => {
    const root = await mkdtemp(join(tmpdir(), "acpus-overlapping-authorities-"));
    try {
      const sourceRoot = join(root, "sources");
      const nestedSourceRoot = join(sourceRoot, "nested");
      const broadDependencies = join(root, "broad-dependencies");
      const nestedDependencies = join(root, "nested-dependencies");
      for (const [dependencyRoot, selected] of [
        [broadDependencies, "broad"],
        [nestedDependencies, "nested"],
      ] as const) {
        const packageRoot = join(dependencyRoot, "node_modules", "authority-package");
        await mkdir(packageRoot, { recursive: true });
        await writeFile(join(packageRoot, "package.json"), JSON.stringify({
          name: "authority-package",
          type: "module",
          exports: "./index.mjs",
        }));
        await writeFile(join(packageRoot, "index.mjs"), `export const selected = ${JSON.stringify(selected)};\n`);
      }
      await mkdir(nestedSourceRoot, { recursive: true });
      await writeFile(join(sourceRoot, "register.mjs"), "export const registered = true;\n");
      await writeFile(join(nestedSourceRoot, "deferred.mjs"), "export const load = () => import('authority-package');\n");

      const stdout = await runNodeLoaderScript(`
import { importAuthoringModule } from ${JSON.stringify(loaderEntry)};

const nested = await importAuthoringModule("./deferred.mjs", {
  parentURL: ${JSON.stringify(pathToFileURL(join(nestedSourceRoot, "workflow.ts")).href)},
  sourceRoot: ${JSON.stringify(nestedSourceRoot)},
  dependencyRoot: ${JSON.stringify(nestedDependencies)},
});
await importAuthoringModule("./register.mjs", {
  parentURL: ${JSON.stringify(pathToFileURL(join(sourceRoot, "workflow.ts")).href)},
  sourceRoot: ${JSON.stringify(sourceRoot)},
  dependencyRoot: ${JSON.stringify(broadDependencies)},
});
console.log(JSON.stringify({ selected: (await nested.load()).selected }));
`);

      expect(JSON.parse(stdout)).toEqual({ selected: "nested" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("propagates source-root symlink loops while registering dependency authority", async () => {
    const root = await mkdtemp(join(tmpdir(), "acpus-authority-loop-"));
    try {
      const loop = join(root, "loop");
      await symlink("loop", loop);
      const stdout = await runNodeLoaderScript(`
import { importAuthoringModule } from ${JSON.stringify(loaderEntry)};

try {
  await importAuthoringModule("data:text/javascript,export default true", {
    parentURL: ${JSON.stringify(pathToFileURL(join(root, "workflow.ts")).href)},
    sourceRoot: ${JSON.stringify(loop)},
    dependencyRoot: ${JSON.stringify(root)},
  });
  console.log(JSON.stringify({ loaded: true }));
} catch (error) {
  console.log(JSON.stringify({
    loaded: false,
    code: error && typeof error === "object" && "code" in error ? error.code : undefined,
  }));
}
`);

      expect(JSON.parse(stdout)).toEqual({ loaded: false, code: "ELOOP" });
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
});

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
