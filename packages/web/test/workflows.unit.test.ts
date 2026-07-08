import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { WorkflowIR } from "@acpus/core/ir";
import type { PreparedWorkflow } from "@acpus/workflow-compiler";
import { listProjectWorkflowCatalog, listWorkflowFiles, renderWorkflowVizHtml, workflowVisualizationFromPrepared, writeWorkflowVizHtml } from "../src/server/workflows.js";
import type { WebGraph } from "../src/server/graph.js";

describe("workflow visualization helpers", () => {
  it("lists project catalog entries without importing workflow modules", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "acpus-web-workflows-catalog-"));
    await mkdir(join(cwd, ".acpus", "workflows", "release"), { recursive: true });
    await writeFile(join(cwd, ".acpus", "workflows", "release", "workflow.ts"), "throw new Error('must not import');\n");
    await mkdir(join(cwd, ".acpus", "workflows", "bad-name!"), { recursive: true });
    await writeFile(join(cwd, ".acpus", "workflows", "bad-name!", "workflow.ts"), "export default {};\n");

    await expect(listProjectWorkflowCatalog(cwd)).resolves.toMatchObject([
      { scope: "project", name: "release", status: "available" },
    ]);
  });

  it("lists workflow files while filtering unsupported entries", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "acpus-web-workflows-files-"));
    await mkdir(join(cwd, "src"), { recursive: true });
    await mkdir(join(cwd, "node_modules"), { recursive: true });
    await writeFile(join(cwd, "src", "flow.workflow.ts"), "export default {};\n");
    await writeFile(join(cwd, "src", "notes.md"), "# nope\n");

    await expect(listWorkflowFiles(cwd, "src")).resolves.toMatchObject({
      dir: "src",
      entries: [{ name: "flow.workflow.ts", path: "src/flow.workflow.ts", kind: "workflow" }],
    });
    await expect(listWorkflowFiles(cwd, "..")).rejects.toThrow("Path escapes workspace.");
  });

  it("returns static workflow input and output contract", async () => {
    const result = workflowVisualizationFromPrepared(preparedWorkflow());

    expect(result.status).toBe("ready");
    expect(result.workflow.description).toBe("Prepared workflow description.");
    expect(result.graph.workflow.description).toBe("Prepared workflow description.");
    expect(result.contract.inputSchema).toMatchObject({ kind: "object" });
    expect(result.contract.outputs).toEqual(expect.objectContaining({
      approved: expect.any(Object),
      first_lane: expect.any(Object),
    }));
  });

  it("renders and writes a single HTML bundle", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "acpus-web-workflows-html-"));
    const out = join(cwd, "viz.html");
    const html = renderWorkflowVizHtml({ graph: tinyGraph(), title: "Tiny" });

    expect(html).toContain("<!doctype html>");
    expect(html).toContain("window.__ACPUS_WORKFLOW_VIZ__=");
    expect(html).toContain("<div id=\"root\"></div>");
    expect(html).not.toMatch(/\s(?:src|href)=["']https?:\/\//);
    expect(html).toContain("tiny");

    await writeWorkflowVizHtml(out, html);
    await expect(readFile(out, "utf8")).resolves.toBe(html);
    await expect(writeWorkflowVizHtml(out, html)).rejects.toThrow("already exists");
    await expect(writeWorkflowVizHtml(out, `${html}\n`, { force: true })).resolves.toBeUndefined();
    await expect(readFile(out, "utf8")).resolves.toBe(`${html}\n`);
  });
});

function tinyGraph(): WebGraph {
  return {
    workflow: { name: "tiny" },
    mode: "static",
    nodes: [{
      id: "step",
      nodeId: "step",
      kind: "task",
      label: "step",
      path: ["root", "step"],
      status: "not_started",
      dynamic: { instances: 0, frames: 0, attempts: 0, signalWaits: 0 },
      detail: { kind: "task", inputs: [], target: "inline" },
    }],
    containers: [],
    edges: [],
    selectors: [],
    runtimeStates: [],
    groups: [],
    overlay: { workflow: { name: "tiny" }, nodes: [], groups: [] },
  };
}

function preparedWorkflow(): PreparedWorkflow {
  const ir: WorkflowIR = {
    irVersion: 2,
    name: "prepared-static",
    description: "Prepared workflow description.",
    inputSchema: { kind: "object", fields: {}, required: [], additionalProperties: false },
    agents: {},
    root: {
      nodes: [{
        id: "review",
        kind: "task",
        run: { kind: "task_run", input: {}, target: { kind: "inline", runtime: "node", source: "async function task() {}" } },
      }],
    },
    outputs: {
      approved: { kind: "ref", path: ["nodes", "review", "output", "approved"] },
      first_lane: { kind: "literal", value: "lane-alpha" },
    },
    lock: { acpusCoreVersion: "test", generatedAt: "2026-07-07T00:00:00.000Z", notes: [] },
    diagnostics: [],
  } as unknown as WorkflowIR;
  return {
    workflowPath: "/workspace/workflow.ts",
    ir,
    irJson: `${JSON.stringify(ir, null, 2)}\n`,
    irDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    sourceGraphDigest: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    lock: {
      kind: "acpus_workflow_preparation_lock",
      version: 1,
      workflow: { entry: "workflow.ts" },
      ir: { path: "workflow.ir.json", digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
      sourceGraphDigest: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      generatedAt: "2026-07-07T00:00:00.000Z",
    },
  };
}
