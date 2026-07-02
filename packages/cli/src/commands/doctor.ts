import type { Writable } from "node:stream";
import { Command } from "commander";
import { getRuntimeHealth } from "@acpus/runtime";
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
      ctx.setExitCode(writeResult({
        ok: report.ok,
        phase: "doctor",
        message: report.ok ? "Doctor checks passed." : "Doctor checks failed.",
        checks: report.checks,
      }, ctx.wantsJson ? "json" : "text", ctx, report.ok ? 0 : 1));
    });
}
