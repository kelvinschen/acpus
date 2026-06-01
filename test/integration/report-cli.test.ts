import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { beforeAll, describe, expect, it } from "vitest";
import { createReportFixture } from "../helpers/report-fixtures.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const tsxBin = path.join(root, "node_modules", ".bin", "tsx");

describe("report CLI", () => {
  beforeAll(async () => {
    await execa("npm", ["run", "build:web-report"], { cwd: root });
  }, 30_000);

  it("prints detailed RunReportView JSON", async () => {
    const fixture = await createReportFixture("completed-success");
    const result = await execa(tsxBin, ["src/cli.ts", "report", "--run", fixture.dir, "--json", "--detailed"], { cwd: root });
    const view = JSON.parse(result.stdout) as { version: string; graph: { nodes: Array<{ id: string }> } };

    expect(view.version).toBe("acpx-workflow-orchestrator.report/v1");
    expect(view.graph.nodes.map((node) => node.id)).toEqual(["plan", "implement", "summarize"]);
  });

  it("writes a self-contained HTML report", async () => {
    const fixture = await createReportFixture("completed-success");
    const output = path.join(fixture.cwd, "report.html");
    const result = await execa(tsxBin, ["src/cli.ts", "report", "--run", fixture.dir, "--html", "--output", output], { cwd: root });
    const html = await fs.readFile(output, "utf8");

    expect(result.stdout).toContain("html report written:");
    expect(html).toContain("id=\"acpx-report-snapshot\"");
    expect(html).toContain("acpx-workflow-orchestrator.report/v1");
    expect(html).not.toContain("src=\"./assets/");
    expect(html).not.toContain("href=\"./assets/");
  });
});
