import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { WorkflowIR } from "@acpus/core/ir";
import type { WorkflowVisualizationResult } from "../src/api-types.js";
import { renderWorkflowVizHtml } from "../src/server/workflows/offline-html.js";
import { tryVisualizeWorkflowSource } from "../src/server/workflows/visualization.js";

describe("workflow visualization helpers", () => {
  it("classifies a workspace path escape as a source failure before preparation", async () => {
    const result = await tryVisualizeWorkflowSource("/workspace", {
      kind: "file",
      path: "../outside.workflow.ts",
    });

    expect(result.isErr()).toBe(true);
    if (result.isOk()) throw new Error("expected source failure");
    expect(result.error).toMatchObject({
      type: "workflow-source-invalid",
      reason: "outside-workspace",
      phase: "source",
    });
  });

  it("rejects a workflow symlink that resolves outside the workspace", async () => {
    const [cwd, outside] = await Promise.all([
      mkdtemp(join(tmpdir(), "acpus-web-source-workspace-")),
      mkdtemp(join(tmpdir(), "acpus-web-source-outside-")),
    ]);
    try {
      const target = join(outside, "workflow.ts");
      await writeFile(target, "throw new Error('outside source must not be imported');\n");
      await symlink(target, join(cwd, "release.workflow.ts"));

      const result = await tryVisualizeWorkflowSource(cwd, {
        kind: "file",
        path: "release.workflow.ts",
      });

      expect(result.isErr()).toBe(true);
      if (result.isOk()) throw new Error("expected source failure");
      expect(result.error).toMatchObject({
        type: "workflow-source-invalid",
        reason: "outside-workspace",
        phase: "source",
      });
    } finally {
      await Promise.all([
        rm(cwd, { recursive: true, force: true }),
        rm(outside, { recursive: true, force: true }),
      ]);
    }
  });

  it("rejects a project catalog root that resolves outside the workspace", async () => {
    const [cwd, outside] = await Promise.all([
      mkdtemp(join(tmpdir(), "acpus-web-catalog-workspace-")),
      mkdtemp(join(tmpdir(), "acpus-web-catalog-outside-")),
    ]);
    try {
      await mkdir(join(outside, "release"));
      await writeFile(
        join(outside, "release", "workflow.ts"),
        "throw new Error('outside catalog must not be imported');\n",
      );
      await mkdir(join(cwd, ".acpus"));
      await symlink(outside, join(cwd, ".acpus", "workflows"), "dir");

      const result = await tryVisualizeWorkflowSource(cwd, {
        kind: "catalog",
        name: "release",
      });

      expect(result.isErr()).toBe(true);
      if (result.isOk()) throw new Error("expected source failure");
      expect(result.error).toMatchObject({
        type: "workflow-source-invalid",
        reason: "outside-workspace",
        phase: "source",
      });
    } finally {
      await Promise.all([
        rm(cwd, { recursive: true, force: true }),
        rm(outside, { recursive: true, force: true }),
      ]);
    }
  });

  it("derives one consistent static bundle from workflow IR", () => {
    const bundle = embeddedVisualization(renderWorkflowVizHtml({
      ir: workflowIr(),
      sourceGraphDigest,
    }));

    expect(bundle.workflow).toEqual({
      name: hostileName,
      description: hostileDescription,
      agents: {
        reviewer: { kind: "agent_definition", use: "codex", model: "gpt-5" },
      },
      irVersion: 7,
      nodeCount: 3,
    });
    expect(bundle.contract).toEqual({
      inputSchema: { kind: "object", fields: {}, required: [], additionalProperties: false },
      output: {
        kind: "object",
        fields: {
          approved: { kind: "literal", value: true },
          first_lane: { kind: "literal", value: "lane-alpha" },
        },
      },
      outputShape: { kind: "object", possibleKeys: ["approved", "first_lane"] },
    });
    expect(bundle.graph.mode).toBe("static");
    expect(bundle.graph.nodes.map(node => [node.id, node.kind])).toEqual(expect.arrayContaining([
      ["choose", "if"],
      ["review", "task"],
      ["fallback", "assert"],
    ]));
    expect(bundle.sourceGraphDigest).toBe(sourceGraphDigest);
  });

  it("renders an offline HTML shell that fences authored and embedded raw text", () => {
    const html = renderWorkflowVizHtml({
      ir: workflowIr(),
      sourceGraphDigest,
    });

    expect(html).toContain("<!doctype html>");
    expect(html).toContain("window.__ACPUS_WORKFLOW_VIZ__=");
    expect(html).toContain("<div id=\"root\"></div>");
    expect(html).toContain("<title>prepared-static &lt;review &amp; &quot;ship&quot;&gt;</title>");
    expect(html).not.toMatch(/\s(?:src|href)=["']https?:\/\//);
    expect(html).not.toContain(hostileDescription);
    expect(html.match(/<\/script(?=[\t\n\f\r />]|$)/giu)).toHaveLength(2);
    expect(html.match(/<\/style(?=[\t\n\f\r />]|$)/giu)).toHaveLength(1);
    expect(embeddedVisualization(html).workflow.description).toBe(hostileDescription);
  });
});

const sourceGraphDigest = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const hostileName = "prepared-static <review & \"ship\">";
const hostileDescription = "Prepared </script><script>globalThis.compromised = true</script>";

function workflowIr(): WorkflowIR {
  return {
    irVersion: 7,
    name: hostileName,
    description: hostileDescription,
    inputSchema: { kind: "object", fields: {}, required: [], additionalProperties: false },
    agents: {
      reviewer: { kind: "agent_definition", use: "codex", model: "gpt-5" },
    },
    root: {
      output: {
        kind: "object",
        fields: {
          approved: { kind: "literal", value: true },
          first_lane: { kind: "literal", value: "lane-alpha" },
        },
      },
      nodes: [{
        id: "choose",
        kind: "if",
        condition: { kind: "literal", value: true },
        then: {
          output: { kind: "object", fields: {} },
          nodes: [{
            id: "review",
            kind: "task",
            run: {
              input: { kind: "literal", value: "review" },
              target: { kind: "inline", source: "async function task() {}" },
            },
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
}

function embeddedVisualization(
  html: string,
): Omit<Extract<WorkflowVisualizationResult, { status: "ready" }>, "status"> {
  const marker = "window.__ACPUS_WORKFLOW_VIZ__=";
  const start = html.indexOf(marker);
  const jsonStart = start + marker.length;
  const jsonEnd = html.indexOf(";\n</script>", jsonStart);
  if (start < 0 || jsonEnd < 0) throw new Error("static visualization bundle is missing");
  return JSON.parse(html.slice(jsonStart, jsonEnd));
}
