import type { Writable } from "node:stream";
import { Command } from "commander";
import { getRuntimeHealth } from "@acpus/runtime";
import { getAuthoringHealth, type AuthoringHealthCheck } from "../authoring-environment.js";
import { writeResult } from "../output.js";

export type DoctorCommandContext = {
  cwd: string;
  stdout: Writable;
  stderr: Writable;
  wantsJson: boolean;
  setExitCode(code: number): void;
};

export function createDoctorCommand(ctx: DoctorCommandContext): Command {
  return new Command("doctor")
    .exitOverride()
    .configureOutput({
      writeOut: text => ctx.stdout.write(text),
      writeErr: text => {
        if (!ctx.wantsJson) ctx.stderr.write(text);
      },
      outputError: (text, write) => write(text),
    })
    .description("Run read-only workspace health checks.")
    .action(async () => {
      const report = await getRuntimeHealth(ctx.cwd);
      let authoring: Awaited<ReturnType<typeof getAuthoringHealth>> | undefined;
      let authoringFailure: AuthoringHealthCheck | undefined;
      try {
        authoring = await getAuthoringHealth(ctx.cwd);
      } catch (error) {
        authoringFailure = {
          area: "authoring",
          status: "fail",
          message: error instanceof Error ? error.message : String(error),
        };
      }
      const ok = report.ok && authoring?.ok !== false && authoringFailure === undefined;
      ctx.setExitCode(writeResult({
        ok,
        phase: "doctor",
        message: ok ? "Doctor checks passed." : "Doctor checks failed.",
        checks: [...report.checks, ...(authoring?.checks ?? []), ...(authoringFailure ? [authoringFailure] : [])],
        ...(authoring ? { authoring: authoring.environment } : {}),
      }, ctx.wantsJson ? "json" : "text", ctx, ok ? 0 : 1));
    });
}
