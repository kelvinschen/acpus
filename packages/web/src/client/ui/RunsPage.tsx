import { useEffect, useRef, useState } from "react";
import Boxes from "lucide-react/dist/esm/icons/boxes.js";
import ChevronRight from "lucide-react/dist/esm/icons/chevron-right.js";
import CircleAlert from "lucide-react/dist/esm/icons/circle-alert.js";
import RotateCcw from "lucide-react/dist/esm/icons/rotate-ccw.js";
import type { RunRecord, WorkspaceCatalog } from "../api.js";
import { Button } from "./shadcn/button.js";
import { Card } from "./shadcn/card.js";
import { durationBetween, formatDate, formatDuration } from "./display-format.js";
import { isTerminalRunStatus, RunStatusIndicator } from "./RunStatus.js";
import { WorkspaceSelector } from "./WorkspaceSelector.js";

export type RunsPageProps = {
  runs: RunRecord[] | undefined;
  loading: boolean;
  error: unknown;
  workspaceCatalog: WorkspaceCatalog | undefined;
  selectedWorkspaceKey: string | undefined;
  onRetry(): void;
  onSelectWorkspace(workspaceKey: string): void;
  onOpenRun(runId: string): void;
};

export function RunsPage({
  runs,
  loading,
  error,
  workspaceCatalog,
  selectedWorkspaceKey,
  onRetry,
  onSelectWorkspace,
  onOpenRun,
}: RunsPageProps) {
  const hasActiveRun = runs?.some(run => !isTerminalRunStatus(run.status)) ?? false;
  const runNow = useRunTime(hasActiveRun);
  const workspaceNow = useMinuteTime();
  const contentRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (contentRef.current) contentRef.current.scrollTop = 0;
  }, [selectedWorkspaceKey]);
  const countLabel = runs === undefined
    ? "Durable run history"
    : `${runs.length} ${runs.length === 1 ? "run" : "runs"}`;

  return (
    <div className="runs-page">
      <header className="runs-page-header">
        <div className="runs-page-title">
          <span className="runs-page-eyebrow">Run history</span>
          <h2>Runs</h2>
        </div>
        <div className="runs-page-header-actions">
          {workspaceCatalog && selectedWorkspaceKey ? (
            <WorkspaceSelector
              catalog={workspaceCatalog}
              selectedWorkspaceKey={selectedWorkspaceKey}
              now={workspaceNow}
              onSelect={onSelectWorkspace}
            />
          ) : (
            <div className="workspace-select-skeleton" role="status" aria-label="Loading workspaces" aria-busy="true">
              <span className="state-skeleton-line" aria-hidden="true" />
            </div>
          )}
          <span className="runs-page-count">{countLabel}</span>
        </div>
      </header>

      <div ref={contentRef} className="runs-page-content">
        {error && !runs ? (
          <RunsErrorState error={error} onRetry={onRetry} />
        ) : loading && !runs ? (
          <RunsLoadingState />
        ) : runs?.length ? (
          <div className="runs-card-grid">
            {runs.map(run => (
              <RunCard key={run.id} run={run} now={runNow} onOpen={() => onOpenRun(run.id)} />
            ))}
          </div>
        ) : (
          <RunsEmptyState />
        )}
      </div>
    </div>
  );
}

function RunCard({ run, now, onOpen }: { run: RunRecord; now: number; onOpen(): void }) {
  const terminal = isTerminalRunStatus(run.status);
  const duration = durationBetween(run.createdAt, terminal ? run.updatedAt : new Date(now).toISOString());
  return (
    <Card asChild>
      <button
        type="button"
        className="run-card"
        aria-label={`Open ${run.name} run ${run.id} in Run Monitor`}
        onClick={onOpen}
      >
        <div className="run-card-header">
          <div className="run-card-title">
            <span>Workflow run</span>
            <h3 title={run.name}>{run.name}</h3>
          </div>
          <RunStatusIndicator status={run.status} />
        </div>

        <span className="run-card-id" title={run.id}>{run.id}</span>

        <dl className="run-card-metrics">
          <RunCardMetric label="Started" value={formatDate(run.createdAt)} />
          <RunCardMetric label={terminal ? "Duration" : "Elapsed"} value={formatDuration(duration)} />
          <RunCardMetric label={terminal ? "Finished" : "Updated"} value={formatDate(run.updatedAt)} wide />
        </dl>

        <span className="run-card-action">
          Open Run Monitor
          <ChevronRight size={16} strokeWidth={2} aria-hidden="true" />
        </span>
      </button>
    </Card>
  );
}

function RunCardMetric({ label, value, wide = false }: { label: string; value: string; wide?: boolean }) {
  return (
    <div className={`run-card-metric ${wide ? "wide" : ""}`}>
      <dt>{label}</dt>
      <dd title={value}>{value}</dd>
    </div>
  );
}

function RunsLoadingState() {
  return (
    <div className="runs-card-grid" role="status" aria-label="Loading runs" aria-busy="true">
      {Array.from({ length: 6 }, (_, index) => (
        <div key={index} className="run-card run-card-skeleton" aria-hidden="true">
          <span className="state-skeleton-line title" />
          <span className="state-skeleton-line meta" />
          <span className="state-skeleton-line" />
          <span className="state-skeleton-line short" />
        </div>
      ))}
    </div>
  );
}

function RunsErrorState({ error, onRetry }: { error: unknown; onRetry(): void }) {
  return (
    <div className="runs-page-state error" role="alert">
      <CircleAlert size={22} strokeWidth={2} aria-hidden="true" />
      <h2>Runs unavailable</h2>
      <p>{error instanceof Error ? error.message : "The run list could not be loaded."}</p>
      <Button type="button" className="runs-page-retry" onClick={onRetry}>
        <RotateCcw size={16} strokeWidth={2} aria-hidden="true" />
        Retry
      </Button>
    </div>
  );
}

function RunsEmptyState() {
  return (
    <div className="runs-page-state empty">
      <Boxes size={22} strokeWidth={2} aria-hidden="true" />
      <h2>No runs yet</h2>
      <p>Start a workflow from the CLI and its durable run will appear here.</p>
      <code>acpus workflow run</code>
    </div>
  );
}

function useRunTime(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}

function useMinuteTime(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}
