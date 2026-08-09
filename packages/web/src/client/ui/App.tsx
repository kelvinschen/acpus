import * as React from "react";
import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Activity from "lucide-react/dist/esm/icons/activity.js";
import ArrowLeft from "lucide-react/dist/esm/icons/arrow-left.js";
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
import Maximize2 from "lucide-react/dist/esm/icons/maximize-2.js";
import Package from "lucide-react/dist/esm/icons/package.js";
import Pause from "lucide-react/dist/esm/icons/pause.js";
import Play from "lucide-react/dist/esm/icons/play.js";
import RotateCcw from "lucide-react/dist/esm/icons/rotate-ccw.js";
import Search from "lucide-react/dist/esm/icons/search.js";
import Square from "lucide-react/dist/esm/icons/square.js";
import XCircle from "lucide-react/dist/esm/icons/circle-x.js";
import {
  getConfig,
  getArtifactPreview,
  getHealth,
  getNodeExecutionInspection,
  getNodeInspection,
  getNodeRuntimeValues,
  getRunRuntimeSnapshot,
  listWorkspaces,
  listWorkflowCatalog,
  listWorkflowFiles,
  listRuns,
  submitRunCommand,
  visualizeWorkflow,
  type HealthReport,
  type NodeExecutionInspection,
  type NodeDetail,
  type NodeInspection,
  type ProjectWorkflowCatalogEntry,
  type RunControlTarget,
  type RunDetails,
  type RunRuntimeSnapshot,
  type RunRecord,
  type ServerConfig,
  type WebControlCommand,
  type WorkspaceSummary,
  type WorkflowFileEntry,
  type WorkflowVisualizationResult,
  type WorkflowVisualizationSource,
  type WorkflowContext,
} from "../api.js";
import { InspectorSection, JsonBlock, JsonSection, KeyValue } from "./Inspector.js";
import { ArtifactViewer } from "./ArtifactViewer.js";
import { GraphWorkspace, type GraphInspectionTarget } from "./GraphWorkspace.js";
import { MarkdownDocument } from "./MarkdownDocument.js";
import { NodeDefinitionSection } from "./NodeDefinition.js";
import { NodeKindBadge } from "./NodeKind.js";
import { RunsPage } from "./RunsPage.js";
import { isTerminalRunStatus, RunStatusIndicator, RuntimeStatusIcon } from "./RunStatus.js";
import { StaticGraphApp } from "./StaticGraphApp.js";
import { ToastViewport, useToasts } from "./Toast.js";
import { durationBetween, formatDate, formatDuration, formatRelativeAge } from "./display-format.js";
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
import { normalizeRuntimeStatus, runtimeStatusLabel } from "../../runtime-status.js";
import { graphContextLabel } from "../../graph-renderer.js";

const logoLockupUrl = new URL("../assets/logo-lockup.svg", import.meta.url).href;

type AppView =
  | { page: "runs" }
  | { page: "run-monitor"; workspaceKey: string; runId: string }
  | { page: "workflows" };

type RunViewTransition = {
  finished: Promise<unknown>;
  skipTransition(): void;
};

type RunViewTransitionDocument = Document & {
  startViewTransition?(update: () => void): RunViewTransition;
};

export function App() {
  const [view, setView] = useState<AppView>({ page: "runs" });
  const [selectedRunsWorkspaceKey, setSelectedRunsWorkspaceKey] = useState<string | undefined>();
  const [graphTarget, setGraphTarget] = useState<GraphInspectionTarget | undefined>();
  const [statusOpen, setStatusOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const activeRunViewTransition = useRef<RunViewTransition | undefined>(undefined);
  const runViewTransitionSequence = useRef(0);
  const { toasts, push, dismiss } = useToasts();

  const workspaces = useQuery({
    queryKey: ["workspaces"],
    queryFn: listWorkspaces,
    refetchInterval: 30_000,
  });
  const selectedWorkspaceKey = selectedRunsWorkspaceKey ?? workspaces.data?.currentWorkspaceKey;
  const selectedWorkspaceAvailable = workspaces.data === undefined
    || workspaces.data.workspaces.some(workspace => workspace.key === selectedWorkspaceKey);
  const runs = useQuery({
    queryKey: ["runs", selectedWorkspaceKey],
    queryFn: () => listRuns(selectedWorkspaceKey!),
    enabled: Boolean(selectedWorkspaceKey && selectedWorkspaceAvailable),
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

  useEffect(() => () => {
    runViewTransitionSequence.current += 1;
    activeRunViewTransition.current?.skipTransition();
    delete document.documentElement.dataset.runTransition;
  }, []);

  useEffect(() => {
    if (view.page !== "runs" || !selectedRunsWorkspaceKey || !workspaces.data) return;
    if (workspaces.data.workspaces.some(workspace => workspace.key === selectedRunsWorkspaceKey)) return;
    setSelectedRunsWorkspaceKey(workspaces.data.currentWorkspaceKey);
    setGraphTarget(undefined);
    push({
      tone: "error",
      title: "Workspace unavailable",
      detail: "The selected workspace is no longer available. Returned to the current workspace.",
    });
  }, [push, selectedRunsWorkspaceKey, view.page, workspaces.data]);

  const changeView = (nextView: AppView, direction?: "forward" | "back") => {
    const sequence = runViewTransitionSequence.current + 1;
    runViewTransitionSequence.current = sequence;
    const update = () => {
      if (runViewTransitionSequence.current !== sequence) return;
      setView(nextView);
      setGraphTarget(undefined);
    };
    const viewTransitionDocument = document as RunViewTransitionDocument;
    const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    if (!direction || !viewTransitionDocument.startViewTransition || reducedMotion) {
      activeRunViewTransition.current?.skipTransition();
      activeRunViewTransition.current = undefined;
      delete document.documentElement.dataset.runTransition;
      update();
      return;
    }

    activeRunViewTransition.current?.skipTransition();
    document.documentElement.dataset.runTransition = direction;
    const transition = viewTransitionDocument.startViewTransition(() => flushSync(update));
    activeRunViewTransition.current = transition;
    const clearTransition = () => {
      if (activeRunViewTransition.current !== transition) return;
      activeRunViewTransition.current = undefined;
      delete document.documentElement.dataset.runTransition;
    };
    void transition.finished.then(clearTransition, clearTransition);
  };

  return (
    <main className={`app-shell ${sidebarCollapsed ? "sidebar-collapsed" : ""}`}>
      <aside className="sidebar">
        <div className="sidebar-head">
          <div className="brand">
            <img className="brand-lockup" src={logoLockupUrl} alt="Acpus" draggable={false} />
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
          <NavButton
            icon={<Activity size={17} />}
            label="Runs"
            active={view.page === "runs" || view.page === "run-monitor"}
            onClick={() => changeView({ page: "runs" }, view.page === "run-monitor" ? "back" : undefined)}
          />
          <NavButton icon={<FileSearch size={17} />} label="Workflows" active={view.page === "workflows"} onClick={() => changeView({ page: "workflows" })} />
        </nav>
        <Popover open={statusOpen} onOpenChange={setStatusOpen}>
          <PopoverTrigger asChild>
            <SidebarStatus health={health.data} config={config.data} />
          </PopoverTrigger>
          <StatusInfoPopover health={health.data} config={config.data} />
        </Popover>
      </aside>

      <section className="workspace">
        {view.page === "runs" && (
          <RunsPage
            key={selectedWorkspaceKey}
            runs={selectedWorkspaceAvailable ? runs.data : undefined}
            loading={workspaces.isPending || runs.isPending || !selectedWorkspaceAvailable}
            error={workspaces.error ?? runs.error}
            workspaceCatalog={workspaces.data}
            selectedWorkspaceKey={selectedWorkspaceKey}
            onRetry={() => void Promise.all([
              workspaces.refetch(),
              ...(selectedWorkspaceKey ? [runs.refetch()] : []),
            ])}
            onSelectWorkspace={workspaceKey => {
              setSelectedRunsWorkspaceKey(workspaceKey);
              setGraphTarget(undefined);
            }}
            onOpenRun={runId => selectedWorkspaceKey && changeView({ page: "run-monitor", workspaceKey: selectedWorkspaceKey, runId }, "forward")}
          />
        )}
        {view.page === "run-monitor" && (
          <RunMonitorPage
            workspaceKey={view.workspaceKey}
            workspace={workspaces.data?.workspaces.find(workspace => workspace.key === view.workspaceKey)}
            currentWorkspaceKey={workspaces.data?.currentWorkspaceKey}
            runId={view.runId}
            runs={runs.data ?? []}
            selectedTarget={graphTarget}
            onSelectRun={id => {
              setView({ page: "run-monitor", workspaceKey: view.workspaceKey, runId: id });
              setGraphTarget(undefined);
            }}
            onSelectTarget={setGraphTarget}
            onBack={() => changeView({ page: "runs" }, "back")}
          />
        )}
        {view.page === "workflows" && <WorkflowsPage />}
      </section>
      <ToastViewport toasts={toasts} onDismiss={dismiss} />
    </main>
  );
}

function RunMonitorPage({
  workspaceKey,
  workspace,
  currentWorkspaceKey,
  runId,
  runs,
  selectedTarget,
  onSelectRun,
  onSelectTarget,
  onBack,
}: {
  workspaceKey: string;
  workspace: WorkspaceSummary | undefined;
  currentWorkspaceKey: string | undefined;
  runId: string;
  runs: RunRecord[];
  selectedTarget: GraphInspectionTarget | undefined;
  onSelectRun(id: string): void;
  onSelectTarget(target: GraphInspectionTarget | undefined): void;
  onBack(): void;
}) {
  const queryClient = useQueryClient();
  const { toasts, push, dismiss } = useToasts();
  const selectedNode = selectedTarget?.kind === "node" ? selectedTarget.node : undefined;
  const selectedNodeTarget = selectedNode?.target;
  const readOnly = workspaceKey !== currentWorkspaceKey;
  const workspaceAvailable = workspace !== undefined;
  const snapshot = useQuery({
    queryKey: ["run-runtime-snapshot", workspaceKey, runId],
    queryFn: () => getRunRuntimeSnapshot(workspaceKey, runId),
    enabled: Boolean(workspaceAvailable && runId),
    refetchInterval: query => isTerminalRunStatus((query.state.data as RunRuntimeSnapshot | undefined)?.run.status) ? false : 1_000,
  });
  const inspection = useQuery({
    queryKey: ["node-inspection", workspaceKey, runId, selectedNodeTarget],
    queryFn: () => getNodeInspection(workspaceKey, runId, selectedNodeTarget!),
    enabled: Boolean(workspaceAvailable && runId && selectedNodeTarget),
    refetchInterval: nodeInspectionRefetchInterval(snapshot.data?.run.status),
  });
  const selectedCancelTarget = selectedNode
    ? inspection.data?.cancelTarget ?? null
    : undefined;
  const selectedCancelLabel = selectedNode
    ? [selectedNode.label, graphContextLabel(selectedNode.context)].filter(Boolean).join(" · ")
    : undefined;
  const command = useMutation({
    mutationFn: (input: WebControlCommand) => submitRunCommand(workspaceKey, runId, input),
    onSuccess: async (_data, variables) => {
      push({ tone: "success", title: `${commandLabel(variables)} accepted` });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["run-runtime-snapshot", workspaceKey, runId] }),
        queryClient.invalidateQueries({ queryKey: ["runs", workspaceKey] }),
      ]);
    },
    onError: (error, variables) => {
      push({ tone: "error", title: `${commandLabel(variables)} failed`, detail: error instanceof Error ? error.message : String(error) });
    },
  });

  const runDetails = snapshot.data?.run;
  const selectedAgentProfile = selectedNode?.detail?.kind === "agent"
    ? snapshot.data?.workflow.agents[selectedNode.detail.agent]
    : undefined;
  const signalWait = selectedTarget?.kind === "node"
    ? inspection.data?.awaitingSignal
    : undefined;
  const retryTargets = retryTargetsForControls(snapshot.data?.controls.retryTargets ?? []);
  const retryTargetSignature = retryTargets.map(target => target.value).join("|");
  const [retryTarget, setRetryTarget] = useState<string | undefined>();

  useEffect(() => {
    const values = new Set(retryTargets.map(target => target.value));
    setRetryTarget(current => current && values.has(current) ? current : retryTargets[0]?.value);
  }, [retryTargetSignature]);

  const headerState = runHeaderViewState(
    workspaceAvailable ? runDetails : undefined,
    workspaceAvailable ? snapshot.error : new Error("This workspace is no longer available."),
  );

  return (
    <div className="run-monitor-grid" aria-label="Run Monitor">
      <header className="topbar">
        <div className="run-heading-group">
          <Button type="button" variant="ghost" className="run-back-button" aria-label="Back to Runs" title="Back to Runs" onClick={onBack}>
            <ArrowLeft size={16} strokeWidth={2} aria-hidden="true" />
            <span>Runs</span>
          </Button>
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
            <WorkspaceIdentity workspaceKey={workspaceKey} workspace={workspace} current={!readOnly} />
          </div>
        </div>
        <div className="run-header-actions">
          {workspaceAvailable && <RunSelector runs={runs} selectedRunId={runId} onSelectRun={onSelectRun} />}
          {!workspaceAvailable || readOnly ? (
            <div className="workspace-access-state" role="status" title={workspace?.path ?? workspaceKey}>
              <span className={`workspace-scope-badge ${workspaceAvailable ? "read-only" : "unavailable"}`}>
                {workspaceAvailable ? "Read only" : "Unavailable"}
              </span>
              <span>Controls unavailable</span>
            </div>
          ) : (
            <RunControls
              disabled={!runDetails || command.isPending}
              status={runDetails?.status}
              selectedCancelTarget={selectedCancelTarget}
              selectedCancelLabel={selectedCancelLabel}
              canCancelRun={snapshot.data?.controls.canCancelRun ?? false}
              retryTargets={retryTargets}
              selectedRetryTarget={retryTarget}
              onSelectRetryTarget={setRetryTarget}
              onCommand={input => command.mutate(input)}
            />
          )}
        </div>
      </header>

      {!workspaceAvailable ? (
        <section className="workspace-unavailable-state" role="alert">
          <CircleAlert size={24} strokeWidth={2} aria-hidden="true" />
          <h2>Workspace unavailable</h2>
          <p>This workspace is no longer available. Return to Runs to choose another workspace.</p>
        </section>
      ) : <GraphWorkspace
        graph={snapshot.data?.graph}
        target={selectedTarget}
        onTargetChange={onSelectTarget}
        heading={target => {
          if (target.kind === "workflow") return { eyebrow: "Workflow", title: snapshot.data?.workflow.name ?? runDetails?.name ?? "Workflow", subtitle: runId };
          const context = graphContextLabel(target.node.context);
          return {
            eyebrow: <NodeKindBadge kind={target.node.kind} />,
            title: inspection.data?.nodeId ?? target.node.label,
            status: <StatusPill status={target.node.displayStatus} />,
            ...(context ? { subtitle: context } : {}),
          };
        }}
      >
        {target => target.kind === "workflow" ? (
          <RuntimeWorkflowInspector run={runDetails} workflow={snapshot.data?.workflow} />
        ) : (
          <>
            <Inspector
              workspaceKey={workspaceKey}
              runId={runId}
              target={selectedNodeTarget}
              definition={selectedNode?.detail}
              agentProfile={selectedAgentProfile}
              inspection={inspection.data}
              loading={inspection.isLoading}
            />
            {!readOnly && signalWait && (
              <SignalBox
                wait={signalWait}
                onSubmit={payload => command.mutate({ type: "signal", target: signalWait.target, payload })}
              />
            )}
          </>
        )}
      </GraphWorkspace>}

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

function WorkspaceIdentity({
  workspaceKey,
  workspace,
  current,
}: {
  workspaceKey: string;
  workspace: WorkspaceSummary | undefined;
  current: boolean;
}) {
  const name = workspace?.name ?? workspaceKey;
  const path = workspace?.path ?? "Workspace path unavailable";
  const scope = !workspace ? "Unavailable" : current ? "Current" : "Read only";
  return (
    <div
      className="run-workspace-identity"
      title={path}
      aria-label={`Workspace ${name}, ${scope.toLowerCase()}, ${path}`}
    >
      <span>{name}</span>
      <span className={`workspace-scope-badge ${!workspace ? "unavailable" : current ? "current" : "read-only"}`}>
        {scope}
      </span>
    </div>
  );
}

function commandLabel(input: WebControlCommand): string {
  return input.type;
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
    <List className="workflow-source-table" role="group" aria-label="Project catalog workflows">
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
        <List className="workflow-source-table" role="group" aria-label="Workspace workflow files">
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

function RuntimeWorkflowInspector({ run, workflow }: { run: RunDetails | undefined; workflow: WorkflowContext | undefined }) {
  if (!run || !workflow) return <StateBlock tone="loading" title="Loading workflow" />;
  const hasOutput = run.output !== undefined;
  const terminal = isTerminalRunStatus(run.status);
  return (
    <div className="inspector-stack">
      <InspectorSection title="Overview">
        {workflow.description && <KeyValue label="Description" value={workflow.description} />}
        <KeyValue label="Run ID" value={run.id} />
        <KeyValue label="Status" value={runtimeStatusLabel(normalizeRuntimeStatus(run.status))} />
        {run.runtimeVersion !== undefined && <KeyValue label="Runtime version" value={String(run.runtimeVersion)} />}
        <KeyValue label="Started" value={formatDate(run.createdAt)} />
        <KeyValue label="Updated" value={formatDate(run.updatedAt)} />
        <KeyValue label="Duration" value={formatDuration(durationBetween(run.createdAt, run.updatedAt))} />
      </InspectorSection>
      <JsonSection title="Agents" value={workflow.agents} expandNested />
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
  selectedCancelTarget,
  selectedCancelLabel,
  canCancelRun,
  retryTargets,
  selectedRetryTarget,
  onSelectRetryTarget,
  onCommand,
}: {
  disabled: boolean;
  status: string | undefined;
  selectedCancelTarget: string | null | undefined;
  selectedCancelLabel: string | undefined;
  canCancelRun: boolean;
  retryTargets: RetryTarget[];
  selectedRetryTarget: string | undefined;
  onSelectRetryTarget(value: string): void;
  onCommand(input: Exclude<WebControlCommand, { type: "signal" }>): void;
}) {
  const controls = controlStateForRun(status, disabled, retryTargets, canCancelRun);
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
        const command = commandForControl(control.id, retryTarget, selectedCancelTarget);
        const commandDisabled = (control.id === "retry" || control.id === "cancel") && !command;
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
                targetLabel: control.id === "retry" ? retryTargetLabel : selectedCancelLabel,
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
  const selectedRun = runs.find(run => run.id === selectedRunId);
  return (
    <label className="run-select-wrap">
      <span>Run</span>
      <Select {...(selectedRunId ? { value: selectedRunId } : {})} disabled={runs.length === 0} onValueChange={onSelectRun}>
        <SelectTrigger className="run-select" aria-label="Select run">
          <SelectValue placeholder="No runs">
            {selectedRun ? `${selectedRun.name} · ${runtimeStatusLabel(normalizeRuntimeStatus(selectedRun.status))}` : undefined}
          </SelectValue>
        </SelectTrigger>
        <SelectContent className="run-select-content">
          {runs.map(run => (
            <SelectItem
              key={run.id}
              value={run.id}
              aria-label={`${run.name}, ${runtimeStatusLabel(normalizeRuntimeStatus(run.status))}, run ${run.id}, started ${formatDate(run.createdAt)}`}
            >
              <span className="run-select-option">
                <span className="run-select-option-title">
                  {run.name} · {runtimeStatusLabel(normalizeRuntimeStatus(run.status))}
                </span>
                <span className="run-select-option-meta" title={run.id}>
                  {formatDate(run.createdAt)} · {run.id}
                </span>
              </span>
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
  kind: "frame" | "node";
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
  command: Exclude<WebControlCommand, { type: "signal" }>;
  targetLabel: string | undefined;
  restoreFocus: HTMLElement | undefined;
};

export type ControlConfirmation = {
  title: string;
  detail: string;
  confirmLabel: string;
  tone: RunControlId;
};

export function retryTargetsForControls(targets: readonly RunControlTarget[]): RetryTarget[] {
  const baseLabels = targets.map(target => `${target.kind}: ${target.nodeId ?? target.target}`);
  const counts = new Map<string, number>();
  for (const label of baseLabels) counts.set(label, (counts.get(label) ?? 0) + 1);
  return targets.map((target, index) => ({
    value: target.target,
    label: counts.get(baseLabels[index]!) === 1
      ? baseLabels[index]!
      : `${baseLabels[index]} (${target.target})`,
    kind: target.kind,
  }));
}

export function controlStateForRun(
  status: string | undefined,
  disabled: boolean,
  retryTargets: readonly RetryTarget[] = [],
  canCancelRun = false,
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
      controlSpec("cancel", disabled || !canCancelRun),
    ];
  }
  if (status === "pending" || status === "running" || status === "awaiting") {
    return [
      controlSpec("pause", disabled),
      controlSpec("cancel", disabled || !canCancelRun),
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
  selectedCancelTarget: string | null | undefined,
): Exclude<WebControlCommand, { type: "signal" }> | undefined {
  if (controlId === "retry") {
    return retryTarget?.trim() ? { type: "retry", target: retryTarget } : undefined;
  }
  if (controlId === "cancel" && selectedCancelTarget === null) return undefined;
  if (controlId === "cancel" && selectedCancelTarget === undefined) return { type: "cancel" };
  if (controlId === "cancel") {
    return selectedCancelTarget?.trim() ? { type: "cancel", target: selectedCancelTarget } : undefined;
  }
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

export function Inspector({
  workspaceKey,
  runId,
  target,
  definition,
  agentProfile,
  inspection,
  loading,
}: {
  workspaceKey: string;
  runId: string | undefined;
  target: string | undefined;
  definition: NodeDetail | undefined;
  agentProfile: WorkflowContext["agents"][string] | undefined;
  inspection: NodeInspection | undefined;
  loading: boolean;
}) {
  const [activeTab, setActiveTab] = useState<InspectorTabId>("overview");
  useEffect(() => {
    setActiveTab("overview");
  }, [target]);
  useEffect(() => {
    const hasArtifacts = (inspection?.artifacts.length ?? 0) > 0;
    const hasExecution = inspection?.staticKind === "agent";
    if ((activeTab === "artifacts" && !hasArtifacts) || (activeTab === "execution" && !hasExecution)) {
      setActiveTab("overview");
    }
  }, [activeTab, inspection?.artifacts.length, inspection?.staticKind]);
  if (loading) return <StateBlock tone="loading" title="Loading node details" />;
  if (!inspection) return <StateBlock tone="empty" title="Select a graph node" detail="Node runtime details appear here after selection." />;
  const hasArtifacts = inspection.artifacts.length > 0;
  const hasExecution = inspection.staticKind === "agent";
  return (
    <div className="inspector-stack tabbed">
      {inspection.timing && (
        <div className="inspector-runtime-meta" role="group" aria-label="Node timing">
          <div className="inspector-runtime-meta-item">
            <span>Node start</span>
            <strong>{formatDate(inspection.timing.startedAt)}</strong>
          </div>
          {inspection.timing.durationMs !== undefined && (
            <div className="inspector-runtime-meta-item duration">
              <span>Node duration</span>
              <strong>{formatDuration(inspection.timing.durationMs)}</strong>
            </div>
          )}
        </div>
      )}
      <Tabs className="inspector-tab-shell" value={activeTab} onValueChange={value => setActiveTab(value as InspectorTabId)}>
        <TabsList className="inspector-tabs" aria-label="Inspector sections">
          <InspectorTab id="overview">Overview</InspectorTab>
          {hasArtifacts && <InspectorTab id="artifacts">Artifacts <Badge variant="tabCount">{inspection.artifacts.length}</Badge></InspectorTab>}
          {hasExecution && <InspectorTab id="execution">Execution</InspectorTab>}
        </TabsList>

        <InspectorTabPanel id="overview">
          <>
          <InspectorSection title="Runtime target">
            {inspection.nodeKey && <KeyValue label="Node Key" value={inspection.nodeKey} />}
            {inspection.frameKey && <KeyValue label="Frame Key" value={inspection.frameKey} />}
            {inspection.latestAttempt && <KeyValue label="Latest attempt" value={`${inspection.latestAttempt.attemptNo} · ${inspection.latestAttempt.status}`} />}
          </InspectorSection>

          {definition && (
            <NodeDefinitionSection
              detail={definition}
              agentProfile={agentProfile}
              runtimeModel={inspection.agent?.model}
              lastObserved={inspection.agent?.lastObservedAt ? formatRelativeAge(inspection.agent.lastObservedAt) : undefined}
            />
          )}

          {definition && runId && target && supportsRuntimeValues(definition) && (
            <RuntimeValuesSection workspaceKey={workspaceKey} runId={runId} target={target} />
          )}

          {inspection.input && (
            <JsonSection title={inspection.input.kind === "runtime" ? "Input" : "Authored Input"} value={inspection.input.value} />
          )}

          {inspection.prompt && (
            <InspectorSection title="Prompt">
              <PromptContent workspaceKey={workspaceKey} runId={runId} prompt={inspection.prompt} />
            </InspectorSection>
          )}

          {inspection.loopProgress && (
            <>
              <InspectorSection title="Loop Progress">
                <KeyValue label="Round" value={String(inspection.loopProgress.round)} />
                <KeyValue label="Index" value={String(inspection.loopProgress.index)} />
                <KeyValue label="Frame Key" value={inspection.loopProgress.frameKey} />
                {inspection.loopProgress.activeIterationFrameKey && <KeyValue label="Iteration Frame" value={inspection.loopProgress.activeIterationFrameKey} />}
                {inspection.loopProgress.stop !== undefined && <KeyValue label="Stop" value={String(inspection.loopProgress.stop)} />}
              </InspectorSection>
              {inspection.loopProgress.activeChildNodeKeys.length > 0 && <JsonSection title="Active Child Node Keys" value={inspection.loopProgress.activeChildNodeKeys} />}
              {inspection.loopProgress.state !== undefined && <JsonSection title="Loop State" value={inspection.loopProgress.state} />}
              {inspection.loopProgress.transition !== undefined && <JsonSection title="Last Transition" value={inspection.loopProgress.transition} />}
            </>
          )}

          {inspection.output !== undefined && (
            <JsonSection title="Output" value={inspection.output} />
          )}

          {inspection.failure !== undefined && (
            <JsonSection title="Diagnostics" value={inspection.failure} />
          )}
          </>
        </InspectorTabPanel>

        {hasArtifacts && (
        <InspectorTabPanel id="artifacts" className="artifacts-panel">
          <ArtifactList workspaceKey={workspaceKey} runId={runId} artifacts={inspection.artifacts} />
        </InspectorTabPanel>
        )}

        {hasExecution && (
        <InspectorTabPanel id="execution">
          {runId && target && <AgentExecutionTab workspaceKey={workspaceKey} runId={runId} target={target} active={activeTab === "execution"} />}
        </InspectorTabPanel>
        )}
      </Tabs>
    </div>
  );
}

function RuntimeValuesSection({ workspaceKey, runId, target }: { workspaceKey: string; runId: string; target: string }) {
  const runtimeValues = useQuery({
    queryKey: ["node-runtime-values", workspaceKey, runId, target],
    queryFn: () => getNodeRuntimeValues(workspaceKey, runId, target),
    staleTime: Infinity,
    retry: false,
  });

  if (runtimeValues.isLoading) {
    return (
      <InspectorSection title="Runtime Values">
        <StateBlock tone="loading" title="Loading runtime values" />
      </InspectorSection>
    );
  }
  if (runtimeValues.error) {
    return (
      <InspectorSection title="Runtime Values">
        <StateBlock
          tone="error"
          title="Runtime values unavailable"
          detail={runtimeValues.error instanceof Error ? runtimeValues.error.message : String(runtimeValues.error)}
        />
      </InspectorSection>
    );
  }
  if (!runtimeValues.data?.available) {
    return (
      <InspectorSection title="Runtime Values">
        <StateBlock
          tone={runtimeValues.data?.reason === "resolution_failed" ? "error" : "empty"}
          title="Runtime values unavailable"
          detail={runtimeValuesUnavailableDetail(runtimeValues.data?.reason)}
        />
      </InspectorSection>
    );
  }
  return <JsonSection title="Runtime Values" value={runtimeValues.data.values} />;
}

function supportsRuntimeValues(definition: NodeDetail): boolean {
  if (definition.kind === "parallel") return definition.maxConcurrency !== undefined;
  return definition.kind === "assert"
    || definition.kind === "if"
    || definition.kind === "switch"
    || definition.kind === "fanout"
    || definition.kind === "loop";
}

function runtimeValuesUnavailableDetail(reason: string | undefined): string {
  if (reason === "not_started") return "This node has not started.";
  if (reason === "not_selected") return "This node was not selected for execution.";
  if (reason === "not_yet_resolved") return "The runtime has not resolved these values yet.";
  if (reason === "resolution_failed") return "The runtime could not resolve these values.";
  if (reason === "not_recorded") return "No durable runtime values were recorded.";
  return "Runtime values are not available for this node.";
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

function InspectorTabPanel({ id, className, children }: { id: InspectorTabId; className?: string; children: React.ReactNode }) {
  return (
    <TabsContent
      value={id}
      id={`inspector-panel-${id}`}
      className={`inspector-tab-panel${className ? ` ${className}` : ""}`}
      aria-labelledby={`inspector-tab-${id}`}
    >
      {children}
    </TabsContent>
  );
}

function PromptContent({ workspaceKey, runId, prompt }: { workspaceKey: string; runId: string | undefined; prompt: NonNullable<NodeInspection["prompt"]> }) {
  if (prompt.text) return <MarkdownBlock value={prompt.text} />;
  if (!runId || !prompt.artifactId) return <StateBlock tone="empty" title="Prompt unavailable" detail="No prompt artifact or inline prompt was recorded for this scope." />;
  return <ArtifactPreviewBlock workspaceKey={workspaceKey} runId={runId} artifactId={prompt.artifactId} {...(prompt.mediaType ? { mediaType: prompt.mediaType } : {})} />;
}

function ArtifactList({ workspaceKey, runId, artifacts }: { workspaceKey: string; runId: string | undefined; artifacts: NodeInspection["artifacts"] }) {
  const [viewerArtifactId, setViewerArtifactId] = useState<string | undefined>();
  const viewerTrigger = useRef<HTMLButtonElement | null>(null);
  const viewerArtifact = artifacts.find(artifact => artifact.id === viewerArtifactId);
  return (
    <div className="artifact-stack">
      <div className="artifact-list">
        {artifacts.map(artifact => (
          <Button
            key={artifact.id}
            type="button"
            variant="ghost"
            className="artifact-row"
            aria-label={`View artifact ${artifact.path}, ${artifact.mediaType ?? "unknown type"}, ${formatSize(artifact.size)}`}
            aria-haspopup="dialog"
            title={runId ? artifact.path : "Run unavailable"}
            disabled={!runId}
            onClick={event => {
              viewerTrigger.current = event.currentTarget;
              setViewerArtifactId(artifact.id);
            }}
          >
            <span className="artifact-title mono" title={artifact.path}>{artifact.path}</span>
            <span className="artifact-media">{artifact.mediaType ?? "unknown"}</span>
            <span className="artifact-size mono">{formatSize(artifact.size)}</span>
            <span className="artifact-view-cue" aria-hidden="true">
              <Maximize2 size={15} strokeWidth={2} />
              <span>View</span>
            </span>
          </Button>
        ))}
      </div>
      {runId && viewerArtifact && (
        <ArtifactViewer
          key={viewerArtifact.id}
          workspaceKey={workspaceKey}
          runId={runId}
          artifact={viewerArtifact}
          {...(viewerTrigger.current ? { restoreFocus: viewerTrigger.current } : {})}
          onClose={() => setViewerArtifactId(current => current === viewerArtifact.id ? undefined : current)}
        />
      )}
    </div>
  );
}

function ArtifactPreviewBlock({ workspaceKey, runId, artifactId, mediaType }: { workspaceKey: string; runId: string; artifactId: string; mediaType?: string }) {
  const preview = useQuery({
    queryKey: ["artifact-preview", workspaceKey, runId, artifactId],
    queryFn: () => getArtifactPreview(workspaceKey, runId, artifactId),
  });
  if (preview.isLoading) return <StateBlock tone="loading" title="Loading artifact" />;
  if (preview.error) return <StateBlock tone="error" title="Artifact preview failed" detail={preview.error instanceof Error ? preview.error.message : String(preview.error)} />;
  const loaded = preview.data;
  if (!loaded) return null;
  const effectiveMediaType = mediaType ?? loaded.mediaType;
  let body: React.ReactNode;
  if (isJsonMedia(effectiveMediaType)) {
    const value = tryParseJsonPreview(loaded.text);
    body = value.ok ? (
      <div className="json-standalone">
        <JsonBlock value={value.value} />
      </div>
    ) : (
      <TextArtifactPreview value={loaded.text} label="Raw JSON text" />
    );
  } else if (isMarkdownMedia(effectiveMediaType)) {
    body = <MarkdownBlock value={loaded.text} />;
  } else if (isTextMedia(effectiveMediaType)) {
    body = <TextArtifactPreview value={loaded.text} />;
  } else {
    body = <StateBlock tone="empty" title="Preview unavailable" detail={`Preview is not available for ${effectiveMediaType}.`} />;
  }
  return (
    <div className="artifact-preview-stack">
      {loaded.truncated && (
        <div className="artifact-preview-notice" role="status">
          Showing first 128 KiB of {formatSize(loaded.size)}.
        </div>
      )}
      <div className="artifact-preview-body">{body}</div>
    </div>
  );
}

export function AgentExecutionTab({ workspaceKey, runId, target, active }: { workspaceKey: string; runId: string; target: string; active: boolean }) {
  const execution = useQuery({
    queryKey: ["node-execution", workspaceKey, runId, target],
    queryFn: () => getNodeExecutionInspection(workspaceKey, runId, target),
    enabled: active,
    refetchInterval: query => agentExecutionRefetchInterval(
      active,
      (query.state.data as NodeExecutionInspection | undefined)?.summary.status,
    ),
  });
  if (execution.isLoading) return <StateBlock tone="loading" title="Loading execution details" />;
  if (execution.error) return <StateBlock tone="error" title="Execution details failed" detail={execution.error instanceof Error ? execution.error.message : String(execution.error)} />;
  if (!execution.data) return <StateBlock tone="empty" title="No execution details" detail="No agent execution metadata exists for the selected scope." />;
  const data = execution.data;
  if (!data.available) return <StateBlock tone="empty" title="No execution details" detail={data.reason ?? "No agent execution metadata exists for the selected scope."} />;
  return (
    <div className="inspector-stack">
      <InspectorSection title="Summary">
        <KeyValue label="Status" value={data.summary.status} />
        {data.lastObservedAt && <KeyValue label="Last observed" value={formatRelativeAge(data.lastObservedAt)} />}
        {data.summary.sessionName && <KeyValue label="Session" value={data.summary.sessionName} />}
        {data.summary.turnCount !== undefined && <KeyValue label="Turns" value={String(data.summary.turnCount)} />}
        {data.summary.message && <KeyValue label="Message" value={data.summary.message} />}
      </InspectorSection>
      {data.contextWindow && (
        <InspectorSection title="Context Window">
          <ContextWindowMeter context={data.contextWindow} />
        </InspectorSection>
      )}
      {data.tokenUsage && (
        <InspectorSection title="Token Usage">
          <TokenUsageMetrics usage={data.tokenUsage} />
        </InspectorSection>
      )}
      {data.output && (
        <InspectorSection title="Output Stream">
          <TextArtifactPreview value={data.output.tail} label={progressOutputLabel(data.output)} />
        </InspectorSection>
      )}
      <InspectorSection title="Recent observed tools">
        {data.recentTools.length > 0
          ? <ToolCallList calls={data.recentTools} />
          : <StateBlock tone="empty" title="No retained tool observations" detail="No retained tool observations are available for this agent." />}
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

function ToolCallList({ calls }: { calls: NodeExecutionInspection["recentTools"] }) {
  return (
    <div className="tool-call-stack">
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
        </div>
      ))}
    </div>
  );
}

function ToolCallStatus({ status }: { status: string }) {
  const display = normalizeRuntimeStatus(status);
  return (
    <span className={`tool-call-status ${display}`}>
      <RuntimeStatusIcon status={display} />
      <span>{runtimeStatusLabel(display)}</span>
    </span>
  );
}

function MarkdownBlock({ value }: { value: string }) {
  return <MarkdownDocument value={value} variant="compact" />;
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
  wait: NonNullable<NodeInspection["awaitingSignal"]>;
  onSubmit(payload: Extract<WebControlCommand, { type: "signal" }>["payload"]): void;
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
      {wait.prompt && <p>{wait.prompt}</p>}
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

export function nodeInspectionRefetchInterval(status: string | undefined): 1_000 | false {
  return isTerminalRunStatus(status) ? false : 1_000;
}

export function agentExecutionRefetchInterval(
  active: boolean,
  status: string | undefined,
): 2_500 | false {
  return active && (
    status === "starting"
    || status === "ready"
    || status === "running"
    || status === "awaiting"
  ) ? 2_500 : false;
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
