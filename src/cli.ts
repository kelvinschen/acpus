#!/usr/bin/env node
import { Command } from "commander";
import { registerFollow } from "./commands/follow.js";
import { registerList } from "./commands/list.js";
import { registerMonitor } from "./commands/monitor.js";
import { registerPlan } from "./commands/plan.js";
import { registerResume } from "./commands/resume.js";
import { registerRun } from "./commands/run.js";
import { registerRunWorker } from "./commands/run-worker.js";
import { registerSave } from "./commands/save.js";
import { registerShow } from "./commands/show.js";
import { issue, resultFromIssues } from "./errors.js";

const program = new Command();

program
  .name("acpus")
  .description("Acpus — compose, conduct, catalogue.")
  .version("0.1.0");

// ── Compose ─────────────────────────────────────────────────
registerPlan(program);
registerSave(program);

// ── Conduct ──────────────────────────────────────────────────
registerRun(program);
registerFollow(program);
registerMonitor(program);
registerResume(program);
registerRunWorker(program);

// ── Catalogue ────────────────────────────────────────────────
registerList(program);
registerShow(program);

program.parseAsync(process.argv).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  const result = resultFromIssues("cli", [issue({
    code: "RUNTIME_COMMAND_ERROR",
    severity: "fatal",
    path: "/",
    message,
    suggestions: ["Check the command arguments with acpus --help."]
  })]);
  if (process.argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stderr.write(`fatal RUNTIME_COMMAND_ERROR /: ${message}\n`);
  }
  process.exitCode = 1;
});
