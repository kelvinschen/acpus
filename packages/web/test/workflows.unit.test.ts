import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { WorkflowIR } from "@acpus/core/ir";
import type { PreparedWorkflow } from "@acpus/workflow-compiler";
import { listProjectWorkflowCatalog, listWorkflowFiles, renderWorkflowVizHtml, workflowVisualizationFromPrepared } from "../src/server/workflows.js";

describe("workflow visualization helpers", () => {
  it("lists project catalog entries without importing workflow modules", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "acpus-web-workflows-catalog-"));
    await mkdir(join(cwd, ".acpus", "workflows", "release"), { recursive: true });
    await writeFile(join(cwd, ".acpus", "workflows", "release", "workflow.ts"), "throw new Error('must not import');\n");
    await mkdir(join(cwd, ".acpus", "workflows", "bad-name!"), { recursive: true });
    await writeFile(join(cwd, ".acpus", "workflows", "bad-name!", "workflow.ts"), "export default {};\n");

    await expect(listProjectWorkflowCatalog(cwd)).resolves.toEqual([{
      name: "release",
      entryPath: join(cwd, ".acpus", "workflows", "release", "workflow.ts"),
    }]);
  });

  it("lists workflow files while filtering unsupported entries", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "acpus-web-workflows-files-"));
    await mkdir(join(cwd, "src"), { recursive: true });
    await mkdir(join(cwd, "node_modules"), { recursive: true });
    await writeFile(join(cwd, "src", "flow.workflow.ts"), "export default {};\n");
    await writeFile(join(cwd, "src", "notes.md"), "# nope\n");

    const listed = await listWorkflowFiles(cwd, "src");
    expect(listed.isOk() && listed.value).toMatchObject({
      dir: "src",
      entries: [{ name: "flow.workflow.ts", path: "src/flow.workflow.ts", kind: "workflow" }],
    });
    const escaped = await listWorkflowFiles(cwd, "..");
    expect(escaped.isErr() && escaped.error).toMatchObject({
      type: "workflow-browse-invalid",
      reason: "outside-workspace",
      message: "Path escapes workspace.",
    });
  });

  it("returns static workflow input and output contract", async () => {
    const result = workflowVisualizationFromPrepared(preparedWorkflow());

    expect(result.status).toBe("ready");
    expect(result.workflow.description).toBe("Prepared workflow description.");
    expect(result.workflow.nodeCount).toBe(3);
    expect(result.contract.inputSchema).toMatchObject({ kind: "object" });
    expect(result.contract.output).toMatchObject({ kind: "object", fields: {
      approved: expect.any(Object),
      first_lane: expect.any(Object),
    } });
    expect(result.contract.outputShape).toEqual({ kind: "object", possibleKeys: ["approved", "first_lane"] });
  });

  it("renders a self-contained HTML bundle with workflow metadata", () => {
    const result = workflowVisualizationFromPrepared(preparedWorkflow());
    const html = renderWorkflowVizHtml({
      graph: result.graph,
      workflow: result.workflow,
      contract: result.contract,
      sourceGraphDigest: result.sourceGraphDigest,
    });

    expect(html).toContain("<!doctype html>");
    expect(html).toContain("window.__ACPUS_WORKFLOW_VIZ__=");
    expect(html).toContain("<div id=\"root\"></div>");
    expect(html).toContain("<title>prepared-static</title>");
    expect(html).not.toMatch(/\s(?:src|href)=["']https?:\/\//);
    expect(html).toContain(result.sourceGraphDigest);
    expect(html).toContain("Prepared workflow description.");
    expect(html).toContain("Output Expression");
    expect(html).not.toContain("Output Mapping");
  });
});

function preparedWorkflow(): PreparedWorkflow {
  const ir: WorkflowIR = {
    irVersion: 6,
    name: "prepared-static",
    description: "Prepared workflow description.",
    inputSchema: { kind: "object", fields: {}, required: [], additionalProperties: false },
    agents: {},
    root: {
      output: { kind: "object", fields: {
      approved: { kind: "literal", value: true },
      first_lane: { kind: "literal", value: "lane-alpha" },
    } },
      nodes: [{
        id: "choose",
        kind: "if",
        condition: { kind: "literal", value: true },
        then: {
          output: { kind: "object", fields: {} },
          nodes: [{
            id: "review",
            kind: "task",
            run: { input: {}, target: { kind: "inline", source: "async function task() {}" } },
          }],
        },
        else: {
          output: { kind: "object", fields: {} },
          nodes: [{ id: "fallback", kind: "assert", condition: { kind: "literal", value: true } }],
        },
      }],
    },

    diagnostics: [],
  };
  return {
    workflowPath: "/workspace/workflow.ts",
    source: { kind: "workspace", entry: "workflow.ts" },
    ir,
    irJson: `${JSON.stringify(ir, null, 2)}\n`,
    sourceGraphDigest: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    lock: {
      kind: "acpus_workflow_preparation_lock",
      version: 1,
      workflow: {
        source: { kind: "workspace", entry: "workflow.ts" },
        sourceDigest: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      },
      ir: { path: "workflow.ir.json", digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
      sourceGraphDigest: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    },
  };
}
