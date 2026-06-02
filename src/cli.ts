#!/usr/bin/env node
import { Command } from "commander";
import { registerDiagnose } from "./commands/diagnose.js";
import { registerFollow } from "./commands/follow.js";
import { registerGenerate } from "./commands/generate.js";
import { registerList } from "./commands/list.js";
import { registerMonitor } from "./commands/monitor.js";
import { registerPreview } from "./commands/preview.js";
import { registerRecover } from "./commands/recover.js";
import { registerResume } from "./commands/resume.js";
import { registerRun } from "./commands/run.js";
import { registerRunWorker } from "./commands/run-worker.js";
import { registerSave } from "./commands/save.js";
import { registerShow } from "./commands/show.js";
import { registerValidate } from "./commands/validate.js";
import { issue, resultFromIssues } from "./errors.js";

const program = new Command();

program
  .name("acpx-workflow-orchestrator")
  .description("Dynamic workflow orchestrator for acpx agents")
  .version("0.1.0");

registerValidate(program);
registerPreview(program);
registerRun(program);
registerRunWorker(program);
registerSave(program);
registerList(program);
registerShow(program);
registerFollow(program);
registerMonitor(program);
registerRecover(program);
registerResume(program);
registerDiagnose(program);
registerGenerate(program);

program.parseAsync(process.argv).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  const result = resultFromIssues("cli", [issue({
    code: "RUNTIME_COMMAND_ERROR",
    severity: "fatal",
    path: "/",
    message,
    suggestions: ["Check the command arguments with acpx-workflow-orchestrator --help."]
  })]);
  if (process.argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stderr.write(`fatal RUNTIME_COMMAND_ERROR /: ${message}\n`);
  }
  process.exitCode = 1;
});
