import type { WorkflowIR } from "@acpus/core/ir";
import { staticVizCss, staticVizJs } from "../static-viz-assets.generated.js";
import { staticWorkflowVisualization } from "./visualization.js";

export type WorkflowVizHtmlOptions = {
  ir: WorkflowIR;
  sourceGraphDigest: string;
};

export function renderWorkflowVizHtml(options: WorkflowVizHtmlOptions): string {
  const { graph, workflow, contract, sourceGraphDigest } =
    staticWorkflowVisualization(options.ir, options.sourceGraphDigest);
  const bundle = { graph, workflow, contract, sourceGraphDigest };
  const bundleJson = JSON.stringify(bundle).replaceAll("</", "<\\/");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(workflow.name)}</title>
<style>
${staticVizCss}
</style>
</head>
<body>
<div id="root"></div>
<script>
window.__ACPUS_WORKFLOW_VIZ__=${bundleJson};
</script>
<script>
${staticVizJs}
</script>
</body>
</html>
`;
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("\"", "&quot;");
}
