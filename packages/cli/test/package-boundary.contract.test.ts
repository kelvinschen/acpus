import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseAcpusSkillMetadata } from "../src/skill-content.js";

const srcRoot = fileURLToPath(new URL("../src", import.meta.url));
const packageJsonPath = fileURLToPath(new URL("../package.json", import.meta.url));
const skillPath = fileURLToPath(new URL("../skills/acpus/SKILL.md", import.meta.url));

describe("acpus package boundaries", () => {
  it("uses runtime only through the package root", async () => {
    const offenders: string[] = [];
    for (const file of await tsFiles(srcRoot)) {
      const source = await readFile(file, "utf8");
      if (/from\s+["'][^"']*\/runtime\/[^"']*["']/.test(source)
        || /from\s+["']@acpus\/runtime\/[^"']+["']/.test(source)
        || /from\s+["']@acpus\/agent-executor(?:\/[^"']*)?["']/.test(source)) {
        offenders.push(file);
      }
    }

    expect(offenders).toEqual([]);
  });

  it("does not expose a mixed root authoring entrypoint", async () => {
    const pkg = JSON.parse(await readFile(packageJsonPath, "utf8")) as { exports?: Record<string, unknown> };
    expect(pkg.exports).toBeDefined();
    expect(Object.prototype.hasOwnProperty.call(pkg.exports, ".")).toBe(false);
    expect(Object.keys(pkg.exports ?? {}).sort()).toEqual([
      "./core",
      "./expression",
      "./tasks/git",
    ]);
  });

  it("declares the bundled Acpus skill in the package files", async () => {
    const pkg = JSON.parse(await readFile(packageJsonPath, "utf8")) as { version: string; private?: boolean; files?: string[] };
    const skill = await readFile(skillPath, "utf8");
    expect(pkg.private).not.toBe(true);
    expect(pkg.files).toContain("skills");
    expect(parseAcpusSkillMetadata(skill)).toEqual({ name: "acpus", version: pkg.version });
  });
});

async function tsFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async entry => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return tsFiles(path);
    return entry.isFile() && path.endsWith(".ts") ? [path] : [];
  }));
  return nested.flat();
}
