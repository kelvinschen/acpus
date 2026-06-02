import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Command } from "commander";
import { compileExecutionPlan } from "../compiler/compile.js";
import { globalWorkflowsDir, projectWorkflowsDir } from "../run-index/paths.js";
import { ensureEmptyOrOverwrite, loadAndLint, printIssues, printJson } from "./common.js";

export function registerSave(program: Command): void {
  program.command("save")
    .argument("<name>", "workflow name")
    .requiredOption("--spec <path>", "workflow spec path")
    .option("--overwrite", "overwrite existing workflow")
    .option("--global", "save to global workflow directory")
    .option("--json", "print JSON")
    .action(async (name: string, options: { spec: string; overwrite?: boolean; global?: boolean; json?: boolean }) => {
      const { spec, result } = await loadAndLint(options.spec);
      if (!spec || !result.ok) {
        if (options.json) printJson(result);
        else printIssues(result);
        process.exitCode = 1;
        return;
      }
      const root = options.global ? globalWorkflowsDir() : projectWorkflowsDir();
      const target = path.join(root, name);
      await ensureEmptyOrOverwrite(target, options.overwrite);
      await fs.mkdir(target, { recursive: true });
      const plan = compileExecutionPlan(spec);
      await fs.writeFile(path.join(target, "workflow.spec.json"), `${JSON.stringify(spec, null, 2)}\n`, "utf8");
      await fs.writeFile(path.join(target, "execution-plan.json"), `${JSON.stringify(plan, null, 2)}\n`, "utf8");
      await writeHelperSnapshot(target);
      await fs.writeFile(path.join(target, "README.md"), `# ${name}\n\n${spec.description || "Saved acpus workflow."}\n\nThis directory is a saved runtime-driven workflow snapshot. The stable authoring interface is workflow.spec.json; execution-plan.json is the derived runtime plan and should normally be regenerated from the spec.\n\nRun with acpus using workflow.spec.json.\n`, "utf8");
      const output = { ok: true, workflow: name, path: target };
      if (options.json) printJson(output);
      else process.stdout.write(`saved ${name} -> ${target}\n`);
    });
}

async function writeHelperSnapshot(target: string): Promise<void> {
  const root = await findPackageRoot();
  const helperDir = path.join(target, "helper");
  await assertBuiltHelperAvailable(root);
  await fs.mkdir(helperDir, { recursive: true });
  await copyIfExists(path.join(root, "package.json"), path.join(helperDir, "package.json"));
  await copyIfExists(path.join(root, "package-lock.json"), path.join(helperDir, "package-lock.json"));
  await copyIfExists(path.join(root, "schemas"), path.join(helperDir, "schemas"));
  await copyIfExists(path.join(root, "docs", "workflow-spec.md"), path.join(helperDir, "docs", "workflow-spec.md"));
  await copyIfExists(path.join(root, "docs", "cli.md"), path.join(helperDir, "docs", "cli.md"));
  await copyIfExists(path.join(root, "docs", "error-codes.md"), path.join(helperDir, "docs", "error-codes.md"));
  await copyIfExists(path.join(root, "scripts", "acpus"), path.join(helperDir, "scripts", "acpus"));
  await fs.chmod(path.join(helperDir, "scripts", "acpus"), 0o755).catch(() => undefined);
  await copyIfExists(path.join(root, "dist"), path.join(helperDir, "dist"));
}

async function assertBuiltHelperAvailable(root: string): Promise<void> {
  let hasCli = false;
  try {
    await fs.access(path.join(root, "dist", "cli.mjs"));
    hasCli = true;
  } catch {
    // Keep checking alternate build output.
  }
  if (!hasCli) {
    try {
      await fs.access(path.join(root, "dist", "cli.js"));
      hasCli = true;
    } catch {
      // Keep checking alternate build output.
    }
  }
  if (!hasCli) {
    throw new Error(`Cannot save a self-contained helper snapshot because ${path.join(root, "dist")} is missing a built CLI. Run npm run build in ${root} first.`);
  }
}

async function copyIfExists(source: string, target: string): Promise<void> {
  try {
    const stat = await fs.stat(source);
    await fs.mkdir(path.dirname(target), { recursive: true });
    if (stat.isDirectory()) await fs.cp(source, target, { recursive: true, force: true });
    else await fs.copyFile(source, target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function findPackageRoot(): Promise<string> {
  const candidates = [
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".."),
    path.resolve(path.dirname(process.argv[1] ?? "."), ".."),
    process.cwd()
  ];
  for (const candidate of candidates) {
    const found = await ascendToPackageRoot(candidate);
    if (found) return found;
  }
  return process.cwd();
}

async function ascendToPackageRoot(start: string): Promise<string | undefined> {
  let current = path.resolve(start);
  while (true) {
    try {
      const pkg = JSON.parse(await fs.readFile(path.join(current, "package.json"), "utf8")) as { name?: string };
      if (pkg.name === "acpus") return current;
    } catch {
      // Keep walking.
    }
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}
