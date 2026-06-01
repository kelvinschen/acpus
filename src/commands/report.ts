import fs from "node:fs/promises";
import path from "node:path";
import type { Command } from "commander";
import { buildRunReportView } from "../projections/run-report.js";
import { runViewFromIndex } from "../projections/run-view.js";
import { renderHtmlReport } from "../reports/html.js";
import { renderMarkdownReport } from "../reports/markdown.js";
import { serveReport } from "../reports/server.js";
import { resolveRunLocator } from "../run-index/locator.js";
import { runDir } from "../run-index/paths.js";
import { syncRun } from "../runtime/sync.js";
import { printJson } from "./common.js";
import { WorkflowSpecSchema } from "../schema/workflow-spec.js";

export function registerReport(program: Command): void {
  const report = program.command("report")
    .option("--run <id-or-dir>", "logical run id or run directory")
    .option("--output <path>", "report output path")
    .option("--json", "print JSON RunView")
    .option("--detailed", "with --json, print detailed RunReportView")
    .option("--html", "write a self-contained HTML report")
    .action(async (options: { run: string; output?: string; json?: boolean; detailed?: boolean; html?: boolean }) => {
      if (!options.run) throw new Error("report requires --run <id-or-dir>.");
      const locator = await resolveRunLocator(options.run);
      const dir = runDir(locator.runId, locator.cwd);
      const run = await syncRun(locator.cwd, locator.runId);
      const spec = WorkflowSpecSchema.parse(JSON.parse(await fs.readFile(path.join(dir, "workflow.spec.json"), "utf8")));
      const view = await runViewFromIndex(locator.cwd, spec, run);
      if (options.html) {
        if (!options.output) throw new Error("report --html requires --output <path>.");
        const detailed = await buildRunReportView(locator.cwd, spec, run, { mode: "snapshot" });
        await fs.writeFile(options.output, await renderHtmlReport(detailed), "utf8");
        process.stdout.write(`html report written: ${options.output}\n`);
        return;
      }
      if (options.json) {
        if (options.detailed) {
          printJson(await buildRunReportView(locator.cwd, spec, run, { mode: "snapshot" }));
          return;
        }
        printJson(view);
        return;
      }
      const markdown = renderMarkdownReport(view);
      if (options.output) {
        await fs.writeFile(options.output, markdown, "utf8");
        process.stdout.write(`report written: ${options.output}\n`);
      } else {
        process.stdout.write(markdown);
      }
    });

  report.command("serve")
    .option("--run <id-or-dir>", "logical run id or run directory")
    .option("--host <host>", "host to bind", "127.0.0.1")
    .option("--port <port>", "port to bind; use 0 for an ephemeral port", "0")
    .option("--interval-ms <ms>", "sync interval", "1000")
    .option("--open", "open browser")
    .option("--json", "print JSON server info")
    .action(async (options: { run: string; host: string; port: string; intervalMs: string; open?: boolean; json?: boolean }) => {
      const run = options.run ?? (report.opts() as { run?: string }).run;
      if (!run) throw new Error("report serve requires --run <id-or-dir>.");
      const locator = await resolveRunLocator(run);
      const port = Number(options.port);
      const intervalMs = Number(options.intervalMs);
      const server = await serveReport({
        cwd: locator.cwd,
        runId: locator.runId,
        host: options.host,
        port: Number.isInteger(port) && port >= 0 ? port : 0,
        intervalMs: Number.isInteger(intervalMs) && intervalMs > 0 ? intervalMs : 1000,
        open: options.open
      });
      const served = new URL(server.url);
      const output = { ok: true, runId: locator.runId, url: server.url, host: served.hostname, port: Number(served.port) };
      if (options.json) printJson(output);
      else process.stdout.write(`report server: ${server.url}\n`);
      await new Promise<void>(() => {
        // Keep the observation-only report server alive until the process is terminated.
      });
    });
}
