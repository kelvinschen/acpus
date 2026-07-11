import * as React from "react";
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import Activity from "lucide-react/dist/esm/icons/activity.js";
import Ban from "lucide-react/dist/esm/icons/ban.js";
import Boxes from "lucide-react/dist/esm/icons/boxes.js";
import CheckCircle2 from "lucide-react/dist/esm/icons/circle-check-big.js";
import ChevronRight from "lucide-react/dist/esm/icons/chevron-right.js";
import ChevronsLeft from "lucide-react/dist/esm/icons/chevrons-left.js";
import ChevronsRight from "lucide-react/dist/esm/icons/chevrons-right.js";
import CircleAlert from "lucide-react/dist/esm/icons/circle-alert.js";
import Clock from "lucide-react/dist/esm/icons/clock.js";
import FileSearch from "lucide-react/dist/esm/icons/file-search.js";
import FileText from "lucide-react/dist/esm/icons/file-text.js";
import Folder from "lucide-react/dist/esm/icons/folder.js";
import LoaderCircle from "lucide-react/dist/esm/icons/loader-circle.js";
import Package from "lucide-react/dist/esm/icons/package.js";
import Pause from "lucide-react/dist/esm/icons/pause.js";
import Play from "lucide-react/dist/esm/icons/play.js";
import Radio from "lucide-react/dist/esm/icons/radio.js";
import RotateCcw from "lucide-react/dist/esm/icons/rotate-ccw.js";
import Search from "lucide-react/dist/esm/icons/search.js";
import Square from "lucide-react/dist/esm/icons/square.js";
import Workflow from "lucide-react/dist/esm/icons/workflow.js";
import XCircle from "lucide-react/dist/esm/icons/circle-x.js";
import {
  getConfig,
  getArtifactPreview,
  getHealth,
  getNodeExecutionInspection,
  getNodeInspection,
  getRunRuntimeSnapshot,
  listWorkflowCatalog,
  listWorkflowFiles,
  listRuns,
  submitRunCommand,
  visualizeWorkflow,
  type ArtifactReference,
  type HealthReport,
  type NodeExecutionInspection,
  type NodeInspection,
  type ProjectWorkflowCatalogEntry,
  type RunDetails,
  type RunRuntimeSnapshot,
  type RunRecord,
  type ServerConfig,
  type WebGraphSelection,
  type WorkflowFileEntry,
  type WorkflowVisualizationResult,
  type WorkflowVisualizationSource,
} from "../api.js";
import { RunGraph } from "./RunGraph.js";
import { InspectorPanel, InspectorSection, JsonBlock, JsonSection, KeyValue } from "./Inspector.js";
import { StaticGraphApp } from "./StaticGraphApp.js";
import { ToastViewport, useToasts } from "./Toast.js";
import { useInspectorPresence } from "./useInspectorPresence.js";
import { Button } from "./shadcn/button.js";
import { Alert } from "./shadcn/alert.js";
import { Badge } from "./shadcn/badge.js";
import {
  Breadcrumb,
  BreadcrumbButton,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbSeparator,
} from "./shadcn/breadcrumb.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "./shadcn/dialog.js";
import { Input } from "./shadcn/input.js";
import { List, ListRow } from "./shadcn/list.js";
import {
  Popover,
  PopoverClose,
  PopoverContent,
  PopoverTrigger,
} from "./shadcn/popover.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./shadcn/select.js";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "./shadcn/tabs.js";
import { Textarea } from "./shadcn/textarea.js";
import { normalizeRuntimeStatus, runtimeStatusLabel, type DisplayStatus } from "../../runtime-status.js";

type GraphInspectionTarget =
  | { kind: "workflow" }
  | { kind: "node"; id: string; context: WebGraphSelection[]; displayStatus?: DisplayStatus };

export function App() {
  const [page, setPage] = useState("runtime");
  const [selectedRunId, setSelectedRunId] = useState<string | undefined>();
  const [graphTarget, setGraphTarget] = useState<GraphInspectionTarget | undefined>();
  const [statusOpen, setStatusOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(true);

  const runs = useQuery({
    queryKey: ["runs"],
    queryFn: listRuns,
    refetchInterval: 4_000,
  });
  const health = useQuery({
    queryKey: ["health"],
    queryFn: getHealth,
    refetchInterval: 5_000,
  });
  const config = useQuery({
    queryKey: ["config"],
    queryFn: getConfig,
  });

  useEffect(() => {
    if (!selectedRunId && runs.data?.[0]) setSelectedRunId(runs.data[0].id);
  }, [runs.data, selectedRunId]);

  return (
    <main className={`app-shell ${sidebarCollapsed ? "sidebar-collapsed" : ""}`}>
      <aside className="sidebar">
        <div className="sidebar-head">
          <div className="brand">
            <div className="brand-mark"><Workflow size={19} /></div>
            <div className="brand-copy">
              <h1>Acpus</h1>
            </div>
          </div>
          <Button
            type="button"
            variant="ghost"
            className="sidebar-toggle"
            aria-label={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
            title={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
            onClick={() => setSidebarCollapsed(current => !current)}
          >
            {sidebarCollapsed ? <ChevronsRight size={16} /> : <ChevronsLeft size={16} />}
          </Button>
        </div>
        <nav className="nav-list">
          <NavButton icon={<Activity size={17} />} label="Runtime" active={page === "runtime"} onClick={() => setPage("runtime")} />
          <NavButton icon={<FileSearch size={17} />} label="Workflows" active={page === "workflows"} onClick={() => setPage("workflows")} />
        </nav>
        <Popover open={statusOpen} onOpenChange={setStatusOpen}>
          <PopoverTrigger asChild>
            <SidebarStatus health={health.data} config={config.data} />
          </PopoverTrigger>
          <StatusInfoPopover health={health.data} config={config.data} />
        </Popover>
      </aside>

      <section className="workspace">
        {page === "runtime" && (
          <RuntimePage
            runId={selectedRunId}
            runs={runs.data ?? []}
            selectedTarget={graphTarget}
            onSelectRun={id => {
              setSelectedRunId(id);
              setGraphTarget(undefined);
            }}
            onSelectTarget={setGraphTarget}
          />
        )}
        {page === "workflows" && <WorkflowsPage />}
      </section>
    </main>
  );
}

function RuntimePage({
  runId,
  runs,
  selectedTarget,
  onSelectRun,
  onSelectTarget,
}: {
  runId: string | undefined;
  runs: RunRecord[];
  selectedTarget: GraphInspectionTarget | undefined;
  onSelectRun(id: string): void;
  onSelectTarget(target: GraphInspectionTarget | undefined): void;
}) {
  const queryClient = useQueryClient();
  const { toasts, push, dismiss } = useToasts();
  const { exiting, close, layoutState } = useInspectorPresence(selectedTarget, () => onSelectTarget(undefined));
  const selectedNodeId = selectedTarget?.kind === "node" ? selectedTarget.id : undefined;
  const selectedNodeContext = selectedTarget?.kind === "node" ? selectedTarget.context : [];
  const selectedNodeDisplayStatus = selectedTarget?.kind === "node" ? selectedTarget.displayStatus : undefined;
  const snapshot = useQuery({
    queryKey: ["run-runtime-snapshot", runId],
    queryFn: () => getRunRuntimeSnapshot(runId!),
    enabled: Boolean(runId),
    refetchInterval: query => isTerminalRunStatus((query.state.data as RunRuntimeSnapshot | undefined)?.run.status) ? false : 1_000,
  });
  const inspection = useQuery({
    queryKey: ["node-inspection", runId, selectedNodeId, selectedNodeContext],
    queryFn: () => getNodeInspection(runId!, selectedNodeId!, selectedNodeContext),
    enabled: Boolean(runId && selectedNodeId),
    refetchInterval: nodeInspectionRefetchInterval(snapshot.data?.run.status),
  });
  const command = useMutation({
    mutationFn: (input: Record<string, unknown>) => submitRunCommand(runId!, input),
    onSuccess: async (_data, variables) => {
      push({ tone: "success", title: `${commandLabel(variables)} accepted` });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["run-runtime-snapshot", runId] }),
        queryClient.invalidateQueries({ queryKey: ["runs"] }),
      ]);
    },
    onError: (error, variables) => {
      push({ tone: "error", title: `${commandLabel(variables)} failed`, detail: error instanceof Error ? error.message : String(error) });
    },
  });

  const runDetails = snapshot.data?.run;
  const signalWait = selectedTarget?.kind === "node"
    ? inspection.data?.signalWaits.find(w => w.status === "awaiting")
    : undefined;
  const retryTargets = retryTargetsForRun(runDetails);
  const retryTargetSignature = retryTargets.map(target => target.value).join("|");
  const [retryTarget, setRetryTarget] = useState<string | undefined>();

  useEffect(() => {
    const values = new Set(retryTargets.map(target => target.value));
    setRetryTarget(current => current && values.has(current) ? current : retryTargets[0]?.value);
  }, [retryTargetSignature]);

  if (!runId) return <EmptyState title="No Run Selected" detail="Use the run selector to choose a durable run." />;
  const headerState = runHeaderViewState(runDetails, snapshot.error);

  return (
    <div className="runtime-grid">
      <header className="topbar">
        <div className="run-titlebar">
          {headerState.kind === "ready" ? (
            <>
              <h2>{headerState.run.name}</h2>
              <div className="run-meta">
                <RunStatusIndicator status={headerState.run.status} />
                <span>{runId}</span>
                {headerState.run.updatedAt && <span>{formatDate(headerState.run.updatedAt)}</span>}
              </div>
            </>
          ) : headerState.kind === "error" ? (
            <RunHeaderError message={headerState.message} />
          ) : (
            <RunHeaderSkeleton />
          )}
        </div>
        <div className="run-header-actions">
          <RunSelector runs={runs} selectedRunId={runId} onSelectRun={onSelectRun} />
          <RunControls
            disabled={!runDetails || command.isPending}
            status={runDetails?.status}
            selectedNodeId={selectedNodeId}
            retryTargets={retryTargets}
            selectedRetryTarget={retryTarget}
            onSelectRetryTarget={setRetryTarget}
            onCommand={input => command.mutate(input)}
          />
        </div>
      </header>

      <div className={`graph-inspection-layout ${layoutState === "open" ? "with-inspector" : layoutState === "closing" ? "closing-inspector" : ""}`}>
        <section className="graph-panel">
          <RunGraph
            graph={snapshot.data?.graph}
            {...(selectedNodeId === undefined ? {} : { selectedNodeId })}
            onSelectNode={(id, context = [], displayStatus) => onSelectTarget(id ? { kind: "node", id, context, ...(displayStatus ? { displayStatus } : {}) } : undefined)}
            onSelectWorkflow={() => onSelectTarget({ kind: "workflow" })}
          />
        </section>

        {selectedTarget && (
          <div className="inspector-slot">
            <InspectorPanel
              title={selectedTarget.kind === "workflow" ? "Workflow I/O" : inspection.data?.summary.nodeId ?? selectedNodeId ?? "Node"}
              exiting={exiting}
              onClose={close}
            >
              {selectedTarget.kind === "workflow" ? (
                <RuntimeWorkflowInspector run={runDetails} />
              ) : (
                <Inspector runId={runId} target={selectedNodeId} context={selectedNodeContext} displayStatus={selectedNodeDisplayStatus} inspection={inspection.data} loading={inspection.isLoading} />
              )}
              {selectedTarget.kind === "node" && signalWait && (
                <SignalBox
                  wait={signalWait}
                  onSubmit={payload => command.mutate({ type: "signal", target: signalWait.nodeKey, payload })}
                />
              )}
            </InspectorPanel>
          </div>
        )}
      </div>

      <ToastViewport toasts={toasts} onDismiss={dismiss} />
    </div>
  );
}

type RunHeaderViewState =
  | { kind: "ready"; run: RunDetails }
  | { kind: "loading" }
  | { kind: "error"; message: string };

function runHeaderViewState(run: RunDetails | undefined, error: unknown): RunHeaderViewState {
  if (run) return { kind: "ready", run };
  if (error) return { kind: "error", message: error instanceof Error ? error.message : String(error) };
  return { kind: "loading" };
}

function RunHeaderSkeleton() {
  return (
    <div className="run-header-skeleton" role="status" aria-label="Loading run details" aria-busy="true">
      <span className="state-skeleton-line title" aria-hidden="true" />
      <span className="state-skeleton-line meta" aria-hidden="true" />
    </div>
  );
}

function RunHeaderError({ message }: { message: string }) {
  return (
    <div className="run-header-error" role="alert">
      <strong>Run details unavailable</strong>
      <span>{message}</span>
    </div>
  );
}

function commandLabel(input: Record<string, unknown>): string {
  return typeof input.type === "string" ? input.type : "command";
}

function WorkflowsPage() {
  const [dir, setDir] = useState("");
  const [source, setSource] = useState<WorkflowVisualizationSource | undefined>();
  const [result, setResult] = useState<WorkflowVisualizationResult | undefined>();
  const catalog = useQuery({
    queryKey: ["workflow-catalog"],
    queryFn: listWorkflowCatalog,
  });
  const files = useQuery({
    queryKey: ["workflow-files", dir],
    queryFn: () => listWorkflowFiles(dir),
  });
  const visualize = useMutation({
    mutationFn: (next: WorkflowVisualizationSource) => visualizeWorkflow(next),
    onSuccess: next => {
      setResult(next);
    },
  });

  const graph = result?.status === "ready" ? result.graph : undefined;

  return (
    <div className="workflow-viz-grid">
      <section className="table-panel workflow-source-panel">
        <PageHeader title="Workflows" detail="Static Visualization" />
        <WorkflowSourcePicker
          catalog={catalog.data ?? []}
          catalogLoading={catalog.isLoading}
          catalogError={catalog.error}
          files={files.data?.entries ?? []}
          filesLoading={files.isLoading}
          filesError={files.error}
          dir={files.data?.dir ?? dir}
          selected={source}
          visualizing={visualize.isPending}
          visualizeError={visualize.error}
          visualizationFailure={result?.status === "failed" ? result : undefined}
          onOpenDir={setDir}
          onSelect={next => {
            setSource(next);
            setResult(undefined);
          }}
          onVisualize={() => source && visualize.mutate(source)}
        />
      </section>
      {graph && result?.status === "ready" ? (
        <StaticGraphApp data={result} />
      ) : (
        <section className="graph-panel">
          <EmptyState title="No Workflow Visualized" detail="Choose a catalog entry or workspace workflow file, then click Visualize." />
        </section>
      )}
    </div>
  );
}

function WorkflowSourcePicker({
  catalog,
  catalogLoading,
  catalogError,
  files,
  filesLoading,
  filesError,
  dir,
  selected,
  visualizing,
  visualizeError,
  visualizationFailure,
  onOpenDir,
  onSelect,
  onVisualize,
}: {
  catalog: ProjectWorkflowCatalogEntry[];
  catalogLoading: boolean;
  catalogError: unknown;
  files: WorkflowFileEntry[];
  filesLoading: boolean;
  filesError: unknown;
  dir: string;
  selected: WorkflowVisualizationSource | undefined;
  visualizing: boolean;
  visualizeError: unknown;
  visualizationFailure: Extract<WorkflowVisualizationResult, { status: "failed" }> | undefined;
  onOpenDir(dir: string): void;
  onSelect(source: WorkflowVisualizationSource): void;
  onVisualize(): void;
}) {
  const [activeTab, setActiveTab] = useState<"catalog" | "files">("catalog");
  const selectedSummary = describeWorkflowSource(selected);
  return (
    <div className="workflow-picker">
      <Tabs value={activeTab} onValueChange={value => setActiveTab(value as "catalog" | "files")} className="workflow-picker-tabs">
        <TabsList className="workflow-picker-tabs-list" aria-label="Workflow source type">
          <TabsTrigger value="catalog">Catalog</TabsTrigger>
          <TabsTrigger value="files">Files</TabsTrigger>
        </TabsList>
        <TabsContent value="catalog" className="workflow-picker-tab-panel">
          <WorkflowCatalogList
            entries={catalog}
            loading={catalogLoading}
            error={catalogError}
            selected={selected}
            onSelect={onSelect}
          />
        </TabsContent>
        <TabsContent value="files" className="workflow-picker-tab-panel">
          <WorkflowFileSelector
            entries={files}
            loading={filesLoading}
            error={filesError}
            dir={dir}
            selected={selected}
            onOpenDir={onOpenDir}
            onSelect={onSelect}
          />
        </TabsContent>
      </Tabs>
      <div className="workflow-picker-footer">
        <div className={`workflow-selected-source ${selected ? "selected" : ""}`}>
          <span>Selected source</span>
          <strong>{selectedSummary.title}</strong>
          {selectedSummary.detail && <small>{selectedSummary.detail}</small>}
        </div>
        <Button
          variant="default"
          className="primary-button"
          disabled={!selected || visualizing}
          onClick={onVisualize}
        >
          {visualizing ? "Visualizing..." : "Visualize"}
        </Button>
        {visualizeError ? (
          <StateBlock
            tone="error"
            title="Visualization failed"
            detail={visualizeError instanceof Error ? visualizeError.message : String(visualizeError)}
          />
        ) : null}
        {visualizationFailure && (
          <StateBlock tone="error" title={`${visualizationFailure.phase} failed`} detail={visualizationFailure.message} />
        )}
      </div>
    </div>
  );
}

function WorkflowCatalogList({
  entries,
  loading,
  error,
  selected,
  onSelect,
}: {
  entries: ProjectWorkflowCatalogEntry[];
  loading: boolean;
  error: unknown;
  selected: WorkflowVisualizationSource | undefined;
  onSelect(source: WorkflowVisualizationSource): void;
}) {
  if (loading) return <StateBlock tone="loading" title="Loading catalog" />;
  if (error) return <StateBlock tone="error" title="Catalog unavailable" detail={error instanceof Error ? error.message : String(error)} />;
  if (entries.length === 0) {
    return <StateBlock tone="empty" title="No catalog workflows" detail="Use Files to choose a workflow module from this workspace." />;
  }
  return (
    <List className="workflow-source-table" aria-label="Project catalog workflows">
      {entries.map(entry => {
        const active = selected?.kind === "catalog" && selected.name === entry.name;
        return (
          <ListRow
            key={entry.name}
            className={`workflow-list-row catalog ${active ? "selected" : ""}`}
            aria-pressed={active}
            onClick={() => onSelect({ kind: "catalog", name: entry.name })}
          >
            <Package size={15} />
            <span className="workflow-row-main">
              <strong>{entry.name}</strong>
              <small>{compactWorkflowPath(entry.entryPath)}</small>
            </span>
            <Badge className="workflow-row-badge">project</Badge>
          </ListRow>
        );
      })}
    </List>
  );
}

function WorkflowFileSelector({
  entries,
  loading,
  error,
  dir,
  selected,
  onOpenDir,
  onSelect,
}: {
  entries: WorkflowFileEntry[];
  loading: boolean;
  error: unknown;
  dir: string;
  selected: WorkflowVisualizationSource | undefined;
  onOpenDir(dir: string): void;
  onSelect(source: WorkflowVisualizationSource): void;
}) {
  const [filter, setFilter] = useState("");
  const normalizedFilter = filter.trim().toLowerCase();
  const visibleEntries = normalizedFilter
    ? entries.filter(entry => `${entry.name} ${entry.path}`.toLowerCase().includes(normalizedFilter))
    : entries;

  return (
    <div className="workflow-file-selector">
      <div className="workflow-file-toolbar">
        <WorkflowBreadcrumb dir={dir} onOpenDir={onOpenDir} />
        <label className="workflow-filter">
          <Search size={14} aria-hidden="true" />
          <Input
            value={filter}
            onChange={event => setFilter(event.currentTarget.value)}
            placeholder="Filter current directory"
            aria-label="Filter current directory"
          />
        </label>
      </div>
      {loading ? (
        <StateBlock tone="loading" title="Loading workspace files" />
      ) : error ? (
        <StateBlock tone="error" title="Files unavailable" detail={error instanceof Error ? error.message : String(error)} />
      ) : visibleEntries.length === 0 ? (
        <StateBlock tone="empty" title="No workflow files here" detail={filter ? "Clear the filter or open another directory." : "Open a directory that contains .workflow.ts or .workflow.tsx files."} />
      ) : (
        <List className="workflow-source-table" aria-label="Workspace workflow files">
          {visibleEntries.map(entry => {
            const active = selected?.kind === "file" && selected.path === entry.path;
            const directory = entry.kind === "directory";
            return (
              <ListRow
                key={`${entry.kind}:${entry.path}`}
                className={`workflow-list-row file ${directory ? "directory" : "workflow"} ${active ? "selected" : ""}`}
                aria-pressed={active}
                onClick={() => directory ? onOpenDir(entry.path) : onSelect({ kind: "file", path: entry.path })}
              >
                {directory ? <Folder size={15} /> : <FileText size={15} />}
                <span className="workflow-row-main">
                  <strong>{entry.name}</strong>
                  <small>{entry.path}</small>
                </span>
                <Badge className="workflow-row-badge">{directory ? "directory" : "workflow"}</Badge>
                {directory && <ChevronRight size={14} className="workflow-row-chevron" aria-hidden="true" />}
              </ListRow>
            );
          })}
        </List>
      )}
    </div>
  );
}

function WorkflowBreadcrumb({ dir, onOpenDir }: { dir: string; onOpenDir(dir: string): void }) {
  const segments = dir.split("/").filter(Boolean);
  const targets = segments.map((_segment, index) => segments.slice(0, index + 1).join("/"));
  return (
    <Breadcrumb aria-label="Workspace path" className="workflow-breadcrumb">
      <BreadcrumbList>
        <BreadcrumbItem>
          <BreadcrumbButton
            aria-current={dir.length === 0 ? "page" : undefined}
            onClick={() => onOpenDir("")}
          >
            Workspace
          </BreadcrumbButton>
        </BreadcrumbItem>
        {segments.map((segment, index) => {
          const target = targets[index]!;
          return (
            <React.Fragment key={target}>
              <BreadcrumbSeparator><ChevronRight size={13} /></BreadcrumbSeparator>
              <BreadcrumbItem>
                <BreadcrumbButton
                  aria-current={target === dir ? "page" : undefined}
                  onClick={() => onOpenDir(target)}
                >
                  {segment}
                </BreadcrumbButton>
              </BreadcrumbItem>
            </React.Fragment>
          );
        })}
      </BreadcrumbList>
    </Breadcrumb>
  );
}

function describeWorkflowSource(source: WorkflowVisualizationSource | undefined): { title: string; detail?: string } {
  if (!source) return { title: "None selected", detail: "Choose from Catalog or Files." };
  if (source.kind === "catalog") return { title: source.name, detail: "Project catalog entry" };
  return { title: fileNameFromPath(source.path), detail: source.path };
}

function fileNameFromPath(path: string): string {
  return path.split("/").filter(Boolean).at(-1) ?? path;
}

function compactWorkflowPath(path: string): string {
  const workflowMarker = "/.acpus/workflows/";
  const workflowIndex = path.indexOf(workflowMarker);
  if (workflowIndex >= 0) return `.acpus/workflows/${path.slice(workflowIndex + workflowMarker.length)}`;
  const packageMarker = "/packages/";
  const packageIndex = path.indexOf(packageMarker);
  if (packageIndex >= 0) return `packages/${path.slice(packageIndex + packageMarker.length)}`;
  return path;
}

function RuntimeWorkflowInspector({ run }: { run: RunDetails | undefined }) {
  if (!run) return <StateBlock tone="loading" title="Loading workflow I/O" />;
  const hasOutput = run.output !== undefined;
  const terminal = isTerminalRunStatus(run.status);
  return (
    <div className="inspector-stack">
      <InspectorSection title="Workflow">
        <KeyValue label="Name" value={run.name} />
        <KeyValue label="Run ID" value={run.id} />
        <KeyValue label="Status" value={runtimeStatusLabel(normalizeRuntimeStatus(run.status))} />
        {run.dynamic?.version !== undefined && <KeyValue label="Runtime version" value={String(run.dynamic.version)} />}
        <KeyValue label="Started" value={formatDate(run.createdAt)} />
        <KeyValue label="Updated" value={formatDate(run.updatedAt)} />
        <KeyValue label="Duration" value={formatDuration(durationBetween(run.createdAt, run.updatedAt))} />
      </InspectorSection>
      <JsonSection title="Input" value={run.input} />
      {hasOutput
        ? <JsonSection title="Output" value={run.output} />
        : (
          <InspectorSection title="Output">
            <StateBlock
              tone="empty"
              title={terminal ? "No workflow output recorded" : "Output pending"}
              detail={terminal ? "The run reached a terminal state without a workflow output value." : "Workflow output is available after the run completes."}
            />
          </InspectorSection>
        )}
    </div>
  );
}

function RunControls({
  disabled,
  status,
  selectedNodeId,
  retryTargets,
  selectedRetryTarget,
  onSelectRetryTarget,
  onCommand,
}: {
  disabled: boolean;
  status: string | undefined;
  selectedNodeId: string | undefined;
  retryTargets: RetryTarget[];
  selectedRetryTarget: string | undefined;
  onSelectRetryTarget(value: string): void;
  onCommand(input: Record<string, unknown>): void;
}) {
  const controls = controlStateForRun(status, disabled, retryTargets);
  const retryTarget = retryCommandTarget(retryTargets, selectedRetryTarget);
  const [pendingControl, setPendingControl] = useState<PendingControl | undefined>();
  const retryTargetLabel = retryTargets.find(target => target.value === retryTarget)?.label;

  return (
    <div className="control-strip">
      {retryTargets.length > 1 && controls.some(control => control.id === "retry") && (
        <Select
          value={selectedRetryTarget ?? retryTargets[0]?.value ?? ""}
          disabled={disabled}
          onValueChange={onSelectRetryTarget}
        >
          <SelectTrigger className="retry-target-select" aria-label="Retry target" title="Retry target">
            <SelectValue placeholder="Retry target" />
          </SelectTrigger>
          <SelectContent>
            {retryTargets.map(target => <SelectItem key={target.value} value={target.value}>{target.label}</SelectItem>)}
          </SelectContent>
        </Select>
      )}
      {controls.map(control => {
        const command = commandForControl(control.id, retryTarget, selectedNodeId);
        const commandDisabled = control.id === "retry" && !command;
        return (
          <IconButton
            key={control.id}
            label={control.label}
            title={control.title}
            tone={control.tone}
            icon={controlIcon(control.id)}
            disabled={control.disabled || commandDisabled}
            onClick={() => {
              if (!command) return;
              setPendingControl({
                control,
                command,
                targetLabel: control.id === "retry" ? retryTargetLabel : selectedNodeId,
                restoreFocus: document.activeElement instanceof HTMLElement ? document.activeElement : undefined,
              });
            }}
          />
        );
      })}
      {pendingControl && (
        <ConfirmDialog
          confirmation={confirmationForControl(pendingControl.control.id, pendingControl.targetLabel)}
          restoreFocus={pendingControl.restoreFocus}
          onCancel={() => setPendingControl(undefined)}
          onConfirm={() => {
            onCommand(pendingControl.command);
            setPendingControl(undefined);
          }}
        />
      )}
    </div>
  );
}

function RunSelector({
  runs,
  selectedRunId,
  onSelectRun,
}: {
  runs: RunRecord[];
  selectedRunId: string | undefined;
  onSelectRun(id: string): void;
}) {
  return (
    <label className="run-select-wrap">
      <span>Run</span>
      <Select {...(selectedRunId ? { value: selectedRunId } : {})} disabled={runs.length === 0} onValueChange={onSelectRun}>
        <SelectTrigger className="run-select" aria-label="Select run">
          <SelectValue placeholder="No runs" />
        </SelectTrigger>
        <SelectContent>
          {runs.map(run => (
            <SelectItem key={run.id} value={run.id}>
              {run.name} · {runtimeStatusLabel(normalizeRuntimeStatus(run.status))}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </label>
  );
}

export type RetryTarget = {
  value: string;
  label: string;
  kind: "frame" | "node" | "member";
};

export type RunControlId = "pause" | "resume" | "retry" | "cancel";

export type RunControlSpec = {
  id: RunControlId;
  label: string;
  tone: RunControlId;
  disabled: boolean;
  title: string;
};

type PendingControl = {
  control: RunControlSpec;
  command: Record<string, unknown>;
  targetLabel: string | undefined;
  restoreFocus: HTMLElement | undefined;
};

export type ControlConfirmation = {
  title: string;
  detail: string;
  confirmLabel: string;
  tone: RunControlId;
};

export function retryTargetsForRun(run: Pick<RunDetails, "dynamic"> | undefined): RetryTarget[] {
  const targets = new Map<string, RetryTarget>();
  const add = (target: RetryTarget) => {
    if (target.value.length > 0 && !targets.has(target.value)) targets.set(target.value, target);
  };

  for (const frame of run?.dynamic?.frames ?? []) {
    if (frame.status !== "failed") continue;
    if (frame.frameKind !== undefined && frame.frameKind !== "node" && frame.frameKind !== "loop") continue;
    add({
      value: frame.frameKey,
      label: frame.nodeId ? `frame: ${frame.nodeId}` : `frame: ${frame.frameKey}`,
      kind: "frame",
    });
  }
  for (const instance of run?.dynamic?.nodeInstances ?? []) {
    if (instance.status !== "failed") continue;
    add({
      value: instance.nodeKey,
      label: `node: ${instance.nodeId}`,
      kind: "node",
    });
  }
  for (const member of run?.dynamic?.groupMembers ?? []) {
    if (member.status !== "failed") continue;
    add({
      value: member.memberKey,
      label: `member: ${member.memberKind === "branch" ? member.branchId : `item[${member.itemIndex}]`}`,
      kind: "member",
    });
  }
  return [...targets.values()].sort((left, right) => left.value.localeCompare(right.value));
}

export function controlStateForRun(
  status: string | undefined,
  disabled: boolean,
  retryTargets: readonly RetryTarget[] = [],
): RunControlSpec[] {
  if (status === "failed") {
    return [{
      id: "retry",
      label: "Retry",
      tone: "retry",
      disabled: disabled || retryTargets.length === 0,
      title: retryTargets.length === 0 ? "No failed retry target found. Use CLI for run-level retry." : "Retry failed target",
    }];
  }
  if (status === "paused") {
    return [
      controlSpec("resume", disabled),
      controlSpec("cancel", disabled),
    ];
  }
  if (status === "pending" || status === "running" || status === "awaiting") {
    return [
      controlSpec("pause", disabled),
      controlSpec("cancel", disabled),
    ];
  }
  return [
    controlSpec("pause", true),
    controlSpec("cancel", true),
  ];
}

export function retryCommandTarget(
  retryTargets: readonly RetryTarget[],
  selectedRetryTarget: string | undefined,
): string | undefined {
  if (retryTargets.length === 1) return retryTargets[0]!.value;
  return retryTargets.some(target => target.value === selectedRetryTarget) ? selectedRetryTarget : undefined;
}

export function commandForControl(
  controlId: RunControlId,
  retryTarget: string | undefined,
  selectedNodeId: string | undefined,
): Record<string, unknown> | undefined {
  if (controlId === "retry") return retryTarget ? { type: "retry", target: retryTarget } : undefined;
  if (controlId === "cancel") return selectedNodeId ? { type: "cancel", target: selectedNodeId } : { type: "cancel" };
  return { type: controlId };
}

export function confirmationForControl(controlId: RunControlId, targetLabel: string | undefined): ControlConfirmation {
  if (controlId === "cancel") {
    return {
      title: targetLabel ? "Cancel selected target?" : "Cancel this run?",
      detail: targetLabel ? `Cancel target ${targetLabel}. This cannot be undone.` : "Cancel the current run. This cannot be undone.",
      confirmLabel: "Cancel",
      tone: "cancel",
    };
  }
  if (controlId === "retry") {
    return {
      title: "Retry failed target?",
      detail: targetLabel ? `Retry ${targetLabel}. The selected failed target will be re-driven.` : "Retry the selected failed target.",
      confirmLabel: "Retry",
      tone: "retry",
    };
  }
  if (controlId === "resume") {
    return {
      title: "Resume this run?",
      detail: "Resume the paused run and continue eligible work.",
      confirmLabel: "Resume",
      tone: "resume",
    };
  }
  return {
    title: "Pause this run?",
    detail: "Pause the run and stop active work as soon as the runtime can safely do so.",
    confirmLabel: "Pause",
    tone: "pause",
  };
}

function controlSpec(id: RunControlId, disabled: boolean): RunControlSpec {
  return {
    id,
    label: id[0]!.toUpperCase() + id.slice(1),
    tone: id,
    disabled,
    title: id[0]!.toUpperCase() + id.slice(1),
  };
}

function controlIcon(id: RunControlId): React.ReactNode {
  if (id === "pause") return <Pause size={16} />;
  if (id === "resume") return <Play size={16} />;
  if (id === "retry") return <RotateCcw size={16} />;
  return <Square size={16} />;
}

function ConfirmDialog({
  confirmation,
  restoreFocus,
  onCancel,
  onConfirm,
}: {
  confirmation: ControlConfirmation;
  restoreFocus: HTMLElement | undefined;
  onCancel(): void;
  onConfirm(): void;
}) {
  return (
    <Dialog open onOpenChange={open => {
      if (!open) onCancel();
    }}>
      <DialogContent
        className={`confirm-dialog ${confirmation.tone}`}
        onCloseAutoFocus={event => {
          event.preventDefault();
          restoreFocus?.focus();
        }}
      >
        <DialogTitle>{confirmation.title}</DialogTitle>
        <DialogDescription>{confirmation.detail}</DialogDescription>
        <div className="confirm-actions">
          <Button type="button" variant="confirmSecondary" onClick={onCancel}>Back</Button>
          <Button type="button" variant="confirmPrimary" tone={confirmation.tone} onClick={onConfirm}>
            {confirmation.confirmLabel}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Inspector({
  runId,
  target,
  context,
  displayStatus,
  inspection,
  loading,
}: {
  runId: string | undefined;
  target: string | undefined;
  context: WebGraphSelection[];
  displayStatus: DisplayStatus | undefined;
  inspection: NodeInspection | undefined;
  loading: boolean;
}) {
  const [activeTab, setActiveTab] = useState<InspectorTabId>("overview");
  useEffect(() => {
    setActiveTab("overview");
  }, [target]);
  useEffect(() => {
    const hasArtifacts = (inspection?.summary.artifacts.length ?? 0) > 0;
    const hasExecution = inspection?.summary.staticKind === "agent";
    if ((activeTab === "artifacts" && !hasArtifacts) || (activeTab === "execution" && !hasExecution)) {
      setActiveTab("overview");
    }
  }, [activeTab, inspection?.summary.artifacts.length, inspection?.summary.staticKind]);
  if (loading) return <StateBlock tone="loading" title="Loading node details" />;
  if (!inspection) return <StateBlock tone="empty" title="Select a graph node" detail="Node runtime details appear here after selection." />;
  const summary = inspection.summary;
  const runtimeStatus = displayStatus ?? normalizeRuntimeStatus(summary.nodeStatus ?? summary.runStatus);
  const hasArtifacts = summary.artifacts.length > 0;
  const hasExecution = summary.staticKind === "agent";
  return (
    <div className="inspector-stack">
      <div className="inspector-runtime-head">
        <StatusPill status={runtimeStatus} />
        <div>
          {summary.runStartedAt && (
            <>
              <span>Start</span>
              <strong>{formatDate(summary.runStartedAt)}</strong>
            </>
          )}
          {summary.runDurationMs !== undefined && (
            <>
              <span>Duration</span>
              <strong>{formatDuration(summary.runDurationMs)}</strong>
            </>
          )}
        </div>
      </div>
      <Tabs value={activeTab} onValueChange={value => setActiveTab(value as InspectorTabId)}>
        <TabsList className="inspector-tabs" aria-label="Inspector sections">
          <InspectorTab id="overview">Overview</InspectorTab>
          {hasArtifacts && <InspectorTab id="artifacts">Artifacts <Badge variant="tabCount">{summary.artifacts.length}</Badge></InspectorTab>}
          {hasExecution && <InspectorTab id="execution">Execution</InspectorTab>}
        </TabsList>

        <InspectorTabPanel id="overview">
          <>
          {summary.agent && <AgentOverview agent={summary.agent} />}

          <InspectorSection title="Identity">
            {summary.nodeId && <KeyValue label="Node ID" value={summary.nodeId} />}
            {summary.nodeKey && <KeyValue label="Node Key" value={summary.nodeKey} />}
            {summary.frameKey && <KeyValue label="Frame Key" value={summary.frameKey} />}
            {summary.staticKind && <KeyValue label="Kind" value={summary.staticKind} />}
            {summary.staticOrder !== undefined && <KeyValue label="Static order" value={String(summary.staticOrder)} />}
            <KeyValue label="Runtime" value={runtimeStatus} />
            {summary.latestAttempt && <KeyValue label="Latest attempt" value={`${summary.latestAttempt.attemptNo} · ${summary.latestAttempt.status}`} />}
          </InspectorSection>

          {summary.input && (
            <JsonSection title={summary.input.kind === "runtime" ? "Input" : "Authored Input"} value={summary.input.value} />
          )}

          {summary.prompt && (
            <InspectorSection title="Prompt">
              <PromptContent runId={runId} prompt={summary.prompt} />
            </InspectorSection>
          )}

          {summary.loopProgress && (
            <>
              <InspectorSection title="Loop Progress">
                <KeyValue label="Round" value={String(summary.loopProgress.round)} />
                <KeyValue label="Index" value={String(summary.loopProgress.index)} />
                <KeyValue label="Frame Key" value={summary.loopProgress.frameKey} />
                {summary.loopProgress.activeIterationFrameKey && <KeyValue label="Iteration Frame" value={summary.loopProgress.activeIterationFrameKey} />}
                {summary.loopProgress.stop !== undefined && <KeyValue label="Stop" value={String(summary.loopProgress.stop)} />}
              </InspectorSection>
              {summary.loopProgress.activeChildNodeKeys.length > 0 && <JsonSection title="Active Child Node Keys" value={summary.loopProgress.activeChildNodeKeys} />}
              {summary.loopProgress.state !== undefined && <JsonSection title="Loop State" value={summary.loopProgress.state} />}
              {summary.loopProgress.transition !== undefined && <JsonSection title="Last Transition" value={summary.loopProgress.transition} />}
            </>
          )}

          {summary.output !== undefined && (
            <JsonSection title="Output" value={summary.output} />
          )}

          {summary.failure !== undefined && (
            <JsonSection title="Diagnostics" value={summary.failure} />
          )}
          </>
        </InspectorTabPanel>

        {hasArtifacts && (
        <InspectorTabPanel id="artifacts">
          <ArtifactList runId={runId} artifacts={summary.artifacts} />
        </InspectorTabPanel>
        )}

        {hasExecution && (
        <InspectorTabPanel id="execution">
          {runId && target && <AgentExecutionTab runId={runId} target={target} context={context} active={activeTab === "execution"} />}
        </InspectorTabPanel>
        )}
      </Tabs>
    </div>
  );
}

export function AgentOverview({ agent }: { agent: NonNullable<NodeInspection["summary"]["agent"]> }) {
  const context = agent.context
    ? `${formatCompactCount(agent.context.used)}/${formatCompactCount(agent.context.size)}${agent.context.size > 0 ? ` (${Math.round((agent.context.used / agent.context.size) * 100)}%)` : ""}`
    : undefined;
  const tokens = agentTokenSummary(agent.tokenUsage);
  const tools = agent.tools?.recent.map(tool => {
    const glyph = toolStatusGlyph(tool.status);
    return `${glyph ? `${glyph} ` : ""}${tool.command}`;
  }).join(" · ");
  return (
    <InspectorSection title="Agent State">
      <KeyValue label="Agent" value={agent.key} />
      {agent.model && <KeyValue label="Model" value={agent.model} />}
      {agent.turnCount !== undefined && <KeyValue label="Turns" value={String(agent.turnCount)} />}
      {agent.lastActivityAt && <KeyValue label="Last active" value={formatRelativeAge(agent.lastActivityAt)} />}
      {context && <KeyValue label="Context" value={context} />}
      {tokens && <KeyValue label="Tokens" value={tokens} />}
      {tools && <KeyValue label="Last tools" value={tools} />}
    </InspectorSection>
  );
}

function agentTokenSummary(usage: NonNullable<NodeInspection["summary"]["agent"]>["tokenUsage"]): string | undefined {
  if (!usage) return undefined;
  return [
    usage.inputTokens === undefined ? undefined : `in ${formatCompactCount(usage.inputTokens)}`,
    usage.outputTokens === undefined ? undefined : `out ${formatCompactCount(usage.outputTokens)}`,
    usage.cachedReadTokens === undefined ? undefined : `cache read ${formatCompactCount(usage.cachedReadTokens)}`,
    usage.cachedWriteTokens === undefined ? undefined : `cache write ${formatCompactCount(usage.cachedWriteTokens)}`,
    usage.thoughtTokens === undefined ? undefined : `thought ${formatCompactCount(usage.thoughtTokens)}`,
    usage.totalTokens === undefined ? undefined : `total ${formatCompactCount(usage.totalTokens)}`,
  ].filter((value): value is string => value !== undefined).join(", ") || undefined;
}

function toolStatusGlyph(status: string | undefined): string | undefined {
  if (status === "running" || status === "started" || status === "in_progress") return "⠋";
  if (status === "completed" || status === "success" || status === "succeeded") return "✓";
  if (status === "failed" || status === "error" || status === "timed_out") return "◆";
  if (status === "canceled" || status === "cancelled") return "✗";
  return undefined;
}

function formatCompactCount(value: number): string {
  if (value < 1_000) return String(value);
  return `${(value / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
}

type InspectorTabId = "overview" | "artifacts" | "execution";

function InspectorTab({ id, children }: { id: InspectorTabId; children: React.ReactNode }) {
  return (
    <TabsTrigger
      value={id}
      id={`inspector-tab-${id}`}
      className="inspector-tab"
      aria-controls={`inspector-panel-${id}`}
    >
      {children}
    </TabsTrigger>
  );
}

function InspectorTabPanel({ id, children }: { id: InspectorTabId; children: React.ReactNode }) {
  return (
    <TabsContent value={id} id={`inspector-panel-${id}`} className="inspector-tab-panel" aria-labelledby={`inspector-tab-${id}`}>
      {children}
    </TabsContent>
  );
}

function PromptContent({ runId, prompt }: { runId: string | undefined; prompt: NonNullable<NodeInspection["summary"]["prompt"]> }) {
  if (prompt.text) return <MarkdownBlock value={prompt.text} />;
  if (!runId || !prompt.artifactId) return <StateBlock tone="empty" title="Prompt unavailable" detail="No prompt artifact or inline prompt was recorded for this scope." />;
  return <ArtifactPreviewBlock runId={runId} artifactId={prompt.artifactId} {...(prompt.mediaType ? { mediaType: prompt.mediaType } : {})} />;
}

function ArtifactList({ runId, artifacts }: { runId: string | undefined; artifacts: ArtifactReference[] }) {
  const [selectedArtifactId, setSelectedArtifactId] = useState<string | undefined>();
  const selected = artifacts.find(artifact => artifact.id === selectedArtifactId);
  return (
    <div className="artifact-stack">
      <div className="artifact-list">
        {artifacts.map(artifact => (
          <Button
            variant="ghost"
            key={artifact.id}
            className={`artifact-row ${artifact.id === selectedArtifactId ? "selected" : ""}`}
            title={artifact.path}
            aria-label={`Artifact ${artifact.path}`}
            onClick={() => setSelectedArtifactId(current => current === artifact.id ? undefined : artifact.id)}
          >
            <span className="artifact-title mono" title={artifact.path}>{artifact.path}</span>
            <span>{artifact.mediaType ?? "unknown"}</span>
            <span>{formatSize(artifact.size)}</span>
          </Button>
        ))}
      </div>
      {runId && selected && <ArtifactPreviewBlock runId={runId} artifactId={selected.id} {...(selected.mediaType ? { mediaType: selected.mediaType } : {})} />}
    </div>
  );
}

function ArtifactPreviewBlock({ runId, artifactId, mediaType }: { runId: string; artifactId: string; mediaType?: string }) {
  const preview = useQuery({
    queryKey: ["artifact-preview", runId, artifactId],
    queryFn: () => getArtifactPreview(runId, artifactId),
  });
  if (preview.isLoading) return <StateBlock tone="loading" title="Loading artifact" />;
  if (preview.error) return <StateBlock tone="error" title="Artifact preview failed" detail={preview.error instanceof Error ? preview.error.message : String(preview.error)} />;
  const loaded = preview.data;
  if (!loaded) return null;
  const effectiveMediaType = mediaType ?? loaded.mediaType;
  if (isJsonMedia(effectiveMediaType)) {
    const value = tryParseJsonPreview(loaded.text);
    return value.ok ? (
      <div className="json-standalone">
        <JsonBlock value={value.value} />
      </div>
    ) : (
      <TextArtifactPreview value={loaded.text} label="Raw JSON text" />
    );
  }
  if (isMarkdownMedia(effectiveMediaType)) return <MarkdownBlock value={loaded.text} />;
  if (isTextMedia(effectiveMediaType)) return <TextArtifactPreview value={loaded.text} />;
  return <StateBlock tone="empty" title="Preview unavailable" detail={`Preview is not available for ${effectiveMediaType}.`} />;
}

function AgentExecutionTab({ runId, target, context, active }: { runId: string; target: string; context: WebGraphSelection[]; active: boolean }) {
  const execution = useQuery({
    queryKey: ["node-execution", runId, target, context],
    queryFn: () => getNodeExecutionInspection(runId, target, context),
    enabled: active,
    refetchInterval: active ? 2_500 : false,
  });
  if (execution.isLoading) return <StateBlock tone="loading" title="Loading execution telemetry" />;
  if (execution.error) return <StateBlock tone="error" title="Execution telemetry failed" detail={execution.error instanceof Error ? execution.error.message : String(execution.error)} />;
  if (!execution.data) return <StateBlock tone="empty" title="No execution telemetry" detail="No agent execution metadata exists for the selected scope." />;
  const data = execution.data;
  if (!data.available) return <StateBlock tone="empty" title="No execution telemetry" detail={data.reason ?? "No agent execution metadata exists for the selected scope."} />;
  return (
    <div className="inspector-stack">
      <InspectorSection title="Summary">
        {data.summary.status && <KeyValue label="Status" value={data.summary.status} />}
        {data.lastActiveAt && <KeyValue label="Last active" value={formatRelativeAge(data.lastActiveAt)} />}
        {data.summary.sessionName && <KeyValue label="Session" value={data.summary.sessionName} />}
        {data.summary.turnCount !== undefined && <KeyValue label="Turns" value={String(data.summary.turnCount)} />}
        {data.summary.message && <KeyValue label="Message" value={data.summary.message} />}
      </InspectorSection>
      <InspectorSection title="Context Window">
        {data.contextWindow ? <ContextWindowMeter context={data.contextWindow} /> : <StateBlock tone="empty" title="No context window data" detail="The selected agent attempt did not report context usage." />}
      </InspectorSection>
      <InspectorSection title="Token Usage">
        {data.tokenUsage ? <TokenUsageMetrics usage={data.tokenUsage} /> : <StateBlock tone="empty" title="No token usage" detail="The selected agent attempt did not report token usage." />}
      </InspectorSection>
      <InspectorSection title="Output Stream">
        {data.output ? <TextArtifactPreview value={data.output.tail} label={progressOutputLabel(data.output)} /> : <StateBlock tone="empty" title="No streamed output" detail="The selected agent attempt did not report streamed output." />}
      </InspectorSection>
      <InspectorSection title="Last Tool Calls">
        {data.lastToolCalls.length > 0 ? <ToolCallList calls={data.lastToolCalls} total={data.toolCallCount} /> : <StateBlock tone="empty" title="No tool calls" detail="No tool calls were recorded for the selected agent attempt." />}
      </InspectorSection>
    </div>
  );
}

function ContextWindowMeter({ context }: { context: NonNullable<NodeExecutionInspection["contextWindow"]> }) {
  const percent = Math.max(0, Math.min(context.percent ?? 0, 100));
  return (
    <div className="execution-card">
      <div className="execution-meter-head">
        <strong>{context.used ?? "?"} / {context.size ?? "?"}</strong>
        {context.percent !== undefined && <span>{context.percent}%</span>}
      </div>
      <div className="execution-meter" aria-label={`Context window ${context.percent ?? 0}% used`}>
        <span style={{ width: `${percent}%` }} />
      </div>
      {context.updatedAt && <small>Updated {formatDate(context.updatedAt)}</small>}
    </div>
  );
}

function TokenUsageMetrics({ usage }: { usage: NonNullable<NodeExecutionInspection["tokenUsage"]> }) {
  return (
    <div className="execution-metrics">
      <Metric label="Input" value={usage.inputTokens} />
      <Metric label="Output" value={usage.outputTokens} />
      <Metric label="Total" value={usage.totalTokens} />
      {usage.source && <Metric label="Source" value={usage.source} />}
    </div>
  );
}

function progressOutputLabel(output: NonNullable<NodeExecutionInspection["output"]>): string {
  const retained = new TextEncoder().encode(output.tail).length;
  return output.truncated ? `Last ${retained} of ${output.totalBytes} bytes` : `${output.totalBytes} bytes`;
}

function Metric({ label, value }: { label: string; value: number | string | undefined }) {
  return (
    <div className="execution-metric">
      <span>{label}</span>
      <strong>{value ?? "n/a"}</strong>
    </div>
  );
}

function ToolCallList({ calls, total }: { calls: NodeExecutionInspection["lastToolCalls"]; total: number | undefined }) {
  return (
    <div className="tool-call-stack">
      {total !== undefined && <span className="tool-call-summary">Last {calls.length} of {total}</span>}
      {calls.map((call, index) => (
        <div key={`${call.turn}-${call.toolCallId ?? index}`} className="tool-call-row">
          <div className="tool-call-head">
            <div>
              <strong>{call.toolName ?? "Tool call"}</strong>
              <span>turn {call.turn}{call.durationMs !== undefined ? ` · ${formatDuration(call.durationMs)}` : ""}</span>
            </div>
            {call.status && <ToolCallStatus status={call.status} />}
          </div>
          {call.inputPreview && <p>{call.inputPreview}</p>}
          {call.outputPreview && <p>{call.outputPreview}</p>}
        </div>
      ))}
    </div>
  );
}

function ToolCallStatus({ status }: { status: string }) {
  const display = normalizeRuntimeStatus(status);
  return (
    <span className={`tool-call-status ${display}`}>
      {runStatusIcon(display)}
      <span>{runtimeStatusLabel(display)}</span>
    </span>
  );
}

function MarkdownBlock({ value }: { value: string }) {
  return (
    <div className="markdown-viewer">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{value}</ReactMarkdown>
    </div>
  );
}

function TextArtifactPreview({ value, label }: { value: string; label?: string }) {
  return (
    <div className="text-artifact-shell">
      {label && <div className="artifact-preview-label">{label}</div>}
      <pre className="text-artifact-preview">{value}</pre>
    </div>
  );
}

function SignalBox({
  wait,
  onSubmit,
}: {
  wait: { nodeKey: string; renderedPrompt?: string };
  onSubmit(payload: unknown): void;
}) {
  const [payload, setPayload] = useState("{}");
  const [payloadError, setPayloadError] = useState<string | undefined>();
  return (
    <form
      className="signal-box"
      onSubmit={e => {
        e.preventDefault();
        try {
          onSubmit(JSON.parse(payload));
          setPayloadError(undefined);
        } catch {
          setPayloadError("Signal payload must be valid JSON.");
        }
      }}
    >
      <strong>Awaiting Signal</strong>
      {wait.renderedPrompt && <p>{wait.renderedPrompt}</p>}
      <Textarea
        value={payload}
        aria-label="Signal payload JSON"
        aria-invalid={payloadError ? true : undefined}
        aria-describedby={payloadError ? "signal-payload-error" : undefined}
        onChange={e => {
          setPayload(e.target.value);
          if (payloadError) setPayloadError(undefined);
        }}
      />
      {payloadError && <p id="signal-payload-error" className="signal-error" role="alert">{payloadError}</p>}
      <Button className="primary-button" type="submit">Submit Signal</Button>
    </form>
  );
}

function StatusInfoPopover({
  health,
  config,
}: {
  health: HealthReport | undefined;
  config: ServerConfig | undefined;
}) {
  const daemon = health?.checks.find(check => check.area === "daemon");
  const checks = health?.checks.filter(check => check.area !== "daemon" && check.status !== "ok") ?? [];
  const status = daemon?.status ?? (health ? "unknown" : "checking");
  return (
    <PopoverContent
      className="status-info-popover"
      role="dialog"
      aria-labelledby="status-info-title"
    >
      <div className="dialog-head">
        <div className="status-info-title">
          <span className={`sidebar-status-icon ${status}`} aria-hidden="true">{sidebarStatusIcon(status)}</span>
          <h2 id="status-info-title">Runtime status</h2>
        </div>
        <PopoverClose asChild>
          <Button variant="ghost" className="close-button" aria-label="Close">
            <XCircle size={16} />
          </Button>
        </PopoverClose>
      </div>
      <div className="status-info-rows">
        <KeyValue label="Daemon" value={daemon?.message ? `${daemon.status}: ${daemon.message}` : status} />
        <KeyValue label="Access" value={config?.access === "token" ? "Token" : "Open"} />
        <KeyValue label="Workspace" value={config?.cwd ?? "Resolving"} />
        <div className="status-health-summary">
          {health ? (
            checks.length === 0 ? (
              <span>Health checks OK</span>
            ) : (
              checks.map(check => (
                <span key={`${check.area}-${check.message}`}>
                  {check.status === "warn" ? <CircleAlert size={14} /> : <XCircle size={14} />}
                  <strong>{check.area}</strong>
                  {check.message}
                </span>
              ))
            )
          ) : (
            <span>Checking runtime health</span>
          )}
        </div>
      </div>
    </PopoverContent>
  );
}

type SidebarStatusProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  health: HealthReport | undefined;
  config: ServerConfig | undefined;
};

const SidebarStatus = React.forwardRef<HTMLButtonElement, SidebarStatusProps>(({
  health,
  config,
  ...props
}, ref) => {
  const daemon = health?.checks.find(check => check.area === "daemon");
  const status = daemon?.status ?? (health ? "unknown" : "checking");
  return (
    <Button ref={ref} type="button" variant="ghost" className="sidebar-status" title="Runtime status" {...props}>
      <span className={`sidebar-status-icon ${status}`} aria-hidden="true">{sidebarStatusIcon(status)}</span>
      <span className="sidebar-status-copy">
        <span>Runtime status</span>
        <small>{status} · {config?.access === "token" ? "token" : "open"}</small>
      </span>
    </Button>
  );
});
SidebarStatus.displayName = "SidebarStatus";

function sidebarStatusIcon(status: string) {
  if (status === "ok" || status === "running") return <CheckCircle2 size={14} strokeWidth={2} />;
  if (status === "warn") return <CircleAlert size={14} strokeWidth={2} />;
  if (status === "fail" || status === "error") return <XCircle size={14} strokeWidth={2} />;
  if (status === "checking") return <LoaderCircle size={14} strokeWidth={2} />;
  return <Clock size={14} strokeWidth={2} />;
}

function NavButton({ icon, label, active, onClick }: { icon: React.ReactNode; label: string; active: boolean; onClick(): void }) {
  return (
    <Button
      variant="ghost"
      className={`nav-button ${active ? "active" : ""}`}
      aria-label={label}
      aria-current={active ? "page" : undefined}
      onClick={onClick}
    >
      {icon}
      <span>{label}</span>
    </Button>
  );
}

function IconButton({
  icon,
  label,
  title,
  disabled,
  tone,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  title: string;
  disabled: boolean;
  tone: RunControlId;
  onClick(): void;
}) {
  return (
    <Button variant="icon" tone={tone} disabled={disabled} onClick={onClick} title={title}>
      {icon}
      <span>{label}</span>
    </Button>
  );
}

function PageHeader({ title, detail }: { title: string; detail: string }) {
  return (
    <header className="page-header">
      <h2>{title}</h2>
      <span className="page-header-detail">{detail}</span>
    </header>
  );
}

function StatusPill({ status }: { status: string }) {
  return <Badge variant="status" className={status}>{status}</Badge>;
}

function RunStatusIndicator({ status }: { status: string }) {
  const display = normalizeRuntimeStatus(status);
  const active = display === "running" || display === "awaiting";
  return (
    <span className={`run-status-indicator ${display} ${active ? "live" : ""}`} aria-label={`Run status ${runtimeStatusLabel(display)}`}>
      <span className="run-status-icon">{runStatusIcon(display)}</span>
      <span className="run-status-label">{runtimeStatusLabel(display)}</span>
    </span>
  );
}

function isTerminalRunStatus(status: string | undefined): boolean {
  const display = normalizeRuntimeStatus(status);
  return display === "completed" || display === "failed" || display === "canceled";
}

export function nodeInspectionRefetchInterval(status: string | undefined): 1_000 | false {
  return isTerminalRunStatus(status) ? false : 1_000;
}

function runStatusIcon(status: string) {
  if (status === "running") return <LoaderCircle size={13} strokeWidth={2} />;
  if (status === "awaiting") return <Radio size={13} strokeWidth={2} />;
  if (status === "paused") return <Pause size={13} strokeWidth={2} />;
  if (status === "completed") return <CheckCircle2 size={13} strokeWidth={2} />;
  if (status === "failed") return <XCircle size={13} strokeWidth={2} />;
  if (status === "canceled") return <Ban size={13} strokeWidth={2} />;
  return <Clock size={13} strokeWidth={2} />;
}

function EmptyState({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="empty-state">
      <Boxes size={22} />
      <h2>{title}</h2>
      <p>{detail}</p>
    </div>
  );
}

function StateBlock({ tone, title, detail }: { tone: "loading" | "empty" | "error"; title: string; detail?: string }) {
  const icon = tone === "loading"
    ? <LoaderCircle size={16} />
    : tone === "error"
      ? <CircleAlert size={16} />
      : <Boxes size={16} />;
  return (
    <Alert
      className={`state-block ${tone}`}
      role={tone === "error" ? "alert" : tone === "loading" ? "status" : undefined}
      aria-busy={tone === "loading" ? true : undefined}
    >
      <span className="state-block-icon">{icon}</span>
      <div>
        <strong>{title}</strong>
        {detail && <p>{detail}</p>}
        {tone === "loading" && (
          <div className="state-skeleton" aria-hidden="true">
            <span className="state-skeleton-line" />
            <span className="state-skeleton-line short" />
          </div>
        )}
      </div>
    </Alert>
  );
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function formatRelativeAge(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return value;
  const ageMs = Math.max(0, Date.now() - timestamp);
  return ageMs < 1_000 ? "<1s ago" : `${formatDuration(ageMs)} ago`;
}

function durationBetween(start: string, end: string): number {
  return Math.max(0, Date.parse(end) - Date.parse(start));
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return remainingSeconds === 0 ? `${minutes}m` : `${minutes}m ${remainingSeconds}s`;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function isJsonMedia(mediaType: string): boolean {
  return mediaType.includes("json") || mediaType.includes("ndjson");
}

function isMarkdownMedia(mediaType: string): boolean {
  return mediaType.includes("markdown") || mediaType.includes("md");
}

function isTextMedia(mediaType: string): boolean {
  return mediaType.startsWith("text/") || mediaType.includes("xml") || mediaType.includes("yaml");
}

function tryParseJsonPreview(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    const lines = text.split("\n").filter(Boolean);
    if (lines.length === 0) return { ok: false };
    const values: unknown[] = [];
    for (const line of lines) {
      try {
        values.push(JSON.parse(line));
      } catch {
        return { ok: false };
      }
    }
    return { ok: true, value: values };
  }
}
