import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import ArrowLeft from "lucide-react/dist/esm/icons/arrow-left.js";
import CircleAlert from "lucide-react/dist/esm/icons/circle-alert.js";
import {
  getNodeInspection,
  getRunRuntimeSnapshot,
  submitRunCommand,
  type RunDetails,
  type RunRuntimeSnapshot,
  type RunRecord,
  type WebControlCommand,
  type WorkspaceSummary,
  type WorkflowContext,
} from "../api.js";
import { graphContextLabel } from "../graph/model.js";
import { GraphWorkspace, type GraphInspectionTarget } from "./GraphWorkspace.js";
import { InspectorSection, JsonSection, KeyValue, StateBlock } from "./Inspector.js";
import { NodeKindBadge } from "./NodeKind.js";
import {
  RunControls,
  retryTargetsForControls,
} from "./RunControls.js";
import {
  Inspector,
  nodeInspectionRefetchInterval,
  SignalBox,
} from "./RunInspector.js";
import { isTerminalRunStatus, RunStatusIndicator } from "./RunStatus.js";
import { ToastViewport, useToasts } from "./Toast.js";
import { durationBetween, formatDate, formatDuration } from "./display-format.js";
import { Badge } from "./shadcn/badge.js";
import { Button } from "./shadcn/button.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./shadcn/select.js";
import { normalizeRuntimeStatus, runtimeStatusLabel } from "../../runtime-status.js";

export function RunMonitorPage({
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

function StatusPill({ status }: { status: string }) {
  return <Badge variant="status" className={status}>{status}</Badge>;
}
