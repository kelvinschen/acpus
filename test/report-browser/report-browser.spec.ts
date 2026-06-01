import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execa } from "execa";
import { expect, test } from "@playwright/test";
import { buildRunReportView } from "../../src/projections/run-report.js";
import { renderHtmlReport } from "../../src/reports/html.js";
import { serveReport } from "../../src/reports/server.js";
import { createReportFixture, minimalReportView } from "../helpers/report-fixtures.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

test.beforeAll(async () => {
  await execa("npm", ["run", "build:web-report"], { cwd: root });
});

test("static HTML report renders core workflow state", async ({ page }) => {
  const fixture = await createReportFixture("completed-success");
  const view = await buildRunReportView(fixture.cwd, fixture.spec, fixture.index, { mode: "snapshot" });
  const output = path.join(fixture.cwd, "report.html");
  await fs.writeFile(output, await renderHtmlReport(view), "utf8");

  await page.goto(pathToFileURL(output).href);

  await expect(page.getByRole("heading", { name: "completed-success" })).toBeVisible();
  await expect(page.getByTestId("report-graph")).toBeVisible();
  await expect(page.locator("[data-stage-node=\"implement\"]")).toBeVisible();
  await page.getByRole("button", { name: "Stages" }).click();
  await expect(page.getByRole("cell", { name: "implement", exact: true })).toBeVisible();
});

test("live SSE report updates from run snapshots", async ({ page }) => {
  const fixture = await createReportFixture("completed-success");
  let buildCount = 0;
  const server = await serveReport({
    cwd: fixture.cwd,
    runId: fixture.runId,
    host: "127.0.0.1",
    port: 0,
    intervalMs: 100,
    sync: async () => fixture.index,
    build: async () => {
      buildCount += 1;
      const view = { ...minimalReportView(fixture.runId), mode: "live" as const };
      view.run.workflowName = buildCount < 2 ? "Live Report A" : "Live Report B";
      view.summary.workflowName = view.run.workflowName;
      return view;
    }
  });
  try {
    await page.goto(server.url);
    await expect(page.getByRole("heading", { name: "Live Report B" })).toBeVisible();
    await expect(page.getByText("Live connected")).toBeVisible();
  } finally {
    await server.close();
  }
});
