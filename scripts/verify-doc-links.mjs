import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function markdownFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await markdownFiles(entryPath)));
    else if (entry.name.endsWith(".md")) files.push(entryPath);
  }
  return files;
}

const files = [path.join(root, "README.md"), path.join(root, "README.zh.md")];
files.push(
  ...(await markdownFiles(path.join(root, "docs"))),
  ...(await markdownFiles(path.join(root, "specs"))),
  ...(await markdownFiles(path.join(root, "packages", "cli", "skills", "acpus"))),
);

for (const entry of await readdir(path.join(root, "packages"), { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const readme = path.join(root, "packages", entry.name, "README.md");
  if (existsSync(readme)) files.push(readme);
}

const failures = [];
const targets = (source) => [
  ...[...source.matchAll(/!?\[[^\]]*\]\((?:<([^>]+)>|([^\s)]+))/g)].map(
    (match) => match[1] ?? match[2],
  ),
  ...[...source.matchAll(/(?:href|src)=(['"])(.*?)\1/g)].map((match) => match[2]),
];

async function verify(file) {
  const source = await readFile(file, "utf8");
  for (const rawTarget of targets(source)) {
    if (/^(?:[a-z][a-z\d+.-]*:|#|\/\/)/i.test(rawTarget)) continue;
    const withoutFragment = rawTarget.split(/[?#]/, 1)[0];
    if (!withoutFragment) continue;
    let target;
    try {
      target = decodeURIComponent(withoutFragment);
    } catch {
      failures.push(`${path.relative(root, file)}: invalid URL encoding in ${rawTarget}`);
      continue;
    }
    const resolved = target.startsWith("/")
      ? path.join(root, target.slice(1))
      : path.resolve(path.dirname(file), target);
    if (!existsSync(resolved)) {
      failures.push(`${path.relative(root, file)}: missing ${rawTarget}`);
    }
  }
}

for (const file of [...new Set(files)].sort()) await verify(file);
await verify(path.join(root, "page", "index.html"));

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log(`Verified local links in ${new Set(files).size} Markdown files and the Pages entry point.`);
