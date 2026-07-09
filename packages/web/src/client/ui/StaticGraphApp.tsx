import * as React from "react";
import { useEffect, useState } from "react";
import { allExpanded, defaultStyles, JsonView } from "react-json-view-lite";
import "react-json-view-lite/dist/index.css";
import Copy from "lucide-react/dist/esm/icons/copy.js";
import XCircle from "lucide-react/dist/esm/icons/circle-x.js";
import type { WebGraph, WebGraphSelection, WorkflowVisualizationResult } from "../api.js";
import { RunGraph } from "./RunGraph.js";
import { Button } from "./shadcn/button.js";
import { Card } from "./shadcn/card.js";

export type StaticGraphData = {
  graph: WebGraph;
  title?: string;
  workflow?: Extract<WorkflowVisualizationResult, { status: "ready" }>["workflow"];
  contract?: Extract<WorkflowVisualizationResult, { status: "ready" }>["contract"];
  diagnostics?: Extract<WorkflowVisualizationResult, { status: "ready" }>["diagnostics"];
  sourceGraphDigest?: string;
};

type GraphInspectionTarget =
  | { kind: "workflow" }
  | { kind: "node"; id: string; context: WebGraphSelection[] };

const inspectorExitMs = 220;

export function StaticGraphApp({ data }: { data: StaticGraphData }) {
  const [selectedTarget, setSelectedTarget] = useState<GraphInspectionTarget | undefined>();
  const { exiting, close, layoutState } = useInspectorPresence(selectedTarget, () => setSelectedTarget(undefined));
  const selectedNodeId = selectedTarget?.kind === "node" ? selectedTarget.id : undefined;

  return (
    <div className="static-viz-root">
      <div className={`graph-inspection-layout ${layoutState === "open" ? "with-inspector" : layoutState === "closing" ? "closing-inspector" : ""}`}>
        <section className="graph-panel">
          <RunGraph
            graph={data.graph}
            {...(selectedNodeId === undefined ? {} : { selectedNodeId })}
            onSelectNode={(id, context = []) => setSelectedTarget(id ? { kind: "node", id, context } : undefined)}
            onSelectWorkflow={() => setSelectedTarget({ kind: "workflow" })}
          />
        </section>
        {selectedTarget && (
          <div className="inspector-slot">
            <InspectorPanel title={selectedTarget.kind === "workflow" ? "Workflow I/O" : selectedNodeId ?? "Node"} exiting={exiting} onClose={close}>
              {selectedTarget.kind === "workflow"
                ? <StaticWorkflowInspector data={data} />
                : <StaticGraphInspector graph={data.graph} target={selectedNodeId} />}
            </InspectorPanel>
          </div>
        )}
      </div>
    </div>
  );
}

function useInspectorPresence(target: GraphInspectionTarget | undefined, onExited: () => void): { exiting: boolean; layoutState: "closed" | "open" | "closing"; close(): void } {
  const [exiting, setExiting] = useState(false);

  useEffect(() => {
    if (target) setExiting(false);
  }, [target]);

  const close = () => {
    if (!target || exiting) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      onExited();
      return;
    }
    setExiting(true);
    window.setTimeout(() => {
      setExiting(false);
      onExited();
    }, inspectorExitMs);
  };

  return { exiting, layoutState: target ? exiting ? "closing" : "open" : "closed", close };
}

function StaticWorkflowInspector({ data }: { data: StaticGraphData }) {
  const workflow = data.workflow ?? {
    name: data.graph.workflow.name,
    ...(data.graph.workflow.description === undefined ? {} : { description: data.graph.workflow.description }),
    irVersion: data.graph.version ?? 0,
    nodeCount: data.graph.nodes.length,
  };
  return (
    <div className="inspector-stack">
      <InspectorSection title="Workflow">
        <KeyValue label="Name" value={workflow.name} />
        {workflow.description && <KeyValue label="Description" value={workflow.description} />}
        <KeyValue label="IR version" value={String(workflow.irVersion)} />
        <KeyValue label="Node count" value={String(workflow.nodeCount)} />
        {data.sourceGraphDigest && <KeyValue label="Source digest" value={data.sourceGraphDigest} />}
      </InspectorSection>
      {data.contract?.inputSchema ? (
        <JsonSection title="Input Contract" value={data.contract.inputSchema} />
      ) : (
        <InspectorSection title="Input Contract">
          <StateBlock title="No input schema" detail="This workflow does not declare an input schema." />
        </InspectorSection>
      )}
      <JsonSection title="Output Mapping" value={data.contract?.outputs ?? {}} />
    </div>
  );
}

function StaticGraphInspector({ graph, target }: { graph: WebGraph | undefined; target: string | undefined }) {
  if (!graph || !target) return <StateBlock title="Select a graph node" detail="Node details appear here after selection." />;
  const node = graph.nodes.find(item => item.id === target);
  const container = graph.containers.find(item => item.id === target);
  if (!node && !container) return <StateBlock title="No graph detail" detail="The selected graph target is no longer available." />;
  return (
    <div className="inspector-stack">
      <InspectorSection title="Identity">
        <KeyValue label="Kind" value={node?.kind ?? container?.kind ?? "unknown"} />
        <KeyValue label="Node ID" value={node?.nodeId ?? container?.nodeId ?? target} />
        <KeyValue label="Path" value={(node?.path ?? container?.path ?? []).join(" / ")} />
      </InspectorSection>
      {node?.detail && <JsonSection title="Definition" value={node.detail} />}
    </div>
  );
}

function InspectorPanel({
  title,
  exiting = false,
  onClose,
  children,
}: {
  title: string;
  exiting?: boolean;
  onClose(): void;
  children: React.ReactNode;
}) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <Card asChild className={`inspector-card ${exiting ? "exiting" : ""}`}>
      <aside role="dialog" aria-label={title}>
        <div className="inspector-card-head">
          <div>
            <span>Inspector</span>
            <strong>{title}</strong>
          </div>
          <Button variant="ghost" className="close-button" onClick={onClose} aria-label="Close inspector">
            <XCircle size={16} />
          </Button>
        </div>
        <div className="inspector-card-body">{children}</div>
      </aside>
    </Card>
  );
}

function InspectorSection({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="inspector-section">
      <div className="inspector-section-head">
        <h3>{title}</h3>
        {action}
      </div>
      <div className="inspector-section-body">{children}</div>
    </section>
  );
}

function JsonSection({ title, value }: { title: string; value: unknown }) {
  return (
    <InspectorSection title={title} action={<JsonCopyButton value={value} />}>
      <JsonBlock value={value} />
    </InspectorSection>
  );
}

function JsonCopyButton({ value }: { value: unknown }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  return (
    <Button
      type="button"
      variant="ghost"
      className={`json-copy-button ${state}`}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(JSON.stringify(value, null, 2));
          setState("copied");
          window.setTimeout(() => setState("idle"), 1_400);
        } catch {
          setState("failed");
          window.setTimeout(() => setState("idle"), 1_800);
        }
      }}
    >
      <Copy size={13} />
      {state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : "Copy JSON"}
    </Button>
  );
}

function JsonBlock({ value }: { value: unknown }) {
  return (
    <div className="json-viewer">
      <JsonView data={jsonViewData(value)} shouldExpandNode={allExpanded} style={defaultStyles} />
    </div>
  );
}

function jsonViewData(value: unknown): object | unknown[] {
  return value !== null && typeof value === "object" ? value as object | unknown[] : { value };
}

function KeyValue({ label, value }: { label: string; value: string }) {
  return (
    <div className="key-value" tabIndex={0} title={`${label}: ${value}`} aria-label={`${label}: ${value}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function StateBlock({ title, detail }: { title: string; detail?: string }) {
  return (
    <div className="state-block empty">
      <strong>{title}</strong>
      {detail && <span>{detail}</span>}
    </div>
  );
}
