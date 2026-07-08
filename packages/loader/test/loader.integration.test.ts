import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { importAuthoringModule, officialAuthoringTypeScriptPaths } from "../src/index.js";

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

  it("falls back to a package development export when the default target is missing", async () => {
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
            development: "./src/task.ts",
            default: "./dist/task.js",
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

  it("does not fallback when the default target exists but its dependency is missing", async () => {
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
            default: "./dist/task.js",
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

  it("registers TypeScript loading from the built package without ambient tsx", async () => {
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
        "--tsBuildInfoFile",
        join(buildDir, ".tsbuildinfo"),
      ], { cwd: repoRoot });
      const workflow = join(cwd, "index.workflow.ts");
      await writeFile(join(cwd, "package.json"), JSON.stringify({ type: "module" }));
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

async function runPlainNodeScript(script: string): Promise<string> {
  const result = await execFileAsync(process.execPath, [
    "--input-type=module",
    "--eval",
    script,
  ], { cwd: repoRoot });
  return result.stdout.trim();
}
