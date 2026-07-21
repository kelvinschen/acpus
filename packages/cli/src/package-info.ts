import { readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type CliPackageInfo = {
  packageName: string;
  version: string;
  entry: string;
  packageRoot: string;
};

export function getCliPackageInfo(): CliPackageInfo {
  const srcDir = dirname(fileURLToPath(import.meta.url));
  const packageRoot = realpathSync(join(srcDir, ".."));
  const packageJson = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as { name: string; version: string };
  const entry = realpathSync(join(packageRoot, import.meta.url.endsWith(".ts") ? "src/cli.ts" : "dist/cli.js"));
  return { packageName: packageJson.name, version: packageJson.version, entry, packageRoot };
}
