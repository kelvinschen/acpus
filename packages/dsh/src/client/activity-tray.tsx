import type { PropsRuntime } from "@deepseek-ai/dsh-client-ui-slots";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import type {
  ActivityHoverDetail,
  ActivityNode,
  ActivityNodeStatus,
  AgentActivity,
  AcpusTaskAvailability,
  DelegatedTaskSummary,
  DelegatedTaskActivity,
  HoverResult,
  ResolvedTaskSelector,
} from "../remote/types.js";
import { agentIcon } from "./agent-icons.js";
import {
  sessionConnectionPhase,
  subscribeStore,
  type AcpusClientState,
  type SessionConnection,
  type SessionConnectionPhase,
} from "./state.js";

export type AcpusActivityTrayProps =
  & PropsRuntime<"conversation.input.dock">
  & { acpus: AcpusClientState };

export const ACTIVITY_HOVER_DELAY_MS = 700;
const useBrowserLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

export function AcpusActivityTray({
  acpus,
  sessionId,
  useSessions,
}: AcpusActivityTrayProps) {
  const [subscribe, snapshot] = subscribeStore(acpus.projections);
  const state = useSyncExternalStore(subscribe, snapshot);
  const enabled = useSessions(
    sessions => sessions.byId[sessionId]?.agentPreset === "acpus",
  );
  const projection = enabled ? state.sessions[sessionId] : undefined;
  const connection = enabled ? state.connections[sessionId] : undefined;
  const selection = enabled ? state.selections[sessionId] : undefined;
  const task = projection?.task;
  const [expanded, setExpanded] = useState(() => acpus.activityExpanded(sessionId));
  const [cancelState, setCancelState] = useState<
    "idle" | "confirming" | "canceling" | "failed"
  >("idle");
  const [historyOpen, setHistoryOpen] = useState(false);
  const [, refreshTree] = useState(0);
  const disconnected = connection?.status === "disconnected";
  const unavailable = task?.availability.status === "unavailable"
    ? task.availability
    : undefined;
  const now = useClock(task !== undefined
    && unavailable === undefined
    && (!terminalTask(task.status) || disconnected));
  const connectionPhase = sessionConnectionPhase(connection, now);
  const observedNow = unavailable !== undefined
    ? Date.parse(unavailable.detectedAt)
    : disconnected
      ? connection.synchronizedAt ?? connection.disconnectedAt
      : now;

  useEffect(
    () => enabled ? acpus.watchSession(sessionId) : undefined,
    [acpus, enabled, sessionId],
  );

  useEffect(() => {
    setExpanded(acpus.activityExpanded(sessionId));
    setCancelState("idle");
    setHistoryOpen(false);
  }, [acpus, sessionId, task?.generation]);

  useEffect(() => {
    if (disconnected && cancelState === "confirming") setCancelState("idle");
  }, [cancelState, disconnected]);

  if (task === undefined) return null;
  const summary = unavailable === undefined
    ? activitySummary(task)
    : availabilitySummary(unavailable);
  const uncertain = unavailable === undefined
    && disconnected
    && !terminalTask(task.status);
  const totalDuration = formatObservedDuration(
    taskDuration(task, observedNow),
    uncertain,
  );
  const connected = connection?.status === "connected";
  const duplicated = (projection?.tasks.filter(candidate =>
    candidate.task.name === task.selector.name).length ?? 0) > 1
    || task.selector.occurrence > 1;
  const toggle = () => {
    const next = !expanded;
    acpus.setActivityExpanded(sessionId, next);
    setExpanded(next);
  };
  const cancelable = unavailable === undefined
    && ["pending", "running", "awaiting", "paused"].includes(task.status);
  const confirmCancel = async () => {
    setCancelState("canceling");
    try {
      const result = await acpus.cancelSessionTask(sessionId, task.generation);
      setCancelState(result.status === "applied" ? "idle" : "failed");
    } catch {
      setCancelState("failed");
    }
  };

  return (
    <section
      className="acpus-activity-tray"
      data-acpus-activity-tray=""
      data-status={task.status}
      data-availability={task.availability.status}
    >
      <div className="acpus-tray-header">
        <button
          className="acpus-tray-toggle"
          type="button"
          aria-expanded={expanded}
          aria-label={expanded ? "收起任务执行状态" : "展开任务执行状态"}
          onClick={toggle}
        >
          <ActivityStateIcon state={summary.tone} />
          <span className="acpus-tray-summary">
            <strong title={task.selector.name}>{task.selector.name}{duplicated ? ` · ${task.selector.occurrence}` : ""}</strong>
            <span className="acpus-tray-total-time">总耗时 {totalDuration}</span>
            <span className="acpus-summary-meta">
              <span role="status" aria-live="polite">{summary.title}</span>
              {summary.agent && <AgentIdentity name={summary.agent} />}
            </span>
          </span>
          <span className="acpus-tray-count">
            {task.counts.completed}/{task.counts.total}
          </span>
          <Chevron expanded={expanded} />
        </button>
        <ConnectionStatus phase={connectionPhase} connection={connection} />
        {(projection?.tasks.length ?? 0) > 1 && (
          <button
            className="acpus-history-button"
            type="button"
            aria-expanded={historyOpen}
            aria-label="选择 Acpus 历史任务"
            title="历史任务"
            onClick={() => setHistoryOpen(open => !open)}
          >
            <LucideGlyph name="rotate-ccw-clock" />
          </button>
        )}
        {cancelable && cancelState !== "confirming" && (
          <button
            className="acpus-cancel-button"
            type="button"
            disabled={cancelState === "canceling" || !connected}
            title={connected ? undefined : "连接恢复后可取消"}
            onClick={() => setCancelState("confirming")}
          >
            {cancelState === "canceling" ? "Canceling…" : "Cancel"}
          </button>
        )}
      </div>
      {unavailable !== undefined && (
        <div className="acpus-availability" role="status">
          <strong>{availabilityLabel(unavailable.reason)}</strong>
          <span className="acpus-availability-workspace" title={unavailable.workspace}>
            {unavailable.workspace}
          </span>
          <span>{unavailable.detail}</span>
        </div>
      )}
      {projection !== undefined && (
        <CollapsibleRegion expanded={historyOpen} className="acpus-history-reveal">
          <TaskHistory
            tasks={projection.tasks}
            selected={task.selector}
            {...(selection?.pending === undefined ? {} : { pending: selection.pending })}
            {...(selection?.error === undefined ? {} : { error: selection.error })}
            truncated={projection.tasksTruncated}
            interactive={connected}
            onSelect={async selector => {
              if (!connected) return;
              setCancelState("idle");
              if (await acpus.selectTask(sessionId, selector)) setHistoryOpen(false);
            }}
          />
        </CollapsibleRegion>
      )}
      <CollapsibleRegion
        expanded={cancelable && cancelState === "confirming"}
        className="acpus-cancel-reveal"
      >
        <div className="acpus-cancel-confirm" role="group" aria-label="确认取消 Acpus 任务">
          <span>取消这次 Acpus 任务？</span>
          <button type="button" onClick={() => void confirmCancel()}>确认取消</button>
          <button type="button" onClick={() => setCancelState("idle")}>返回</button>
        </div>
      </CollapsibleRegion>
      {cancelState === "failed" && cancelable && (
        <div className="acpus-cancel-error" role="status">
          <span>{connected ? "取消未生效，任务可能仍在运行" : "连接中断，无法确认取消结果"}</span>
          <button
            type="button"
            disabled={!connected}
            title={connected ? undefined : "连接恢复后可重试"}
            onClick={() => setCancelState("confirming")}
          >重试</button>
        </div>
      )}
      <CollapsibleRegion expanded={expanded} className="acpus-tray-reveal">
        <div className="acpus-tray-content">
          <div className="acpus-rail-tree">
            {task.tree.map((node, index) => (
              <ActivityTreeNode
                key={nodeKey(node, index)}
                node={node}
                acpus={acpus}
                sessionId={sessionId}
                generation={task.generation}
                revision={projection?.revision ?? 0}
                connected={connected && unavailable === undefined}
                visible={expanded}
                now={observedNow}
                uncertain={uncertain}
                onExpansionChange={() => refreshTree(value => value + 1)}
              />
            ))}
          </div>
        </div>
      </CollapsibleRegion>
    </section>
  );
}

function CollapsibleRegion({
  expanded,
  className,
  children,
}: {
  expanded: boolean;
  className: string;
  children: ReactNode;
}) {
  const regionRef = useCallback((element: HTMLDivElement | null) => {
    if (element !== null) element.inert = !expanded;
  }, [expanded]);
  return (
    <div
      ref={regionRef}
      className={`acpus-collapse ${className}${expanded ? " is-expanded" : ""}`}
      aria-hidden={!expanded}
    >
      <div className="acpus-collapse-body">{children}</div>
    </div>
  );
}

function TaskHistory({
  tasks,
  selected,
  pending,
  error,
  truncated,
  interactive,
  onSelect,
}: {
  tasks: DelegatedTaskSummary[];
  selected: ResolvedTaskSelector;
  pending?: ResolvedTaskSelector;
  error?: { task: ResolvedTaskSelector; reason: "task-unavailable" };
  truncated: boolean;
  interactive: boolean;
  onSelect(task: ResolvedTaskSelector): void | Promise<void>;
}) {
  const duplicates = new Map<string, number>();
  for (const task of tasks) duplicates.set(task.task.name, (duplicates.get(task.task.name) ?? 0) + 1);
  return (
    <div className="acpus-task-history" role="listbox" aria-label="Acpus 历史任务">
      {taskHistoryRows(tasks).map(({ summary, depth }) => {
        const active = sameTask(summary.task, selected);
        const loading = pending !== undefined && sameTask(summary.task, pending);
        return (
          <button
            type="button"
            role="option"
            aria-selected={active}
            disabled={loading || (!interactive && !active)}
            title={!interactive && !active ? "连接恢复后可查看" : undefined}
            className={`acpus-history-item${active ? " is-selected" : ""}${loading ? " is-pending" : ""}${depth > 0 ? " is-fork" : ""}`}
            style={depth === 0 ? undefined : { "--acpus-history-indent": `${7 + depth * 15}px` } as CSSProperties}
            key={`${summary.task.name}:${summary.task.occurrence}`}
            onClick={() => onSelect(summary.task)}
          >
            <ActivityStateIcon state={loading ? "running" : summaryTone(summary)} />
            <span className="acpus-history-name">
              {summary.task.name}
              {(duplicates.get(summary.task.name) ?? 0) > 1 || summary.task.occurrence > 1
                ? ` · ${summary.task.occurrence}`
                : ""}
            </span>
            {summary.forkedFrom && (
              <span className="acpus-history-fork">
                Fork of {summary.forkedFrom.name} · {summary.forkedFrom.occurrence}
              </span>
            )}
            <span className="acpus-history-status">
              {loading
                ? "Loading…"
                : summary.availability.status === "unavailable"
                  ? "unavailable"
                  : summary.status}
            </span>
          </button>
        );
      })}
      {error !== undefined && (
        <div className="acpus-history-error" role="status">
          <span>无法加载任务</span>
          <button type="button" disabled={!interactive} onClick={() => void onSelect(error.task)}>
            重试
          </button>
        </div>
      )}
      {truncated && <div className="acpus-history-truncated">仅显示最近 50 项</div>}
    </div>
  );
}

export function taskHistoryRows(
  tasks: DelegatedTaskSummary[],
): Array<{ summary: DelegatedTaskSummary; depth: number }> {
  const bySelector = new Map(tasks.map(task => [selectorKey(task.task), task]));
  const children = new Map<string, DelegatedTaskSummary[]>();
  const roots: DelegatedTaskSummary[] = [];
  const seenRoots = new Set<string>();

  for (const task of tasks) {
    const parent = task.forkedFrom === undefined
      ? undefined
      : bySelector.get(selectorKey(task.forkedFrom));
    if (parent !== undefined) {
      const key = selectorKey(parent.task);
      children.set(key, [...(children.get(key) ?? []), task]);
    }

    let root = task;
    let ancestor = parent;
    while (ancestor !== undefined) {
      root = ancestor;
      ancestor = root.forkedFrom === undefined
        ? undefined
        : bySelector.get(selectorKey(root.forkedFrom));
    }
    const rootKey = selectorKey(root.task);
    if (!seenRoots.has(rootKey)) {
      seenRoots.add(rootKey);
      roots.push(root);
    }
  }

  const rows: Array<{ summary: DelegatedTaskSummary; depth: number }> = [];
  const append = (summary: DelegatedTaskSummary, depth: number) => {
    rows.push({ summary, depth });
    for (const child of children.get(selectorKey(summary.task)) ?? []) append(child, depth + 1);
  };
  for (const root of roots) append(root, 0);
  return rows;
}

function selectorKey(selector: ResolvedTaskSelector): string {
  return JSON.stringify([selector.name, selector.occurrence]);
}

function sameTask(left: ResolvedTaskSelector, right: ResolvedTaskSelector): boolean {
  return left.name === right.name && left.occurrence === right.occurrence;
}

function ConnectionStatus({
  phase,
  connection,
}: {
  phase: SessionConnectionPhase;
  connection: SessionConnection | undefined;
}) {
  if (phase === "connected" || phase === "unknown" || connection === undefined) return null;
  const stale = phase === "stale";
  const label = stale ? "状态可能已过期" : "正在重连";
  const synchronizedAt = connection.synchronizedAt;
  const title = synchronizedAt === undefined
    ? label
    : `${label}；最后同步于 ${formatLocalTime(synchronizedAt)}`;
  return (
    <span
      className={`acpus-connection-status is-${phase}`}
      role="status"
      aria-live="polite"
      title={title}
    >
      {stale
        ? <span className="acpus-connection-warning" aria-hidden>!</span>
        : <ActivityStateIcon state="running" />}
      <span>{label}</span>
    </span>
  );
}

function summaryTone(summary: DelegatedTaskSummary): ActivityState {
  if (summary.availability.status === "unavailable") return "unavailable";
  const status = summary.status;
  if (status === "completed") return "completed";
  if (status === "failed") return "failed";
  if (status === "awaiting" || status === "paused") return "waiting";
  if (status === "canceled") return "canceled";
  return "running";
}

export function AcpusInternalToolView(): null {
  return null;
}

function availabilitySummary(
  availability: Extract<AcpusTaskAvailability, { status: "unavailable" }>,
): { title: string; tone: ActivityState; agent?: string } {
  return {
    title: availabilityLabel(availability.reason),
    tone: "unavailable",
  };
}

function availabilityLabel(
  reason: Extract<AcpusTaskAvailability, { status: "unavailable" }>["reason"],
): string {
  if (reason === "workspace-unavailable") return "工作目录不可用";
  if (reason === "runtime-authority-busy") return "运行时正被其他实例占用";
  if (reason === "runtime-store-unsupported") return "运行时存储版本不受支持";
  if (reason === "runtime-configuration-invalid") return "运行时配置无效";
  return "运行时不可用";
}

export function activitySummary(
  task: DelegatedTaskActivity,
): {
  title: string;
  tone: ActivityState;
  agent?: string;
} {
  if (task.status === "completed") {
    return { title: "任务执行完成", tone: "completed" };
  }
  if (task.status === "failed") {
    return { title: "任务执行失败", tone: "failed" };
  }
  if (task.status === "canceled") {
    return { title: "任务已取消", tone: "canceled" };
  }
  if (task.status === "paused") {
    return { title: "任务已暂停", tone: "waiting" };
  }
  const current = currentWorkNodes(task.tree);
  const awaiting = current.find(node => node.status === "awaiting");
  if (awaiting !== undefined) {
    return {
      title: `等待你的输入 · ${awaiting.label}`,
      tone: "signal",
      ...(awaiting.agent?.name ? { agent: awaiting.agent.name } : {}),
    };
  }
  if (current.length > 1) {
    return {
      title: `${current.length} 个节点并行执行中`,
      tone: "running",
    };
  }
  const node = current[0];
  if (node !== undefined) {
    return {
      title: `正在执行 · ${node.label}`,
      tone: "running",
    };
  }
  return { title: "正在准备任务", tone: "running" };
}

function ActivityTreeNode({
  node,
  acpus,
  sessionId,
  generation,
  revision,
  connected,
  visible,
  now,
  uncertain,
  onExpansionChange,
}: {
  node: ActivityNode;
  acpus: AcpusClientState;
  sessionId: string;
  generation: number;
  revision: number;
  connected: boolean;
  visible: boolean;
  now: number;
  uncertain: boolean;
  onExpansionChange(): void;
}) {
  const scope = scopeClass(node.kind);
  const leaf = executableLeaf(node);
  const active = activeNodeStatus(node.status);
  const occurrence = occurrenceLabel(node);
  const label = occurrence ?? node.label;
  const detail = occurrence === undefined ? nodeDetail(node) : undefined;
  const activity = agentActivityView(node.agent, node.status);
  const telemetry = agentTelemetryView(node.agent?.telemetry, node.status);
  const expandable = node.children.length > 0;
  const expanded = !expandable || acpus.nodeExpanded(
    sessionId,
    generation,
    node.activityId,
  );
  const toggle = () => {
    if (!expandable) return;
    acpus.setNodeExpanded(sessionId, generation, node.activityId, !expanded);
    onExpansionChange();
  };
  return (
    <div className={`acpus-rail-node ${scope ?? ""} ${leaf ? "is-leaf" : ""} ${active && leaf ? "is-active" : ""}`}>
      <ActivityHoverAnchor
        enabled={visible && hoverEligible(node)}
        acpus={acpus}
        sessionId={sessionId}
        generation={generation}
        revision={revision}
        connected={connected}
        node={node}
        now={now}
        uncertain={uncertain}
      >
      <div
        className={`acpus-rail-line${expandable ? " is-expandable" : ""}`}
        role={expandable ? "button" : undefined}
        tabIndex={expandable ? 0 : undefined}
        aria-expanded={expandable ? expanded : undefined}
        onClick={toggle}
        onKeyDown={event => {
          if (expandable && (event.key === "Enter" || event.key === " ")) {
            event.preventDefault();
            toggle();
          }
        }}
      >
        <NodeIcon node={node} />
        {occurrence === undefined ? (
          <>
            <span className="acpus-rail-title" title={label}>{label}</span>
            {detail && <span className={`acpus-rail-tag is-${node.kind}`}>{detail}</span>}
          </>
        ) : (
          <span
            className={`acpus-rail-occurrence is-${node.kind}`}
            title={occurrence}
          >
            {occurrence}
          </span>
        )}
        {node.progress && (
          <span className="acpus-rail-progress">
            {node.progress.completed}/{node.progress.total}
          </span>
        )}
        {activity && <AgentActivityStatus activity={activity} showIcon={false} />}
        {telemetry && <AgentTelemetry telemetry={telemetry} />}
        <span className="acpus-node-time" aria-hidden>
          {displayDuration(node, now, uncertain)}
        </span>
        {leaf && <LeafStatusIcon status={node.status} />}
        {expandable && <span className="acpus-node-chevron"><Chevron expanded={expanded} /></span>}
      </div>
      </ActivityHoverAnchor>
      {expandable && (
        <CollapsibleRegion expanded={expanded} className="acpus-rail-reveal">
          <div className="acpus-rail-children">
            {node.children.map((child, index) => (
              <ActivityTreeNode
                key={nodeKey(child, index)}
                node={child}
                acpus={acpus}
                sessionId={sessionId}
                generation={generation}
                revision={revision}
                connected={connected}
                visible={visible && expanded}
                now={now}
                uncertain={uncertain}
                onExpansionChange={onExpansionChange}
              />
            ))}
          </div>
        </CollapsibleRegion>
      )}
    </div>
  );
}

function ActivityHoverAnchor({
  enabled,
  acpus,
  sessionId,
  generation,
  revision,
  connected,
  node,
  now,
  uncertain,
  children,
}: {
  enabled: boolean;
  acpus: AcpusClientState;
  sessionId: string;
  generation: number;
  revision: number;
  connected: boolean;
  node: ActivityNode;
  now: number;
  uncertain: boolean;
  children: ReactNode;
}) {
  const anchor = useRef<HTMLDivElement>(null);
  const cardElement = useRef<HTMLElement>(null);
  const openTimer = useRef<ReturnType<typeof setTimeout>>();
  const closeTimer = useRef<ReturnType<typeof setTimeout>>();
  const hovering = useRef(false);
  const current = useRef({
    sessionId,
    generation,
    activityId: node.activityId,
    revision,
    connected,
    enabled,
    terminal: terminalNodeStatus(node.status),
  });
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<ActivityHoverDetail | undefined>(() =>
    acpus.cachedActivityDetail(sessionId, generation, node.activityId, revision));
  const [position, setPosition] = useState({ left: 12, top: 12 });
  const terminal = terminalNodeStatus(node.status);
  current.current = {
    sessionId,
    generation,
    activityId: node.activityId,
    revision,
    connected,
    enabled,
    terminal,
  };

  useEffect(() => () => {
    clearTimeout(openTimer.current);
    clearTimeout(closeTimer.current);
  }, []);

  useEffect(() => {
    hovering.current = false;
    clearTimeout(openTimer.current);
    clearTimeout(closeTimer.current);
    setOpen(false);
    setDetail(undefined);
  }, [generation, node.activityId, sessionId]);

  useEffect(() => {
    if (enabled) return;
    hovering.current = false;
    clearTimeout(openTimer.current);
    clearTimeout(closeTimer.current);
    setOpen(false);
  }, [enabled]);

  useEffect(() => {
    if (!open || !enabled || !connected) return;
    let active = true;
    void acpus.readActivityDetail(
      sessionId,
      generation,
      node.activityId,
      revision,
      terminal,
    ).then(value => {
      if (active && value !== undefined) setDetail(value);
    });
    return () => { active = false; };
  }, [acpus, connected, enabled, generation, node.activityId, open, revision, sessionId, terminal]);

  useBrowserLayoutEffect(() => {
    if (!open || detail === undefined || !enabled || typeof window === "undefined") return;
    const place = () => {
      const anchorRect = anchor.current?.getBoundingClientRect();
      const cardRect = cardElement.current?.getBoundingClientRect();
      if (anchorRect === undefined || cardRect === undefined) return;
      const next = hoverPosition(
        anchorRect,
        { width: cardRect.width, height: cardRect.height },
        { width: window.innerWidth, height: window.innerHeight },
      );
      setPosition(current => current.left === next.left && current.top === next.top ? current : next);
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [detail, enabled, open]);

  async function openWhenReady(): Promise<void> {
    const requested = current.current;
    if (!hovering.current || !requested.enabled) return;
    let value = acpus.cachedActivityDetail(
      requested.sessionId,
      requested.generation,
      requested.activityId,
      requested.revision,
    );
    if (value === undefined && requested.connected) {
      value = await acpus.readActivityDetail(
        requested.sessionId,
        requested.generation,
        requested.activityId,
        requested.revision,
        requested.terminal,
      );
    }
    if (!hovering.current || value === undefined) return;
    const latest = current.current;
    if (latest.sessionId !== requested.sessionId
      || latest.generation !== requested.generation
      || latest.activityId !== requested.activityId
      || latest.revision !== requested.revision) {
      await openWhenReady();
      return;
    }
    setDetail(value);
    setOpen(true);
  }

  const scheduleOpen = () => {
    clearTimeout(closeTimer.current);
    if (!enabled) return;
    hovering.current = true;
    clearTimeout(openTimer.current);
    openTimer.current = setTimeout(() => void openWhenReady(), ACTIVITY_HOVER_DELAY_MS);
  };
  const scheduleClose = () => {
    hovering.current = false;
    clearTimeout(openTimer.current);
    closeTimer.current = setTimeout(() => setOpen(false), 140);
  };
  const keepOpen = () => {
    hovering.current = true;
    clearTimeout(closeTimer.current);
  };
  const card = open && detail !== undefined && enabled && typeof document !== "undefined"
    ? createPortal(
        <aside
          ref={cardElement}
          className="acpus-activity-hover-card"
          style={{ left: position.left, top: position.top }}
          onMouseEnter={keepOpen}
          onMouseLeave={scheduleClose}
          aria-label={`${node.kind === "agent" ? "Agent" : "Task"} ${node.agent?.name ?? node.label} details`}
        >
          <ActivityHoverContent
            detail={detail}
            connected={connected}
            node={node}
            now={now}
            uncertain={uncertain}
          />
        </aside>,
        document.body,
      )
    : null;
  return (
    <div
      ref={anchor}
      className="acpus-hover-anchor"
      onMouseEnter={scheduleOpen}
      onMouseLeave={scheduleClose}
    >
      {children}
      {card}
    </div>
  );
}

function ActivityHoverContent({
  detail,
  connected,
  node,
  now,
  uncertain,
}: {
  detail: ActivityHoverDetail;
  connected: boolean;
  node: ActivityNode;
  now: number;
  uncertain: boolean;
}) {
  if (detail.kind === "task") {
    return (
      <>
        <header className="acpus-hover-header">
          <div className="acpus-hover-identity">
            <NodeIcon node={node} />
            <strong>{node.label}</strong>
          </div>
          <div className="acpus-hover-header-facts">
            <span className={`acpus-hover-task-status is-${node.status}`}>{taskStatusLabel(node.status)}</span>
            <span className="acpus-hover-task-duration" aria-hidden>{displayDuration(node, now, uncertain)}</span>
            {!connected && <span className="acpus-hover-stale">stale</span>}
          </div>
        </header>
        <HoverTextSection
          title="Input"
          text={detail.input.text}
          truncated={detail.input.truncated}
        />
        {detail.result && <HoverResultView result={detail.result} />}
      </>
    );
  }
  const activity = agentActivityView(node.agent, node.status);
  const telemetry = agentTelemetryView(node.agent?.telemetry, node.status);
  return (
    <>
      <header className="acpus-hover-header">
        <div className="acpus-hover-identity">
          <AgentIdentity name={detail.agent} />
          <strong>{detail.agent}</strong>
          {detail.model && <code>{detail.model}</code>}
        </div>
        <div className="acpus-hover-header-facts">
          {telemetry && <AgentTelemetry telemetry={telemetry} />}
          {!connected && <span className="acpus-hover-stale">stale</span>}
        </div>
      </header>
      {!terminalNodeStatus(node.status) && activity && (
        <div className="acpus-hover-runtime">
          <AgentActivityStatus activity={activity} />
        </div>
      )}
      {detail.prompt && (
        <HoverTextSection
          title="Prompt"
          text={detail.prompt.text}
          truncated={detail.prompt.truncated}
        />
      )}
      {detail.result && <HoverResultView result={detail.result} />}
    </>
  );
}

function HoverResultView({ result }: { result: HoverResult }) {
  if (result.kind === "output") {
    return <HoverTextSection title="Output" text={result.text} truncated={result.truncated} />;
  }
  const label = result.kind === "completed-without-output"
    ? "Completed without output"
    : result.kind === "timed-out"
      ? "Timed out"
      : result.kind === "failed"
        ? "Failed"
        : "Canceled";
  const message = "message" in result ? result.message : undefined;
  return (
    <section className={`acpus-hover-result is-${result.kind}`}>
      <strong>{label}</strong>
      {message && <p>{message}</p>}
    </section>
  );
}

export function hoverEligible(node: ActivityNode): boolean {
  if (node.kind === "agent") return true;
  return node.kind === "task"
    && !["not_started", "not_selected", "pending", "ready"].includes(node.status);
}

function taskStatusLabel(status: ActivityNodeStatus): string {
  switch (status) {
    case "starting": return "Starting";
    case "running": return "Running";
    case "completed": return "Completed";
    case "failed": return "Failed";
    case "timed_out": return "Timed out";
    case "cancelled": return "Canceled";
    default: return "Pending";
  }
}

function HoverTextSection({ title, text, truncated }: { title: string; text: string; truncated: boolean }) {
  return (
    <section className="acpus-hover-section">
      <div className="acpus-hover-section-title">
        <span className="acpus-hover-section-label">{title}</span>
        {truncated && <span className="acpus-hover-truncated">truncated</span>}
      </div>
      <pre>{text}</pre>
    </section>
  );
}

export function hoverPosition(
  rect: Pick<DOMRect, "left" | "right" | "top">,
  card: { width: number; height: number },
  viewport: { width: number; height: number },
): { left: number; top: number } {
  const margin = 12;
  const gap = 8;
  const right = rect.right + gap;
  const left = right + card.width <= viewport.width - margin
    ? right
    : Math.max(margin, rect.left - gap - card.width);
  return {
    left,
    top: Math.max(margin, Math.min(rect.top, viewport.height - margin - card.height)),
  };
}

export function NodeIcon({ node }: { node: ActivityNode }) {
  if (node.kind === "agent") {
    const icon = agentIcon(node.agent?.name);
    return (
      <>
        <span className="acpus-node-icon is-agent" role="img" aria-label={`Agent: ${icon.name}`} title={icon.name}>
          <img src={icon.source} alt="" />
        </span>
        {!icon.known && <span className="acpus-agent-fallback-name">{icon.name}</span>}
      </>
    );
  }
  const icon = nodeIcon(node.kind);
  return icon === undefined
    ? null
    : <span className={`acpus-node-icon is-${icon.tone}`} aria-hidden>{icon.body}</span>;
}

function AgentIdentity({ name }: { name: string }) {
  const icon = agentIcon(name);
  return (
    <span className={`acpus-agent-identity ${icon.known ? "is-icon-only" : ""}`} role="img" aria-label={`Agent: ${icon.name}`} title={icon.name}>
      <img src={icon.source} alt="" />
      {!icon.known && <span>{icon.name}</span>}
    </span>
  );
}

type ActivityState = "running" | "completed" | "failed" | "waiting" | "signal" | "neutral" | "canceled" | "unavailable";

type AgentActivityPresentation = {
  kind: "tool" | "phase";
  state: "running" | "completed" | "failed" | "canceled";
  text: string;
  label: string;
};

export function agentActivityView(
  agent: AgentActivity | undefined,
  status: ActivityNodeStatus,
): AgentActivityPresentation | undefined {
  const tool = agent?.tool;
  const toolText = toolActivityText(tool);
  if (tool?.state === "running" && toolText !== undefined) {
    return {
      kind: "tool",
      state: "running",
      text: toolText,
      label: `正在调用工具 ${toolText}`,
    };
  }
  if (activeNodeStatus(status)) {
    const phase = phaseLabel(agent?.phase);
    if (phase !== undefined) {
      return { kind: "phase", state: "running", text: phase, label: phase };
    }
    if (agent?.phase === "output-repair" || agent?.phase === "settling" || agent?.phase === "settled") return undefined;
    if (tool !== undefined || agent?.phase === "tool") {
      return { kind: "phase", state: "running", text: "Working", label: "Agent is working" };
    }
    return undefined;
  }
  if (tool === undefined || tool.state === "running" || toolText === undefined) return undefined;
  return {
    kind: "tool",
    state: tool.state,
    text: toolText,
    label: `最近工具 ${toolText}，${toolStateLabel(tool.state)}`,
  };
}

function toolActivityText(tool: AgentActivity["tool"]): string | undefined {
  if (tool === undefined) return undefined;
  const name = genericToolActivity(tool.name) ? undefined : tool.name.trim();
  const title = tool.title === undefined || genericToolActivity(tool.title)
    ? undefined
    : tool.title.trim();
  if (name && title) return `${name} · ${title}`;
  return name || title;
}

function genericToolActivity(value: string): boolean {
  return ["tool", "tool call", "unknown tool"].includes(value.trim().toLowerCase());
}

function AgentActivityStatus({
  activity,
  showIcon = true,
}: {
  activity: AgentActivityPresentation;
  showIcon?: boolean;
}) {
  return (
    <span className={`acpus-agent-activity is-${activity.kind} is-${activity.state}`} role="status" aria-label={activity.label} title={activity.label}>
      {showIcon && <ActivityStateIcon state={activity.state} />}
      {activity.kind === "tool" ? <code>{activity.text}</code> : <span>{activity.text}</span>}
    </span>
  );
}

type TelemetryPresentation = { text: string; title: string; label: string };

export function agentTelemetryView(
  telemetry: AgentActivity["telemetry"],
  status: ActivityNodeStatus,
): TelemetryPresentation | undefined {
  if (telemetry === undefined) return undefined;
  const visible: string[] = [];
  const exact: string[] = [];
  if (telemetry.inputTokens !== undefined) {
    visible.push(`↑${formatCompactNumber(telemetry.inputTokens)}`);
    exact.push(`输入 ${formatExactNumber(telemetry.inputTokens)} tokens`);
  }
  if (telemetry.outputTokens !== undefined) {
    visible.push(`↓${formatCompactNumber(telemetry.outputTokens)}`);
    exact.push(`输出 ${formatExactNumber(telemetry.outputTokens)} tokens`);
  }
  if (telemetry.inputTokens === undefined
    && telemetry.outputTokens === undefined
    && telemetry.totalTokens !== undefined) {
    visible.push(`${formatCompactNumber(telemetry.totalTokens)} tok`);
    exact.push(`总计 ${formatExactNumber(telemetry.totalTokens)} tokens`);
  }
  const context = activeNodeStatus(status) ? telemetry.contextWindow : undefined;
  if (context !== undefined && context.used > 0 && context.size > 0) {
    const percent = Math.round((context.used / context.size) * 100);
    visible.push(`${percent}% ctx`);
    exact.push(`Context ${formatExactNumber(context.used)} / ${formatExactNumber(context.size)}（${percent}%）`);
  }
  if (visible.length === 0) return undefined;
  const title = `当前或最近一次 Agent turn：${exact.join("；")}`;
  return { text: visible.join(" · "), title, label: title };
}

function AgentTelemetry({ telemetry }: { telemetry: TelemetryPresentation }) {
  return (
    <span className="acpus-agent-telemetry" aria-label={telemetry.label} title={telemetry.title}>
      {telemetry.text}
    </span>
  );
}

export function ActivityStateIcon({ state }: { state: ActivityState }) {
  if (["completed", "failed", "waiting", "canceled", "unavailable"].includes(state)) {
    const icon = state === "completed"
      ? "circle-check"
      : state === "failed"
        ? "circle-x"
        : state === "waiting" || state === "unavailable"
          ? "circle-ellipsis"
          : "ban";
    return (
      <span className={`acpus-activity-state is-${state}`} aria-hidden>
        <LucideGlyph name={icon} />
      </span>
    );
  }
  if (state === "signal") {
    return <RadioIcon animated className="acpus-activity-state is-signal" />;
  }
  return <span className={`acpus-activity-state is-${state}`} aria-hidden />;
}

function RadioIcon({
  animated = false,
  className,
}: {
  animated?: boolean;
  className?: string;
}) {
  return (
    <svg
      className={`${className === undefined ? "" : `${className} `}acpus-radio-icon${animated ? " is-animated" : ""}`}
      data-acpus-radio={animated ? "animated" : "static"}
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden
    >
      <circle className="acpus-radio-center" cx="8" cy="8" r="1.35" fill="currentColor" />
      <path className="acpus-radio-wave is-inner" d="M5.7 5.7a3.25 3.25 0 0 0 0 4.6M10.3 5.7a3.25 3.25 0 0 1 0 4.6" />
      <path className="acpus-radio-wave is-outer" d="M3.7 3.7a6.1 6.1 0 0 0 0 8.6M12.3 3.7a6.1 6.1 0 0 1 0 8.6" />
    </svg>
  );
}

export function LeafStatusIcon({ status }: { status: ActivityNodeStatus }) {
  const presentation = leafStatusPresentation(status);
  if (presentation === undefined) return null;
  return (
    <span
      className={`acpus-leaf-status is-${presentation.tone}`}
      role="img"
      aria-label={presentation.label}
      title={presentation.label}
    >
      <LucideGlyph name={presentation.icon} />
    </span>
  );
}

function Chevron({ expanded }: { expanded: boolean }) {
  return (
    <svg className={chevronClass(expanded)} viewBox="0 0 16 16" aria-hidden>
      <path d="m3.5 6 4.5 4 4.5-4" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" />
    </svg>
  );
}

export function chevronClass(expanded: boolean): string {
  return `acpus-chevron${expanded ? "" : " is-collapsed"}`;
}

function nodeIcon(kind: string): { tone: string; body: ReactNode } | undefined {
  const common = { viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: 1.35 };
  if (kind === "task") return { tone: "task", body: <LucideGlyph name="terminal" /> };
  if (kind === "signal") return { tone: "signal", body: <RadioIcon /> };
  if (kind === "assert") return { tone: "assert", body: <svg {...common}><path d="m8 1.8 5 2v3.7c0 3.2-2 5.5-5 6.7-3-1.2-5-3.5-5-6.7V3.8l5-2Z" /><path d="m5.5 7.8 1.6 1.6 3.4-3.5" /></svg> };
  if (kind === "if") return { tone: "condition", body: <LucideGlyph name="git-branch" /> };
  if (kind === "switch") return { tone: "condition", body: <LucideGlyph name="list-indent-increase" /> };
  if (kind === "parallel") return { tone: "parallel", body: <LucideGlyph name="git-fork" /> };
  if (kind === "fanout") return { tone: "fanout", body: <LucideGlyph name="square-stack" /> };
  if (kind === "loop") return { tone: "loop", body: <svg {...common}><path d="M13 6A5.2 5.2 0 0 0 3.5 4.5L2 6M3 10a5.2 5.2 0 0 0 9.5 1.5L14 10" /><path d="M2 2.8V6h3.2M14 13.2V10h-3.2" /></svg> };
  if (["branch", "fanout_item", "loop_iteration"].includes(kind)) return undefined;
  return { tone: "generic", body: <svg {...common}><circle cx="8" cy="8" r="4.8" /></svg> };
}

type LucideGlyphName =
  | "ban"
  | "circle-check"
  | "circle-ellipsis"
  | "circle-x"
  | "git-branch"
  | "git-fork"
  | "list-indent-increase"
  | "loader-circle"
  | "rotate-ccw-clock"
  | "square-stack"
  | "terminal";

function LucideGlyph({ name }: { name: LucideGlyphName }) {
  const common = {
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "data-acpus-icon": name,
    "aria-hidden": true,
  };
  if (name === "terminal") return <svg {...common}><polyline points="4 17 10 11 4 5" /><line x1="12" x2="20" y1="19" y2="19" /></svg>;
  if (name === "rotate-ccw-clock") return <svg {...common}><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" /><path d="M3 3v5h5" /><path d="M12 7v5l4 2" /></svg>;
  if (name === "square-stack") return <svg {...common}><path d="M4 10c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h4c1.1 0 2 .9 2 2" /><path d="M10 16c-1.1 0-2-.9-2-2v-4c0-1.1.9-2 2-2h4c1.1 0 2 .9 2 2" /><rect width="8" height="8" x="14" y="14" rx="2" /></svg>;
  if (name === "git-fork") return <svg {...common}><circle cx="12" cy="18" r="3" /><circle cx="6" cy="6" r="3" /><circle cx="18" cy="6" r="3" /><path d="M18 9v2c0 .6-.4 1-1 1H7c-.6 0-1-.4-1-1V9" /><path d="M12 12v3" /></svg>;
  if (name === "git-branch") return <svg {...common}><line x1="6" x2="6" y1="3" y2="15" /><circle cx="18" cy="6" r="3" /><circle cx="6" cy="18" r="3" /><path d="M18 9a9 9 0 0 1-9 9" /></svg>;
  if (name === "list-indent-increase") return <svg {...common}><path d="M21 12H11" /><path d="M21 18H11" /><path d="M21 6H11" /><path d="m3 8 4 4-4 4" /></svg>;
  if (name === "loader-circle") return <svg {...common}><path d="M21 12a9 9 0 1 1-6.219-8.56" /></svg>;
  if (name === "circle-check") return <svg {...common}><circle cx="12" cy="12" r="10" /><path d="m9 12 2 2 4-4" /></svg>;
  if (name === "circle-x") return <svg {...common}><circle cx="12" cy="12" r="10" /><path d="m15 9-6 6" /><path d="m9 9 6 6" /></svg>;
  if (name === "circle-ellipsis") return <svg {...common}><circle cx="12" cy="12" r="10" /><path d="M17 12h.01" /><path d="M12 12h.01" /><path d="M7 12h.01" /></svg>;
  return <svg {...common}><circle cx="12" cy="12" r="10" /><path d="m4.9 4.9 14.2 14.2" /></svg>;
}

function leafStatusPresentation(status: ActivityNodeStatus): {
  icon: LucideGlyphName;
  label: string;
  tone: "running" | "completed" | "failed" | "waiting" | "canceled";
} | undefined {
  if (status === "completed") return { icon: "circle-check", label: "已完成", tone: "completed" };
  if (status === "failed" || status === "timed_out") return { icon: "circle-x", label: status === "timed_out" ? "已超时" : "失败", tone: "failed" };
  if (status === "cancelled") return { icon: "ban", label: "已取消", tone: "canceled" };
  if (status === "awaiting") return { icon: "circle-ellipsis", label: "等待输入", tone: "waiting" };
  if (activeNodeStatus(status)) return { icon: "loader-circle", label: "运行中", tone: "running" };
  return undefined;
}

export function occurrenceLabel(node: ActivityNode): string | undefined {
  if (node.kind === "branch") return `Branch · ${node.label}`;
  if (node.kind === "fanout_item") {
    const index = /^item\[(\d+)]$/.exec(node.label)?.[1];
    return `Fanout Item · ${index ?? node.label}`;
  }
  if (node.kind === "loop_iteration") {
    const round = /^round (\d+)$/.exec(node.label)?.[1];
    return `Loop Round · ${round ?? node.label}`;
  }
  return undefined;
}

export function nodeDetail(node: ActivityNode): string | undefined {
  if (node.kind === "branch") return "Branch";
  if (node.kind === "fanout_item") return "Fanout item";
  if (node.kind === "loop_iteration") return "Loop round";
  if (node.kind === "if") return "If";
  if (node.kind === "switch") return "Switch";
  if (node.kind === "parallel") return "Parallel";
  if (node.kind === "fanout") return "Fanout";
  if (node.kind === "loop") return "Loop";
  return undefined;
}

function scopeClass(kind: string): string | undefined {
  if (kind === "if" || kind === "switch") return "is-scope is-condition";
  if (kind === "parallel") return "is-scope is-parallel";
  if (kind === "fanout") return "is-scope is-fanout";
  if (kind === "loop") return "is-scope is-loop";
  if (["branch", "fanout_item", "loop_iteration"].includes(kind)) return "is-occurrence";
  return undefined;
}

function executableLeaf(node: ActivityNode): boolean {
  return ["agent", "task", "signal", "assert"].includes(node.kind);
}

function currentWorkNodes(nodes: readonly ActivityNode[]): ActivityNode[] {
  return nodes.flatMap(node => {
    const children = currentWorkNodes(node.children);
    if (children.length > 0) return children;
    return activeNodeStatus(node.status) ? [node] : [];
  });
}

function activeNodeStatus(status: ActivityNodeStatus): boolean {
  return status === "pending"
    || status === "starting"
    || status === "ready"
    || status === "running"
    || status === "awaiting"
    || status === "mixed";
}

function terminalTask(status: DelegatedTaskActivity["status"]): boolean {
  return status === "completed" || status === "failed" || status === "canceled";
}

function nodeDuration(node: ActivityNode, now: number): number {
  if (node.durationMs !== undefined) return node.durationMs;
  if (node.startedAt !== undefined) return Math.max(0, now - Date.parse(node.startedAt));
  return Math.max(0, ...node.children.map(child => nodeDuration(child, now)));
}

function displayDuration(node: ActivityNode, now: number, uncertain: boolean): string {
  if (node.durationMs === undefined
    && node.startedAt === undefined
    && node.children.length === 0) return "—";
  return formatObservedDuration(
    nodeDuration(node, now),
    uncertain && activeNodeStatus(node.status),
  );
}

export function taskDuration(task: DelegatedTaskActivity, now: number): number {
  const end = task.finishedAt === undefined ? now : Date.parse(task.finishedAt);
  return Math.max(0, end - Date.parse(task.startedAt));
}

export function formatDuration(durationMs: number): string {
  const seconds = Math.max(0, Math.floor(durationMs / 1_000));
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
}

export function formatObservedDuration(durationMs: number, uncertain: boolean): string {
  return `${formatDuration(durationMs)}${uncertain ? "+" : ""}`;
}

function formatLocalTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function toolStateLabel(state: "completed" | "failed" | "canceled"): string {
  if (state === "completed") return "已完成";
  if (state === "failed") return "失败";
  return "已取消";
}

function phaseLabel(phase: AgentActivity["phase"]): string | undefined {
  if (phase === "starting") return "Starting";
  if (phase === "responding") return "Responding";
  if (phase === "reported-thought") return "Thinking";
  if (phase === "planning") return "Planning";
  return undefined;
}

function formatCompactNumber(value: number): string {
  const absolute = Math.abs(value);
  if (absolute < 1_000) return String(value);
  const divisor = absolute < 1_000_000 ? 1_000 : 1_000_000;
  const suffix = divisor === 1_000 ? "k" : "m";
  const compact = value / divisor;
  return `${Number.isInteger(compact) ? compact : compact.toFixed(1).replace(/\.0$/u, "")}${suffix}`;
}

function formatExactNumber(value: number): string {
  return value.toLocaleString("en-US", { maximumFractionDigits: 0 });
}

function nodeKey(node: ActivityNode, index: number): string {
  return node.activityId || `${node.kind}:${node.label}:${index}`;
}

function terminalNodeStatus(status: ActivityNodeStatus): boolean {
  return status === "completed"
    || status === "failed"
    || status === "timed_out"
    || status === "cancelled";
}

function useClock(enabled: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    if (!enabled) return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [enabled]);
  return now;
}
