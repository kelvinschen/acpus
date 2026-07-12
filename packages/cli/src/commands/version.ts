import type { Writable } from "node:stream";
import { readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";

export type VersionCommandContext = {
  stdout: Writable;
  setExitCode(code: number): void;
};

export type CliPackageInfo = {
  packageName: string;
  version: string;
  entry: string;
  packageRoot: string;
};

export function getCliPackageInfo(): CliPackageInfo {
  const commandsDir = dirname(fileURLToPath(import.meta.url));
  const packageRoot = realpathSync(join(commandsDir, "..", ".."));
  const packageJsonPath = join(packageRoot, "package.json");
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { name: string; version: string };
  const entry = realpathSync(join(packageRoot, import.meta.url.endsWith(".ts") ? "src/cli.ts" : "dist/cli.js"));
  return { packageName: packageJson.name, version: packageJson.version, entry, packageRoot };
}

export function createVersionCommand(ctx: VersionCommandContext): Command {
  return new Command("version")
    .exitOverride()
    .description("Print the Acpus CLI version.")
    .action(() => {
      ctx.stdout.write(`${getCliPackageInfo().version}\n`);
      ctx.setExitCode(0);
    });
}
