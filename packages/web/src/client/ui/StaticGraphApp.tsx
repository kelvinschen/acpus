import { useState } from "react";
import Boxes from "lucide-react/dist/esm/icons/boxes.js";
import type { WebGraph, WorkflowVisualizationResult } from "../api.js";
import { graphContextLabel } from "../../graph-renderer.js";
import { GraphWorkspace, type GraphInspectionTarget } from "./GraphWorkspace.js";
import { InspectorSection, JsonSection, KeyValue } from "./Inspector.js";

export type StaticGraphData = {
  graph: WebGraph;
  workflow: Extract<WorkflowVisualizationResult, { status: "ready" }>["workflow"];
  contract: Extract<WorkflowVisualizationResult, { status: "ready" }>["contract"];
  sourceGraphDigest: string;
};

export function StaticGraphApp({ data }: { data: StaticGraphData }) {
  const [selectedTarget, setSelectedTarget] = useState<GraphInspectionTarget | undefined>();

  return (
    <div className="static-viz-root">
      <GraphWorkspace
        graph={data.graph}
        target={selectedTarget}
        onTargetChange={setSelectedTarget}
        heading={target => {
          if (target.kind === "workflow") return { eyebrow: "Workflow", title: "Contract", subtitle: data.workflow.name };
          const context = graphContextLabel(target.node.context);
          return { eyebrow: "Node", title: target.node.label, ...(context ? { subtitle: context } : {}) };
        }}
      >
        {target => target.kind === "workflow"
          ? <StaticWorkflowInspector data={data} />
          : <StaticGraphInspector graph={data.graph} target={target.node.nodeId} />}
      </GraphWorkspace>
    </div>
  );
}

function StaticWorkflowInspector({ data }: { data: StaticGraphData }) {
  const workflow = data.workflow;
  return (
    <div className="inspector-stack">
      <InspectorSection title="Workflow">
        <KeyValue label="Name" value={workflow.name} />
        {workflow.description && <KeyValue label="Description" value={workflow.description} />}
        <KeyValue label="IR version" value={String(workflow.irVersion)} />
        <KeyValue label="Node count" value={String(workflow.nodeCount)} />
        <KeyValue label="Output shape" value={formatOutputShape(data.contract.outputShape)} />
        <KeyValue label="Source digest" value={data.sourceGraphDigest} />
      </InspectorSection>
      {data.contract.inputSchema ? (
        <JsonSection title="Input Contract" value={data.contract.inputSchema} />
      ) : (
        <InspectorSection title="Input Contract">
          <StateBlock title="No input schema" detail="This workflow does not declare an input schema." />
        </InspectorSection>
      )}
      <JsonSection title="Output Expression" value={data.contract.output} />
    </div>
  );
}

function formatOutputShape(shape: StaticGraphData["contract"]["outputShape"]): string {
  if (shape.kind !== "object") return shape.kind;
  return `object (${shape.possibleKeys.length ? shape.possibleKeys.join(", ") : "no possible keys"})`;
}

function StaticGraphInspector({ graph, target }: { graph: WebGraph | undefined; target: string | undefined }) {
  if (!graph || !target) return <StateBlock title="Select a graph node" detail="Node details appear here after selection." />;
  const node = graph.nodes.find(item => item.id === target);
  const container = graph.containers.find(item => item.id === target);
  if (!node && !container) return <StateBlock title="No graph detail" detail="The selected graph target is no longer available." />;
  return (
    <div className="inspector-stack">
      <InspectorSection title="Node">
        <KeyValue label="Kind" value={node?.kind ?? container?.kind ?? "unknown"} />
        <KeyValue label="Node ID" value={node?.nodeId ?? container?.nodeId ?? target} />
        <KeyValue label="Path" value={(node?.path ?? container?.path ?? []).join(" / ")} />
      </InspectorSection>
      {node?.detail && <JsonSection title="Definition" value={node.detail} expandNested />}
    </div>
  );
}

function StateBlock({ title, detail }: { title: string; detail?: string }) {
  return (
    <div className="state-block empty">
      <span className="state-block-icon" aria-hidden="true"><Boxes size={16} /></span>
      <div>
        <strong>{title}</strong>
        {detail && <p>{detail}</p>}
      </div>
    </div>
  );
}
