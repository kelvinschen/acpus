import { describe, expect, it } from "vitest";
import { buildRunReportView } from "../../src/projections/run-report.js";
import { createReportFixture } from "../helpers/report-fixtures.js";

describe("RunReportView", () => {
  it("projects a completed run into an author-stage report graph", async () => {
    const fixture = await createReportFixture("completed-success");
    const view = await buildRunReportView(fixture.cwd, fixture.spec, fixture.index, { mode: "snapshot" });

    expect(view.version).toBe("acpx-workflow-orchestrator.report/v1");
    expect(view.run.status).toBe("completed");
    expect(view.metrics.stagesCompleted).toBe(3);
    expect(view.graph.nodes.map((node) => node.id)).toEqual(["plan", "implement", "summarize"]);
    expect(view.graph.edges.map((edge) => `${edge.source}->${edge.target}`)).toEqual(["plan->implement", "implement->summarize"]);
    expect(view.stages.find((stage) => stage.id === "implement")).toMatchObject({
      roleName: "worker",
      agent: "trae",
      mode: "edit",
      status: "completed",
      outputParse: {
        mode: "lastBalancedJson",
        candidateCount: 1
      }
    });
    expect(view.graph.nodes.find((node) => node.id === "implement")?.metrics).toMatchObject({ parseCandidates: 1 });
    expect(view.artifacts).toContainEqual(expect.objectContaining({ stageId: "implement", path: "src/app.ts" }));
    expect(JSON.stringify(view.metrics)).not.toMatch(/token|cost/i);
  });

  it("keeps blocked runs inspectable without running the summarizer", async () => {
    const fixture = await createReportFixture("blocked-before-summarize");
    const view = await buildRunReportView(fixture.cwd, fixture.spec, fixture.index, { mode: "snapshot" });

    expect(view.run.status).toBe("blocked");
    expect(view.summary.summary).toContain("Required file is outside the allowed path scope");
    expect(view.stages.find((stage) => stage.id === "implement")).toMatchObject({
      status: "blocked",
      blockedReason: "Required file is outside the allowed path scope.",
      parseDiagnostics: {
        errorCode: "OUTPUT_SCHEMA_FAILED",
        candidateCount: 1,
        schemaErrors: [{ path: "/status", message: "Invalid option: expected one of \"completed\"|\"blocked\"" }]
      }
    });
    expect(view.stages.find((stage) => stage.id === "summarize")).toMatchObject({ status: "skipped", output: undefined });
  });

  it("summarizes explicit partial fanout without exposing internal item nodes", async () => {
    const fixture = await createReportFixture("fanout-partial");
    const view = await buildRunReportView(fixture.cwd, fixture.spec, fixture.index, { mode: "snapshot" });
    const fanout = view.stages.find((stage) => stage.id === "review_files")?.fanout;

    expect(view.graph.nodes.map((node) => node.id)).toEqual(["discover_files", "review_files", "reconcile", "summarize"]);
    expect(view.graph.nodes.some((node) => node.id.includes("__item_"))).toBe(false);
    expect(view.metrics.attemptsTotal).toBe(5);
    expect(fanout).toMatchObject({
      totalItems: 3,
      completedItems: 2,
      blockedItems: 1,
      allowPartial: true,
      displayedItems: 3
    });
  });

  it("truncates heavy previews while collecting artifacts from raw outputs", async () => {
    const fixture = await createReportFixture("long-content");
    const view = await buildRunReportView(fixture.cwd, fixture.spec, fixture.index, {
      mode: "snapshot",
      limits: { promptPreviewChars: 32, outputPreviewChars: 64 }
    });
    const implement = view.stages.find((stage) => stage.id === "implement");

    expect(implement?.prompt).toMatchObject({ truncated: true });
    expect(implement?.output).toMatchObject({ truncated: true });
    expect(view.artifacts).toContainEqual(expect.objectContaining({ stageId: "implement", path: "src/app.ts" }));
  });
});
