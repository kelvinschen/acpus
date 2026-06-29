import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runProcess } from "./process.js";

export type TypecheckResult =
  | { ok: true }
  | { ok: false; exitCode: number | null; stdout: string; stderr: string };

export async function createScratchDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "acpus-run-"));
}

export async function typecheckWorkflow(entry: string, cwd: string, scratchDir: string): Promise<TypecheckResult> {
  const tsconfig = await writeTypecheckConfig(entry, cwd, scratchDir);
  const tsgo = await resolveTsgoBin();
  const result = await runProcess(process.execPath, [tsgo, "-p", tsconfig], { cwd });
  if (result.exitCode === 0) return { ok: true };
  return { ok: false, exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
}

async function writeTypecheckConfig(entry: string, cwd: string, scratchDir: string): Promise<string> {
  const baseConfig = await findUp("tsconfig.json", dirname(entry));
  const configPath = join(scratchDir, "tsconfig.acpus-run.json");
  const compilerOptions: Record<string, unknown> = {
    target: "ES2022",
    lib: ["ES2022"],
    module: "NodeNext",
    moduleResolution: "NodeNext",
    strict: true,
    esModuleInterop: true,
    noImplicitAny: true,
    forceConsistentCasingInFileNames: true,
    skipLibCheck: true,
    noEmit: true,
    types: ["node"],
    typeRoots: [join(cwd, "node_modules/@types")],
    rootDir: commonPath([cwd, dirname(entry)]),
    tsBuildInfoFile: join(scratchDir, ".tsbuildinfo"),
  };

  const coreSourceDir = join(cwd, "packages/core/src");
  const coreSource = join(coreSourceDir, "index.ts");
  if (await exists(coreSource)) {
    // Workspace development should typecheck workflows against live core source.
    // Published installs must omit this condition and resolve normal package dist.
    compilerOptions.customConditions = ["development"];
    compilerOptions.paths = {
      "@acpus/core": [configRelative(scratchDir, coreSource)],
      "@acpus/core/*": [configRelative(scratchDir, join(coreSourceDir, "*.ts"))],
    };
  }

  const config: Record<string, unknown> = { compilerOptions, files: [entry] };
  if (baseConfig) config.extends = configRelative(scratchDir, baseConfig);
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
  return configPath;
}

async function resolveTsgoBin(): Promise<string> {
  const packageJson = await import.meta.resolve("@typescript/native-preview/package.json");
  return fileURLToPath(new URL("./bin/tsgo.js", packageJson));
}

async function findUp(name: string, start: string): Promise<string | undefined> {
  let current = resolve(start);
  for (;;) {
    const candidate = join(current, name);
    try {
      await readFile(candidate);
      return candidate;
    } catch {
      const parent = dirname(current);
      if (parent === current) return undefined;
      current = parent;
    }
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function commonPath(paths: string[]): string {
  const [first, ...rest] = paths.map(path => resolve(path).split(/[\\/]+/));
  const firstPath = paths[0] ?? process.cwd();
  if (!first) return process.cwd();
  let end = first.length;
  for (const parts of rest) {
    end = Math.min(end, parts.length);
    for (let i = 0; i < end; i += 1) {
      if (parts[i] !== first[i]) {
        end = i;
        break;
      }
    }
  }
  const prefix = first.slice(0, end).join("/");
  return isAbsolute(firstPath) ? `/${prefix.replace(/^\/+/, "")}` : prefix;
}

function configRelative(fromDir: string, to: string): string {
  const path = relative(fromDir, to).replaceAll("\\", "/");
  return path.startsWith(".") ? path : `./${path}`;
}
