import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export async function syncAcpusSkillVersion(root, options = {}) {
  const packagePath = resolve(root, "packages/cli/package.json");
  const skillPath = resolve(root, "packages/cli/skills/acpus/SKILL.md");
  const manifest = JSON.parse(await readFile(packagePath, "utf8"));
  if (typeof manifest.version !== "string" || manifest.version.length === 0) throw new Error("acpus package version is missing");
  const source = await readFile(skillPath, "utf8");
  const pattern = /(^metadata:\s*\r?\n(?:^[ \t]+.*\r?\n)*?^[ \t]+acpus-version:\s*)([^\s#]+)(\s*(?:#.*)?$)/m;
  const match = source.match(pattern);
  if (!match) throw new Error("Acpus skill metadata.acpus-version is missing");
  if (match[2] === manifest.version) return false;
  if (options.check) throw new Error(`Acpus skill version ${match[2]} does not match CLI version ${manifest.version}`);
  await writeFile(skillPath, source.replace(pattern, `$1${manifest.version}$3`));
  return true;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.some(arg => arg !== "--check")) throw new Error("Usage: node scripts/sync-acpus-skill-version.mjs [--check]");
  await syncAcpusSkillVersion(process.cwd(), { check: args.includes("--check") });
}
