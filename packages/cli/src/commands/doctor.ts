import type { Writable } from "node:stream";
import { Command } from "commander";
import { getRuntimeHealth } from "@acpus/runtime";
import { getAuthoringHealth, type AuthoringHealthCheck } from "../authoring-environment.js";
import { writeResult } from "../output.js";
import { outputFormatFor, withJsonOutput, type JsonOutputOptions } from "./output-option.js";

export type DoctorCommandContext = {
  cwd: string;
  stdout: Writable;
  stderr: Writable;
  setExitCode(code: number): void;
};

export function createDoctorCommand(ctx: DoctorCommandContext): Command {
  return withJsonOutput(new Command("doctor")
    .exitOverride()
    .description("Run read-only workspace health checks.")
  ).action(async (options: JsonOutputOptions) => {
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
      const checks = [...report.checks, ...(authoring?.checks ?? []), ...(authoringFailure ? [authoringFailure] : [])];
      const ok = checks.every(check => check.status !== "fail");
      const message = !ok
        ? "Doctor checks failed."
        : checks.some(check => check.status === "warn")
          ? "Doctor checks passed with warnings."
          : "Doctor checks passed.";
      ctx.setExitCode(writeResult({
        ok,
        phase: "doctor",
        message,
        ...(report.persistence ? { persistence: report.persistence } : {}),
        checks,
        ...(authoring ? { authoring: authoring.environment } : {}),
      }, outputFormatFor(options), ctx, ok ? 0 : 1));
    });
}
