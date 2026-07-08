import type { Writable } from "node:stream";
import { readFileSync } from "node:fs";
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
};

export function getCliPackageInfo(): CliPackageInfo {
  const packageJsonPath = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json");
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { name: string; version: string };
  return { packageName: packageJson.name, version: packageJson.version };
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
