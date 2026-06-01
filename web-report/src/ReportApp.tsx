import React, { useEffect, useMemo, useState } from "react";
import ELK from "elkjs/lib/elk.bundled.js";
import {
  Background,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
  type Edge,
  type Node,
  type NodeProps
} from "@xyflow/react";
import {
  Activity,
  AlertTriangle,
  CircleDot,
  FileText,
  GitBranch,
  ListChecks,
  Route,
  Search,
  Server,
  Sparkles
} from "lucide-react";
import type { ReportEvent, ReportStageDetail, RunReportView } from "./types.js";

type Selection =
  | { kind: "stage"; id: string }
  | { kind: "attempt"; id: string }
  | { kind: "event"; id: string }
  | { kind: "diagnostic"; id: string }
  | { kind: "artifact"; id: string };

type StageNodeData = {
  label: string;
  kind: string;
  status: string;
  badges: string[];
  agent?: string;
  mode?: string;
  onSelect: () => void;
};

const statusLabels: Record<string, string> = {
  completed: "Completed",
  running: "Running",
  blocked: "Blocked",
  failed: "Failed",
  pending: "Pending",
  skipped: "Skipped",
  diagnosed_blocked: "Diagnosed"
};

export function ReportApp(): React.ReactElement {
  const [view, setView] = useState<RunReportView | undefined>(() => readInitialSnapshot());
  const [connection, setConnection] = useState(view ? "snapshot" : "connecting");
  const [section, setSection] = useState("Graph");
  const [selection, setSelection] = useState<Selection | undefined>(() => initialSelection(view));

  useEffect(() => {
    const live = readLiveConfig();
    if (!live) return;
    const source = new EventSource("/events");
    source.addEventListener("hello", () => setConnection("connected"));
    source.addEventListener("snapshot", (event) => {
      const next = JSON.parse((event as MessageEvent).data) as RunReportView;
      setView(next);
      setSelection((current) => current ?? initialSelection(next));
      setConnection("connected");
    });
    source.addEventListener("error", () => setConnection("disconnected"));
    return () => source.close();
  }, []);

  if (!view) {
    return <div className="empty-state">Connecting to workflow report...</div>;
  }

  const selectedStage = selection?.kind === "stage" ? view.stages.find((stage) => stage.id === selection.id) : undefined;
  const selectedAttempt = selection?.kind === "attempt" ? view.attempts.find((attempt) => attempt.id === selection.id) : undefined;
  const selectedEvent = selection?.kind === "event" ? view.events.find((event) => event.id === selection.id) : undefined;
  const selectedDiagnostic = selection?.kind === "diagnostic" ? view.diagnostics.find((diagnostic) => diagnostic.id === selection.id) : undefined;
  const selectedArtifact = selection?.kind === "artifact" ? view.artifacts[Number(selection.id)] : undefined;

  return (
    <ReactFlowProvider>
      <div className="app-shell">
        <aside className="sidebar">
          <div className="brand"><Sparkles size={20} /> ACPX</div>
          {["Overview", "Graph", "Stages", "Attempts", "Events", "Artifacts", "Diagnostics"].map((item) => (
            <button key={item} className={section === item ? "nav active" : "nav"} onClick={() => setSection(item)}>
              {navIcon(item)}
              {item}
            </button>
          ))}
        </aside>
        <main className="content">
          <header className="header">
            <div>
              <div className="eyebrow">Workflow Report</div>
              <h1>{view.run.workflowName}</h1>
              <div className="meta">Run {view.run.logicalRunId} · Generated {formatDate(view.generatedAt)}</div>
            </div>
            <div className={`status-pill status-${view.run.status}`}>{statusLabels[view.run.status] ?? view.run.status}</div>
            <div className="connection">{view.mode === "live" ? `Live ${connection}` : "Snapshot"}</div>
          </header>

          <section className="metrics" aria-label="Run metrics">
            <Metric label="Stages" value={`${view.metrics.stagesCompleted}/${view.metrics.stagesTotal}`} hint={`${view.metrics.stagesBlocked} blocked`} />
            <Metric label="Attempts" value={`${view.metrics.attemptsCompleted}/${view.metrics.attemptsTotal}`} hint={`${view.metrics.attemptsBlocked} blocked`} />
            <Metric label="Agent Calls" value={`${view.metrics.agentCallsActual ?? 0}/${view.metrics.agentCallsPlanned}`} hint={`${view.metrics.repairCalls ?? 0} repairs`} />
            <Metric label="Verdict" value={view.run.finalVerdict ?? "n/a"} hint={view.run.blockedReason ?? view.run.status} />
          </section>

          <section className="workspace">
            <div className="main-panel">
              {section === "Overview" && <Overview view={view} />}
              {section === "Graph" && <GraphView view={view} onSelect={(id) => setSelection({ kind: "stage", id })} />}
              {section === "Stages" && <StageTable view={view} onSelect={(id) => setSelection({ kind: "stage", id })} />}
              {section === "Attempts" && <AttemptList view={view} onSelect={(id) => setSelection({ kind: "attempt", id })} />}
              {section === "Events" && <EventList events={view.events} onSelect={(id) => setSelection({ kind: "event", id })} />}
              {section === "Artifacts" && <ArtifactList view={view} onSelect={(id) => setSelection({ kind: "artifact", id })} />}
              {section === "Diagnostics" && <DiagnosticList view={view} onSelect={(id) => setSelection({ kind: "diagnostic", id })} />}
            </div>
            <DetailPanel
              stage={selectedStage}
              attempt={selectedAttempt}
              event={selectedEvent}
              diagnostic={selectedDiagnostic}
              artifact={selectedArtifact}
            />
          </section>
        </main>
      </div>
    </ReactFlowProvider>
  );
}

function GraphView({ view, onSelect }: { view: RunReportView; onSelect: (id: string) => void }): React.ReactElement {
  const [nodes, setNodes] = useState<Node<StageNodeData>[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);

  useEffect(() => {
    let cancelled = false;
    void layoutGraph(view, onSelect).then((layouted) => {
      if (cancelled) return;
      setNodes(layouted.nodes);
      setEdges(layouted.edges);
    });
    return () => { cancelled = true; };
  }, [view, onSelect]);

  return (
    <div className="graph-panel" data-testid="report-graph">
      <ReactFlow nodes={nodes} edges={edges} nodeTypes={{ stage: StageNode }} fitView minZoom={0.2}>
        <Background />
        <Controls />
        <MiniMap pannable zoomable />
      </ReactFlow>
    </div>
  );
}

function StageNode({ data }: NodeProps<Node<StageNodeData>>): React.ReactElement {
  return (
    <button className={`stage-node status-${data.status}`} onClick={data.onSelect} data-stage-node={data.label}>
      <Handle type="target" position={Position.Left} />
      <div className="stage-node-title">{stageIcon(data.kind)} {data.label}</div>
      <div className="stage-node-subtitle">{data.agent ?? data.kind}{data.mode ? ` · ${data.mode}` : ""}</div>
      <div className="badges">{data.badges.slice(0, 3).map((badge) => <span key={badge}>{badge}</span>)}</div>
      <Handle type="source" position={Position.Right} />
    </button>
  );
}

async function layoutGraph(view: RunReportView, onSelect: (id: string) => void): Promise<{ nodes: Node<StageNodeData>[]; edges: Edge[] }> {
  const elk = new ELK();
  const graph = {
    id: "root",
    layoutOptions: { "elk.algorithm": "layered", "elk.direction": "RIGHT", "elk.spacing.nodeNode": "48" },
    children: view.graph.nodes.map((node) => ({ id: node.id, width: 190, height: 92 })),
    edges: view.graph.edges.map((edge) => ({ id: edge.id, sources: [edge.source], targets: [edge.target] }))
  };
  const layout = await elk.layout(graph);
  const positions = new Map((layout.children ?? []).map((node) => [node.id, { x: node.x ?? 0, y: node.y ?? 0 }]));
  return {
    nodes: view.graph.nodes.map((node) => ({
      id: node.id,
      type: "stage",
      position: positions.get(node.id) ?? { x: 0, y: 0 },
      data: {
        label: node.label,
        kind: node.kind,
        status: node.status,
        badges: node.badges,
        agent: node.agent,
        mode: node.mode,
        onSelect: () => onSelect(node.id)
      }
    })),
    edges: view.graph.edges.map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      label: edge.label,
      animated: edge.active,
      className: edge.relation === "decision-route" ? "edge-decision" : "edge-dependency"
    }))
  };
}

function Overview({ view }: { view: RunReportView }): React.ReactElement {
  return (
    <div className="stack">
      <h2>Summary</h2>
      <p>{view.summary.summary || "No summary available."}</p>
      <h3>Warnings</h3>
      <List values={[...view.summary.finalWarnings, ...view.summary.risks]} empty="No warnings or residual risks." />
    </div>
  );
}

function StageTable({ view, onSelect }: { view: RunReportView; onSelect: (id: string) => void }): React.ReactElement {
  return (
    <table className="data-table">
      <thead><tr><th>Stage</th><th>Kind</th><th>Status</th><th>Agent</th><th>Summary</th></tr></thead>
      <tbody>
        {view.stages.map((stage) => (
          <tr key={stage.id} onClick={() => onSelect(stage.id)}>
            <td>{stage.id}</td><td>{stage.kind}</td><td>{stage.status}</td><td>{stage.agent ?? "-"}</td><td>{stage.summary ?? "-"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function AttemptList({ view, onSelect }: { view: RunReportView; onSelect: (id: string) => void }): React.ReactElement {
  return <ListRows rows={view.attempts.map((attempt) => ({ id: attempt.id, title: attempt.id, subtitle: `${attempt.kind} · ${attempt.status}`, onClick: () => onSelect(attempt.id) }))} empty="No attempts." />;
}

function EventList({ events, onSelect }: { events: ReportEvent[]; onSelect: (id: string) => void }): React.ReactElement {
  return <ListRows rows={events.map((event) => ({ id: event.id, title: event.type ?? event.id, subtitle: event.at ?? "", onClick: () => onSelect(event.id) }))} />;
}

function ArtifactList({ view, onSelect }: { view: RunReportView; onSelect: (id: string) => void }): React.ReactElement {
  return <ListRows rows={view.artifacts.map((artifact, index) => ({ id: String(index), title: artifact.label ?? artifact.path ?? artifact.url ?? `artifact-${index + 1}`, subtitle: artifact.stageId ?? "", onClick: () => onSelect(String(index)) }))} empty="No artifacts." />;
}

function DiagnosticList({ view, onSelect }: { view: RunReportView; onSelect: (id: string) => void }): React.ReactElement {
  return <ListRows rows={view.diagnostics.map((diagnostic) => ({ id: diagnostic.id, title: diagnostic.id, subtitle: diagnostic.summary ?? diagnostic.status ?? "", onClick: () => onSelect(diagnostic.id) }))} empty="No diagnostics." />;
}

function DetailPanel({ stage, attempt, event, diagnostic, artifact }: {
  stage?: ReportStageDetail;
  attempt?: RunReportView["attempts"][number];
  event?: ReportEvent;
  diagnostic?: RunReportView["diagnostics"][number];
  artifact?: RunReportView["artifacts"][number];
}): React.ReactElement {
  const title = stage?.id ?? attempt?.id ?? event?.type ?? diagnostic?.id ?? artifact?.label ?? "Details";
  return (
    <aside className="detail-panel">
      <h2>{title}</h2>
      {stage && <StageDetail stage={stage} />}
      {attempt && <AttemptDetail attempt={attempt} />}
      {event && <PreviewBlock title="Event" preview={event.preview} />}
      {diagnostic && <PreviewBlock title="Diagnostic" preview={diagnostic.preview} />}
      {artifact && <JsonBlock value={artifact} />}
      {!stage && !attempt && !event && !diagnostic && !artifact && <p>Select a node or row to inspect details.</p>}
    </aside>
  );
}

function StageDetail({ stage }: { stage: ReportStageDetail }): React.ReactElement {
  return (
    <div className="stack">
      <div className={`status-pill status-${stage.status}`}>{stage.status}</div>
      <p>{stage.summary ?? "No stage summary."}</p>
      <dl>
        <dt>Kind</dt><dd>{stage.kind}</dd>
        <dt>Blocked reason</dt><dd>{stage.blockedReason ?? "-"}</dd>
        <dt>Role</dt><dd>{stage.roleName ?? "-"}</dd>
        <dt>Agent</dt><dd>{stage.agent ?? "-"}</dd>
        <dt>Mode</dt><dd>{stage.mode ?? "-"}</dd>
      </dl>
      {stage.outputParse && (
        <p>
          Output parse: {stage.outputParse.mode ?? "unknown"}
          {stage.outputParse.candidateCount !== undefined ? `, ${stage.outputParse.candidateCount} candidate(s)` : ""}
          {stage.outputParse.repaired ? ", repaired" : ""}
        </p>
      )}
      {stage.parseDiagnostics && (
        <details className="preview-block">
          <summary>Parse diagnostics · {stage.parseDiagnostics.errorCode ?? "unknown"}</summary>
          <JsonBlock value={stage.parseDiagnostics} />
        </details>
      )}
      {stage.fanout && <p>Fanout: {stage.fanout.completedItems ?? 0}/{stage.fanout.totalItems ?? 0} completed, {stage.fanout.blockedItems ?? 0} blocked.</p>}
      {stage.relatedAttemptIds.length > 0 && <p>Attempts: {stage.relatedAttemptIds.join(", ")}</p>}
      {stage.prompt && <PreviewBlock title="Prompt" preview={stage.prompt} />}
      {stage.output && <PreviewBlock title="Output" preview={stage.output} />}
    </div>
  );
}

function AttemptDetail({ attempt }: { attempt: RunReportView["attempts"][number] }): React.ReactElement {
  return (
    <div className="stack">
      <div className={`status-pill status-${attempt.status}`}>{attempt.status}</div>
      <dl>
        <dt>Stage</dt><dd>{attempt.stageId}</dd>
        <dt>Kind</dt><dd>{attempt.kind}</dd>
        <dt>Item</dt><dd>{attempt.itemId ?? "-"}</dd>
        <dt>Blocked reason</dt><dd>{attempt.blockedReason ?? "-"}</dd>
        <dt>Parse code</dt><dd>{attempt.parseErrorCode ?? "-"}</dd>
      </dl>
      {attempt.prompt && <PreviewBlock title="Prompt" preview={attempt.prompt} />}
      {attempt.raw && <PreviewBlock title="Raw" preview={attempt.raw} />}
      {attempt.parse && <PreviewBlock title="Parse" preview={attempt.parse} />}
      {attempt.output && <PreviewBlock title="Output" preview={attempt.output} />}
    </div>
  );
}

function PreviewBlock({ title, preview }: { title: string; preview: { text: string; truncated: boolean; originalChars?: number; path?: string } }): React.ReactElement {
  return (
    <details className="preview-block">
      <summary>{title}{preview.truncated ? ` · truncated from ${preview.originalChars} chars` : ""}</summary>
      {preview.path && <div className="path">{preview.path}</div>}
      <pre>{preview.text}</pre>
    </details>
  );
}

function JsonBlock({ value }: { value: unknown }): React.ReactElement {
  return <pre className="json-block">{JSON.stringify(value, null, 2)}</pre>;
}

function Metric({ label, value, hint }: { label: string; value: string; hint: string }): React.ReactElement {
  return <div className="metric"><span>{label}</span><strong>{value}</strong><small>{hint}</small></div>;
}

function List({ values, empty }: { values: string[]; empty: string }): React.ReactElement {
  return values.length > 0 ? <ul>{values.map((value) => <li key={value}>{value}</li>)}</ul> : <p>{empty}</p>;
}

function ListRows({ rows, empty = "No rows." }: { rows: Array<{ id: string; title: string; subtitle: string; onClick: () => void }>; empty?: string }): React.ReactElement {
  if (rows.length === 0) return <p>{empty}</p>;
  return <div className="row-list">{rows.map((row) => <button key={row.id} onClick={row.onClick}><strong>{row.title}</strong><span>{row.subtitle}</span></button>)}</div>;
}

function readInitialSnapshot(): RunReportView | undefined {
  const node = document.getElementById("acpx-report-snapshot");
  if (!node?.textContent) return undefined;
  return JSON.parse(node.textContent) as RunReportView;
}

function readLiveConfig(): { runId: string } | undefined {
  const node = document.getElementById("acpx-report-live");
  if (!node?.textContent) return undefined;
  return JSON.parse(node.textContent) as { runId: string };
}

function initialSelection(view: RunReportView | undefined): Selection | undefined {
  if (!view) return undefined;
  const stage = view.stages.find((candidate) => candidate.status === "blocked" || candidate.status === "running")
    ?? view.stages.find((candidate) => candidate.kind === "summarize")
    ?? view.stages[0];
  return stage ? { kind: "stage", id: stage.id } : undefined;
}

function navIcon(item: string): React.ReactElement {
  const props = { size: 17 };
  if (item === "Overview") return <Activity {...props} />;
  if (item === "Graph") return <GitBranch {...props} />;
  if (item === "Stages") return <ListChecks {...props} />;
  if (item === "Attempts") return <ListChecks {...props} />;
  if (item === "Events") return <CircleDot {...props} />;
  if (item === "Artifacts") return <FileText {...props} />;
  return <AlertTriangle {...props} />;
}

function stageIcon(kind: string): React.ReactElement {
  const props = { size: 15 };
  if (kind === "discover") return <Search {...props} />;
  if (kind === "decisionGate") return <Route {...props} />;
  if (kind === "summarize") return <Sparkles {...props} />;
  return <Server {...props} />;
}

function formatDate(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
}
