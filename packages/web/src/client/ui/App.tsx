import * as React from "react";
import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Activity from "lucide-react/dist/esm/icons/activity.js";
import CheckCircle2 from "lucide-react/dist/esm/icons/circle-check-big.js";
import ChevronsLeft from "lucide-react/dist/esm/icons/chevrons-left.js";
import ChevronsRight from "lucide-react/dist/esm/icons/chevrons-right.js";
import CircleAlert from "lucide-react/dist/esm/icons/circle-alert.js";
import Clock from "lucide-react/dist/esm/icons/clock.js";
import FileSearch from "lucide-react/dist/esm/icons/file-search.js";
import LoaderCircle from "lucide-react/dist/esm/icons/loader-circle.js";
import XCircle from "lucide-react/dist/esm/icons/circle-x.js";
import {
  getConfig,
  getHealth,
  getRuntimeStore,
  listRuns,
  listWorkspaces,
  repairRuntimeStore,
  type HealthReport,
  type ServerConfig,
} from "../api.js";
import { type GraphInspectionTarget } from "./GraphWorkspace.js";
import { KeyValue } from "./Inspector.js";
import { RunMonitorPage } from "./RunMonitorPage.js";
import { RunsPage } from "./RunsPage.js";
import { RuntimeStoreNotice } from "./RuntimeStoreNotice.js";
import { ToastViewport, useToasts } from "./Toast.js";
import { WorkflowsPage } from "./WorkflowsPage.js";
import { Button } from "./shadcn/button.js";
import {
  Popover,
  PopoverClose,
  PopoverContent,
  PopoverTrigger,
} from "./shadcn/popover.js";

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
  const queryClient = useQueryClient();
  const [view, setView] = useState<AppView>({ page: "runs" });
  const [selectedRunsWorkspaceKey, setSelectedRunsWorkspaceKey] = useState<string | undefined>();
  const [graphTarget, setGraphTarget] = useState<GraphInspectionTarget | undefined>();
  const [statusOpen, setStatusOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const activeRunViewTransition = useRef<RunViewTransition | undefined>(undefined);
  const runViewTransitionSequence = useRef(0);
  const { toasts, push, dismiss } = useToasts();

  const runtimeStore = useQuery({
    queryKey: ["runtime-store"],
    queryFn: getRuntimeStore,
    retry: false,
  });

  const workspaces = useQuery({
    queryKey: ["workspaces"],
    queryFn: listWorkspaces,
    refetchInterval: 30_000,
  });
  const selectedWorkspaceKey = selectedRunsWorkspaceKey ?? workspaces.data?.currentWorkspaceKey;
  const selectedWorkspaceAvailable = workspaces.data === undefined
    || workspaces.data.workspaces.some(workspace => workspace.key === selectedWorkspaceKey);
  const selectedWorkspace = workspaces.data?.workspaces.find(workspace => workspace.key === selectedWorkspaceKey);
  const selectedWorkspaceReadable = selectedWorkspace?.runCount !== undefined;
  const runs = useQuery({
    queryKey: ["runs", selectedWorkspaceKey],
    queryFn: () => listRuns(selectedWorkspaceKey!),
    enabled: Boolean(selectedWorkspaceKey && selectedWorkspaceAvailable && selectedWorkspaceReadable),
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
  const runtimeRepair = useMutation({
    mutationFn: repairRuntimeStore,
    retry: false,
    onSuccess: async () => {
      push({ tone: "success", title: "Runtime fixed" });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["runtime-store"] }),
        queryClient.invalidateQueries({ queryKey: ["workspaces"] }),
        queryClient.invalidateQueries({ queryKey: ["runs"] }),
        queryClient.invalidateQueries({ queryKey: ["health"] }),
      ]);
    },
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
        <div className="workspace-shell">
          <RuntimeStoreNotice
            status={runtimeStore.data}
            loadError={runtimeStore.error}
            repairError={runtimeRepair.error}
            repairing={runtimeRepair.isPending}
            onFix={() => {
              runtimeRepair.reset();
              runtimeRepair.mutate();
            }}
            onRetry={() => void runtimeStore.refetch()}
          />
          <div className="workspace-view">
            {view.page === "runs" && (
              <RunsPage
                key={selectedWorkspaceKey}
                runs={selectedWorkspaceAvailable ? runs.data : undefined}
                loading={workspaces.isPending || (selectedWorkspaceReadable && runs.isPending) || !selectedWorkspaceAvailable}
                error={workspaces.error ?? runs.error}
                workspaceCatalog={workspaces.data}
                selectedWorkspaceKey={selectedWorkspaceKey}
                onRetry={() => void Promise.all([
                  workspaces.refetch(),
                  ...(selectedWorkspaceReadable ? [runs.refetch()] : []),
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
          </div>
        </div>
      </section>
      <ToastViewport toasts={toasts} onDismiss={dismiss} />
    </main>
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
