import { resolve } from "node:path";
import type { Writable } from "node:stream";
import { Command } from "commander";
import { runSupervisor } from "../runtime/index.js";

export type SupervisorCommandContext = {
  cwd: string;
  stdout: Writable;
  stderr: Writable;
  wantsJson: boolean;
  setExitCode(code: number): void;
};

type SupervisorCommandOptions = {
  workspace?: string | undefined;
  generation?: string | undefined;
  once?: boolean;
  agentStub?: boolean;
  idleMs?: string | undefined;
};

export function createSupervisorCommand(ctx: SupervisorCommandContext): Command {
  return new Command("supervisor")
    .exitOverride()
    .description("Run the workspace-local Acpus runtime supervisor.")
    .option("--workspace <path>", "workspace directory")
    .option("--generation <n>", "SQLite lease generation")
    .option("--once", "execute one supervisor pass and exit")
    .option("--agent-stub", "allow agent stubs for local smoke tests")
    .option("--idle-ms <n>", "idle loop delay in milliseconds")
    .action(async (options: SupervisorCommandOptions) => {
      const generation = Number(options.generation ?? "0");
      await runSupervisor(resolve(ctx.cwd, options.workspace ?? "."), {
        generation,
        once: options.once ?? false,
        agentStub: options.agentStub ?? false,
        idleMs: options.idleMs ? Number(options.idleMs) : undefined,
      });
      ctx.setExitCode(0);
    });
}
