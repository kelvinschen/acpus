import type { Writable } from "node:stream";
import { Command } from "commander";
import {
  getRuntimeHealth,
  inspectRuntimeStore,
  repairRuntimeStore,
  type RuntimeHealthCheck,
  type RuntimeHealthReport,
} from "@acpus/runtime";
import { getAuthoringHealth, type AuthoringHealthCheck } from "../authoring-environment.js";
import { writeResult } from "../output.js";

export type DoctorCommandContext = {
  cwd: string;
  stdout: Writable;
  stderr: Writable;
  setExitCode(code: number): void;
};

type DoctorOptions = { fix?: boolean };

export function createDoctorCommand(ctx: DoctorCommandContext): Command {
  return new Command("doctor")
    .exitOverride()
    .description("Check workspace health and show authoring type locations.")
    .option("--fix", "repair the Runtime store when Doctor reports it is needed")
    .action(async (options: DoctorOptions) => {
      const runtime = await runtimeHealth(ctx.cwd, options.fix === true);
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
      const checks = [
        ...runtime.repairChecks,
        ...runtime.report.checks,
        ...(authoring?.checks ?? []),
        ...(authoringFailure ? [authoringFailure] : []),
      ];
      const ok = checks.every(check => check.status !== "fail");
      const message = !ok
        ? "Doctor checks failed."
        : checks.some(check => check.status === "warn")
          ? "Doctor checks passed with warnings."
          : "Doctor checks passed.";
      const result = {
        ok,
        phase: "doctor" as const,
        message,
        ...(runtime.report.persistence ? { persistence: runtime.report.persistence } : {}),
        checks,
        ...(authoring ? { authoringTypes: authoring.types } : {}),
      };
      const exitCode = ok ? 0 : 1;
      ctx.setExitCode(writeResult(result, ctx, exitCode));
    });
}

async function runtimeHealth(
  cwd: string,
  fix: boolean,
): Promise<{ report: RuntimeHealthReport; repairChecks: RuntimeHealthCheck[] }> {
  if (!fix) return { report: await getRuntimeHealth(cwd), repairChecks: [] };

  const inspected = await inspectRuntimeStore(cwd);
  if (inspected.isErr() || inspected.value.state !== "repairable") {
    return { report: await getRuntimeHealth(cwd), repairChecks: [] };
  }

  const repaired = await repairRuntimeStore(cwd);
  if (repaired.isErr()) {
    return {
      report: {
        ok: false,
        phase: "doctor",
        state: "unreadable",
        checks: [{ area: "store", status: "fail", message: repaired.error.message }],
      },
      repairChecks: [],
    };
  }

  return {
    report: await getRuntimeHealth(cwd),
    repairChecks: repaired.value.changed
      ? [{ area: "store", status: "ok", message: "Runtime store fixed; existing runs were preserved." }]
      : [],
  };
}
