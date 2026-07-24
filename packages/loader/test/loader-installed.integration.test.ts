import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { officialAuthoringEnvironment, officialAuthoringTypeScriptPaths } from "../src/index.js";

const execFileAsync = promisify(execFile);
const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const packageRoot = fileURLToPath(new URL("..", import.meta.url));
let buildRoot: string;
let loaderBuild: string;

beforeAll(async () => {
  buildRoot = await mkdtemp(join(packageRoot, ".test-loader-build-"));
  loaderBuild = join(buildRoot, "dist");
  await execFileAsync("pnpm", [
    "exec",
    "tsc",
    "-p",
    "packages/loader/tsconfig.json",
    "--outDir",
    loaderBuild,
  ], { cwd: repoRoot });
});

afterAll(async () => {
  await rm(buildRoot, { recursive: true, force: true });
});

describe("installed authoring loader", () => {
  it("loads TypeScript from the built package without ambient tsx or a module package boundary", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "acpus-authoring-no-ambient-"));
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

      const stdout = await runPlainNodeScript(`
import { importAuthoringModule } from ${JSON.stringify(pathToFileURL(join(loaderBuild, "index.js")).href)};

const mod = await importAuthoringModule("./tasks/normalize.task.js", {
  parentURL: ${JSON.stringify(pathToFileURL(workflow).href)},
});
const token = mod.default;
console.log(JSON.stringify({ taskish: Boolean(token && typeof token === "object" && "fn" in token) }));
`);

      expect(JSON.parse(stdout)).toEqual({ taskish: true });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("returns declaration paths for installed package typecheck configs", async () => {
    const root = await mkdtemp(join(packageRoot, ".test-installed-"));
    try {
      const loaderDist = join(root, "node_modules", "@acpus", "loader", "dist");
      await mkdir(dirname(loaderDist), { recursive: true });
      await cp(loaderBuild, loaderDist, { recursive: true });
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

async function runPlainNodeScript(script: string): Promise<string> {
  const result = await execFileAsync(process.execPath, [
    "--input-type=module",
    "--eval",
    script,
  ], { cwd: repoRoot });
  return result.stdout.trim();
}
