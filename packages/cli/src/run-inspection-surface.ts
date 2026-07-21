import { stripVTControlCharacters } from "node:util";
import type { SchemaIR } from "@acpus/core/ir";
import type {
  RunInspectionChange,
  RunInspectionAction,
  RunInspectionDocument,
  RunInspectionEmission,
  RunInspectionItem,
  RunInspectionRunSummary,
  RunInspectionSnapshot,
  RunInspectionStatus,
  RunInspectionStatusCounts,
  RunInspectionTargetDocument,
} from "@acpus/runtime";
import { terminalTreeChildPrefix, terminalTreeConnector, type TerminalTreeEdge } from "./terminal-tree.js";

type RunInspectionUpdate = Extract<RunInspectionEmission, { kind: "update" }>;
type FollowableInspectionDocument = RunInspectionSnapshot | RunInspectionTargetDocument;
type AgentInspectionState = NonNullable<RunInspectionItem["agent"]>;
type RecentTool = NonNullable<AgentInspectionState["tools"]>["recent"][number];

export function formatRunInspectionDocument(document: RunInspectionDocument, nowMs = Date.now()): string {
  if (document.kind === "raw") return "Raw run inspection is available only as JSON.\n";
  if (document.kind === "target") return formatTarget(document, nowMs);
  return formatSnapshot(document, nowMs);
}

export function formatRunInspectionHeader(run: RunInspectionRunSummary, nowMs = Date.now()): string {
  return `${formatHeader(run, nowMs)}\n`;
}

export function formatRunInspectionChanges(
  changes: readonly RunInspectionChange[],
  context: {
    run: RunInspectionRunSummary;
    items: readonly RunInspectionItem[];
    actions?: readonly RunInspectionAction[];
    nowMs?: number;
  },
): string {
  const nowMs = context.nowMs ?? Date.now();
  const items = new Map(context.items.map(item => [item.key, item]));
  const actions = indexActions(context.actions ?? []);
  const visible = changes.filter(change => !(change.entity.kind === "run" && ["completed", "failed", "cancelled"].includes(change.action)));
  const lines: string[] = [];
  let runLevelRecoveryTransition = false;
  for (const change of visible) {
    const item = change.itemKey ? items.get(change.itemKey) : undefined;
    const elapsed = elapsedSince(context.run.createdAt, change.at);
    const subject = change.subject || item?.label || change.entity.nodeId || change.entity.id;
    const state = changeState(change);
    const attempt = change.attemptNo === undefined ? "" : `  attempt=${change.attemptNo}`;
    const failure = item?.failure && (change.action === "failed" || change.action === "timed_out")
      ? `  ${formatFailure(item.failure, 160)}`
      : "";
    const message = failure || (change.message ? `  ${oneLine(change.message, 160)}` : "");
    const agent = item?.agent ? `  ${formatAgentProgress(item.agent, nowMs)}` : "";
    lines.push(`+${elapsed}  ${subject}  ${state}${attempt}${agent}${message}`);
    const actionable = change.action === "awaiting" || change.action === "failed" || change.action === "timed_out";
    if (item && actionable) {
      runLevelRecoveryTransition ||= (actions.byItem.get(item.key) ?? []).some(action => action.kind === "retry");
      lines.push(...formatActionCommands(item, actions, context.run.id).map(line => `  ${line}`));
    }
  }
  if (runLevelRecoveryTransition) lines.push(...formatRunLevelActionCommands(actions, context.run.id).map(line => `  ${line}`));
  return lines.join("\n") + (lines.length > 0 ? "\n" : "");
}

export function formatRunInspectionCheckpoint(document: FollowableInspectionDocument, nowMs = Date.now()): string {
  const elapsed = elapsedSince(document.run.createdAt, new Date(nowMs).toISOString());
  if (document.kind === "target") {
    const current = currentTargetItem(document);
    const agent = current?.agent ?? document.summary.agent;
    const details = agent ? `\n  ${current?.label ?? document.target.id}  ${formatAgentPulse(agent, nowMs)}` : "";
    return `· checkpoint +${elapsed}  ${document.run.status}${details}\n`;
  }

  const counts = formatCounts(document.counts);
  const candidates = actionableItems(document.items);
  const shown = candidates.slice(0, 3);
  const lines = [`· checkpoint +${elapsed}  ${document.run.status}${counts ? `  ${counts}` : ""}`];
  for (const item of shown) {
    const detail = item.agent ? formatAgentPulse(item.agent, nowMs) : displayStatus(item.status);
    lines.push(`  ${item.label}  ${detail}`);
  }
  if (candidates.length > shown.length) lines.push(`  … ${candidates.length - shown.length} more actionable`);
  return `${lines.join("\n")}\n`;
}

export function applyRunInspectionUpdate(
  document: FollowableInspectionDocument,
  update: RunInspectionUpdate,
): FollowableInspectionDocument {
  const removed = new Set(update.patch.removeItemKeys);
  const replacements = new Map(update.patch.upsertItems.map(item => [item.key, item]));
  const items = document.items
    .filter(item => !removed.has(item.key))
    .map(item => replacements.get(item.key) ?? item);
  const existing = new Set(items.map(item => item.key));
  for (const item of update.patch.upsertItems) if (!existing.has(item.key)) items.push(item);
  if (update.patch.itemOrder) {
    const order = new Map(update.patch.itemOrder.map((key, index) => [key, index]));
    items.sort((left, right) => (order.get(left.key) ?? Number.MAX_SAFE_INTEGER) - (order.get(right.key) ?? Number.MAX_SAFE_INTEGER));
  }
  if (document.kind === "target") {
    return { ...document, cursor: update.cursor, run: update.run, items };
  }
  const { omitted: _omitted, hooks: _hooks, ...base } = document;
  return {
    ...base,
    cursor: update.cursor,
    run: update.run,
    counts: update.patch.counts ?? document.counts,
    actions: update.patch.actions ?? document.actions,
    items,
    ...(update.patch.omitted === undefined ? document.omitted ? { omitted: document.omitted } : {} : update.patch.omitted ? { omitted: update.patch.omitted } : {}),
    ...((update.patch.hooks ?? document.hooks ?? []).length > 0 ? { hooks: update.patch.hooks ?? document.hooks } : {}),
  };
}

export function formatTerminalOutput(output: unknown): string {
  if (output === undefined) return "";
  return `\nOutput:\n${prettyLines(output, "  ").join("\n")}\n`;
}

function formatSnapshot(document: RunInspectionSnapshot, nowMs: number): string {
  const lines = [formatHeader(document.run, nowMs), "", "Tree:"];
  lines.push(...formatInspectionTree(document.items));
  if (document.omitted && !document.items.some(item => item.role === "fold")) {
    lines.push(`  … ${document.omitted.dynamicContexts} contexts omitted (${formatCounts(document.omitted.counts)})`);
  }
  const inspectAll = document.actions.find(action => action.kind === "inspect-all");
  if (inspectAll) lines.push(`  More: acpus runs inspect ${document.run.id} --all`);

  const active = activeItems(document.items);
  const hiddenActive = (document.omitted?.counts.starting ?? 0) + (document.omitted?.counts.running ?? 0);
  if (active.length + hiddenActive > 0) {
    const byKey = new Map(document.items.map(item => [item.key, item]));
    lines.push("", "Active:");
    for (const item of active.slice(0, 3)) lines.push(`  ${formatActiveItem(item, byKey, nowMs)}`);
    const additional = Math.max(0, active.length - 3) + hiddenActive;
    if (additional > 0) lines.push(`  … ${additional} more running`);
  }

  const attention = formatAttention(document);
  if (attention.length > 0) lines.push("", "Attention:", ...attention);
  if (document.output !== undefined) {
    lines.push("", "Output:", ...prettyLines(document.output, "  "));
  }
  if (document.hooks && document.hooks.length > 0) {
    lines.push("", "Hooks:", ...document.hooks.map(entry => {
      const duration = entry.durationMs === undefined ? "" : `  ${formatHookDuration(entry.durationMs)}`;
      const exit = entry.exitCode === undefined ? "" : `  exit=${entry.exitCode}`;
      return `  ${entry.status}  ${entry.handlerId}  ${entry.event}  #${entry.eventSequence}${duration}${exit}`;
    }));
  }
  return `${lines.join("\n")}\n`;
}

function formatTarget(document: RunInspectionTargetDocument, nowMs: number): string {
  const { summary } = document;
  const current = currentTargetItem(document);
  const nodeStatus = current?.status ?? summary.nodeStatus;
  const lines = [formatHeader(document.run, nowMs), `Target ${document.target.id}  [${document.target.kind}]${nodeStatus ? `  ${nodeStatus}` : ""}`];
  if (summary.counts) {
    const statuses = formatCounts(summary.counts);
    lines.push(`  Aggregate: total=${summary.counts.total}${statuses ? `  ${statuses}` : ""}`);
  }
  if (summary.nodeId && summary.nodeId !== document.target.id) lines.push(`  Static node: ${summary.nodeId}${summary.staticKind ? ` [${summary.staticKind}]` : ""}`);
  if (summary.nodeKey && summary.nodeKey !== document.target.id) lines.push(`  Node key: ${summary.nodeKey}`);
  if (summary.frameKey && summary.frameKey !== document.target.id) lines.push(`  Frame key: ${summary.frameKey}`);
  if (summary.runDurationMs !== undefined) lines.push(`  Duration: ${formatDurationMs(summary.runDurationMs)}`);
  if (summary.input) lines.push(`  Input (${summary.input.kind}):`, ...prettyLines(summary.input.value, "    "));
  if (summary.output !== undefined) lines.push("  Output:", ...prettyLines(summary.output, "    "));
  if (summary.failure !== undefined) lines.push(`  ${formatFailure(summary.failure, 240)}`);
  const agent = current?.agent ?? summary.agent;
  if (agent) lines.push(...formatAgent(agent, 1, nowMs));
  if (summary.loopProgress) {
    lines.push(`  Loop: round ${summary.loopProgress.round}  index=${summary.loopProgress.index}${summary.loopProgress.stop ? "  stopping" : ""}`);
  }
  if (summary.prompt?.text) lines.push("  Prompt:", ...summary.prompt.text.replace(/\s+$/, "").split("\n").map(line => `    ${line}`));
  if (summary.signal) lines.push(...formatSignal(summary.signal, document.run.id, 1, summary.prompt?.text === undefined, nodeStatus === "awaiting"));
  if (summary.signal && summary.failure?.code === "signal_timeout") {
    lines.push(`  Retry: acpus runs retry ${document.run.id} --target ${summary.signal.target}`);
    lines.push(`  Fork: acpus runs fork ${document.run.id}`);
  }

  if (document.instances.length > 0) {
    lines.push("Instances:");
    for (const instance of document.instances) lines.push(`  ${statusGlyph(normalizeStatus(instance.status))} ${instance.nodeKey}  ${instance.status}`);
  }
  if (document.frames.length > 0) {
    lines.push("Frames:");
    for (const frame of document.frames) lines.push(`  ${statusGlyph(normalizeStatus(frame.status))} ${frame.frameKey}  ${frame.status}`);
  }
  if (document.attempts.length > 0) {
    lines.push("Attempts:");
    for (const attempt of document.attempts) {
      const duration = between(attempt.startedAt, attempt.finishedAt, nowMs);
      lines.push(`  ${statusGlyph(normalizeStatus(attempt.status))} ${attempt.attemptId}  ${attempt.status}  attempt=${attempt.attemptNo}${duration ? `  ${duration}` : ""}`);
      if (attempt.error !== undefined) lines.push(`    Error: ${oneLine(errorText(attempt.error), 240)}`);
    }
  }
  if (document.signalWaits.length > 0) {
    lines.push("Signal waits:");
    for (const wait of document.signalWaits) lines.push(`  ${statusGlyph(normalizeStatus(wait.status))} ${wait.nodeKey}  ${wait.status}`);
  }
  if (document.artifacts.length > 0) {
    lines.push("Artifacts:");
    for (const artifact of document.artifacts) lines.push(`  ${artifact.id}${artifact.mediaType ? `  ${artifact.mediaType}` : ""}  ${artifact.path}`);
  }
  return `${lines.join("\n")}\n`;
}

function formatInspectionTree(items: readonly RunInspectionItem[]): string[] {
  if (items.length === 0) return ["  (empty workflow)"];
  const byKey = new Map(items.map(item => [item.key, item]));
  const children = new Map<string, RunInspectionItem[]>();
  const roots: RunInspectionItem[] = [];
  for (const item of items) {
    if (!item.parentKey || !byKey.has(item.parentKey)) {
      roots.push(item);
      continue;
    }
    const siblings = children.get(item.parentKey);
    if (siblings) siblings.push(item);
    else children.set(item.parentKey, [item]);
  }

  const lines: string[] = [];
  const visited = new Set<string>();
  const visit = (item: RunInspectionItem, prefix: string, last: boolean, firstRoot = false): void => {
    if (visited.has(item.key)) return;
    visited.add(item.key);
    const connector = terminalTreeConnector(treeEdge(item), last, firstRoot);
    lines.push(`${prefix}${connector} ${formatTreeItem(item)}`);
    const nested = children.get(item.key) ?? [];
    const childPrefix = terminalTreeChildPrefix(prefix, last);
    nested.forEach((child, index) => visit(child, childPrefix, index === nested.length - 1));
  };
  roots.forEach((root, index) => visit(root, "", index === roots.length - 1, index === 0));
  for (const item of items) if (!visited.has(item.key)) visit(item, "", true, lines.length === 0);
  return lines;
}

function treeEdge(item: RunInspectionItem): TerminalTreeEdge {
  return item.scope || item.role === "context" || item.role === "fold" ? "region" : "node";
}

function formatTreeItem(item: RunInspectionItem): string {
  if (item.role === "fold") {
    const count = item.fold?.count ?? 0;
    return `… ${count} ${foldDescription(item)}`;
  }

  const parts = [`${statusGlyph(item.status)} ${item.label}`];
  if (item.scope) {
    if (item.scope.kind === "branch" && item.scope.ownerKind !== "parallel") {
      parts.push(item.scope.selection.replace("_", " "));
      if (item.scope.selection === "selected" && item.status !== "completed") parts.push(displayTreeStatus(item.status));
    }
    else if (item.status !== "completed") parts.push(displayTreeStatus(item.status));
    if (item.scope.empty) parts.push("empty");
    return parts.join(" · ");
  }

  parts.push(item.kind === "agent" && item.agent ? `agent(${item.agent.key})` : item.kind);
  if (item.status !== "completed") parts.push(displayTreeStatus(item.status));
  const progress = treeProgress(item);
  if (progress) parts.push(progress);
  return parts.join(" · ");
}

function foldDescription(item: RunInspectionItem): string {
  const noun = item.kind === "fanout_item" ? "items"
    : item.kind === "loop_iteration" ? "rounds"
      : item.kind === "branch" ? "branches"
        : item.label.replace(/^\d+\s+/, "").replaceAll("_", " ");
  const counts = item.fold?.counts;
  if (!counts) return noun;
  const statuses: Array<[keyof RunInspectionStatusCounts, string]> = [
    ["notStarted", "not started"], ["notSelected", "not selected"], ["pending", "pending"], ["starting", "starting"], ["ready", "ready"], ["running", "running"], ["awaiting", "awaiting"], ["completed", "completed"], ["failed", "failed"], ["timedOut", "timed out"], ["cancelled", "canceled"], ["mixed", "mixed"],
  ];
  const populated = statuses.filter(([key]) => (counts[key] ?? 0) > 0);
  const status = populated.length === 1 && counts[populated[0]![0]] === counts.total ? populated[0]![1] : undefined;
  return status && !noun.startsWith(`${status} `) ? `${status} ${noun}` : noun;
}

function treeProgress(item: RunInspectionItem): string | undefined {
  if ((item.attemptNo ?? 1) > 1) return `attempt ${item.attemptNo}`;
  const count = item.composite?.counts?.total;
  if (item.kind === "parallel" && count !== undefined) return `${count} branches`;
  if (item.kind === "fanout" && count !== undefined) return `${count} items`;
  if (item.kind === "loop") {
    const rounds = count ?? (item.composite?.currentIteration === undefined ? undefined : item.composite.currentIteration + 1);
    if (rounds !== undefined) return `${rounds} ${rounds === 1 ? "round" : "rounds"}`;
  }
  return undefined;
}

function activeItems(items: readonly RunInspectionItem[]): RunInspectionItem[] {
  const executableKinds = new Set(["agent", "task", "signal", "assert"]);
  return items.filter(item => executableKinds.has(item.kind) && (item.status === "starting" || item.status === "running"));
}

function formatActiveItem(item: RunInspectionItem, byKey: ReadonlyMap<string, RunInspectionItem>, nowMs: number): string {
  const kind = item.kind === "agent" && item.agent ? `agent(${item.agent.key})` : item.kind;
  const pulse = item.agent ? ` · ${formatAgentPulse(item.agent, nowMs)}` : "";
  return `${statusGlyph(item.status)} ${itemBreadcrumb(item, byKey)} · ${kind}${pulse}`;
}

function formatAgentPulse(agent: AgentInspectionState, nowMs: number): string {
  const recentTools = agent.tools?.recent ?? [];
  const tool = recentTools.filter(item => item.status === "running" || item.status === "started").at(-1) ?? recentTools.at(-1);
  const updated = agent.lastActivityAt ? relativeAge(agent.lastActivityAt, nowMs) : undefined;
  const fields = [
    agent.turnCount === undefined ? undefined : `turn ${agent.turnCount}`,
    tool ? formatRecentTool(tool) : undefined,
    updated ? `updated ${updated}` : undefined,
  ].filter((value): value is string => value !== undefined);
  return fields.length > 0 ? fields.join(" · ") : "no update yet";
}

function formatAttention(document: RunInspectionSnapshot): string[] {
  const byKey = new Map(document.items.map(item => [item.key, item]));
  const actions = indexActions(document.actions);
  const exceptional = document.items.filter(item => item.role !== "fold"
    && (item.status === "awaiting" || item.status === "failed" || item.status === "timed_out")
    && (item.role !== "context" || item.failure !== undefined || actions.byItem.has(item.key)));
  const exceptionalAncestors = new Set<string>();
  for (const item of exceptional) {
    let parentKey = item.parentKey;
    while (parentKey && !exceptionalAncestors.has(parentKey)) {
      exceptionalAncestors.add(parentKey);
      parentKey = byKey.get(parentKey)?.parentKey;
    }
  }
  const candidates = exceptional.filter(item => !exceptionalAncestors.has(item.key));
  const lines: string[] = [];
  if (document.run.execution.state === "stale") {
    const reason = document.run.execution.reason?.replaceAll("_", " ") ?? "execution inactive";
    lines.push(`  ◆ run — stale: ${reason}`);
  }
  for (const item of candidates) {
    const breadcrumb = itemBreadcrumb(item, byKey);
    if (item.status === "awaiting") {
      lines.push(`  ${statusGlyph(item.status)} ${breadcrumb} — waiting for input`);
      if (item.signal?.promptPreview) lines.push(`     Prompt: ${oneLine(item.signal.promptPreview, 240)}`);
      if (item.signal) {
        const schema = item.signal.outputSchema ? schemaSummary(item.signal.outputSchema) : item.signal.schemaSummary ?? "JSON string";
        lines.push(`     Expected payload: ${oneLine(schema, 240)}`);
      }
    } else {
      const detail = item.failure ? formatFailure(item.failure, 240) : displayStatus(item.status);
      lines.push(`  ${statusGlyph(item.status)} ${breadcrumb} — ${detail}`);
    }
    const commands = formatActionCommands(item, actions, document.run.id);
    lines.push(...commands.map(command => `     ${command}`));
  }
  lines.push(...formatRunLevelActionCommands(actions, document.run.id).map(command => `  ${command}`));
  return lines;
}

function formatActionCommands(
  item: RunInspectionItem,
  actions: ActionIndex,
  runId: string,
): string[] {
  const relevant = actions.byItem.get(item.key) ?? [];
  const commands = relevant.flatMap(action => {
    if (action.kind === "inspect-target") return [`Inspect: acpus runs inspect ${runId} --target ${action.target}`];
    if (action.kind === "signal") {
      const payload = item.signal?.outputSchema || item.signal?.schemaSummary || action.schemaSummary ? "'<json>'" : `'\"text\"'`;
      return [`Signal: acpus runs signal ${runId} --target ${action.target} --payload ${payload}`];
    }
    if (action.kind === "retry") return [`Retry: acpus runs retry ${runId} --target ${action.target}`];
    if (action.kind === "fork") return [`Fork: acpus runs fork ${runId}`];
    return [];
  });
  return [...new Set(commands)];
}

function formatRunLevelActionCommands(actions: ActionIndex, runId: string): string[] {
  return actions.unscopedForks.length > 0 ? [`Fork: acpus runs fork ${runId}`] : [];
}

type ActionIndex = {
  byItem: Map<string, RunInspectionAction[]>;
  unscopedForks: Array<Extract<RunInspectionAction, { kind: "fork" }>>;
};

function indexActions(actions: readonly RunInspectionAction[]): ActionIndex {
  const byItem = new Map<string, RunInspectionAction[]>();
  const unscopedForks: ActionIndex["unscopedForks"] = [];
  for (const action of actions) {
    if (action.kind === "inspect-all") continue;
    if (action.kind === "fork" && action.itemKey === undefined) {
      unscopedForks.push(action);
      continue;
    }
    const itemKey = action.itemKey;
    if (!itemKey) continue;
    const itemActions = byItem.get(itemKey);
    if (itemActions) itemActions.push(action);
    else byItem.set(itemKey, [action]);
  }
  return { byItem, unscopedForks };
}

function itemBreadcrumb(item: RunInspectionItem, byKey: ReadonlyMap<string, RunInspectionItem>): string {
  const labels: string[] = [];
  const seen = new Set<string>();
  let current: RunInspectionItem | undefined = item;
  while (current && !seen.has(current.key)) {
    seen.add(current.key);
    labels.push(current.label);
    current = current.parentKey ? byKey.get(current.parentKey) : undefined;
  }
  return oneLine(labels.reverse().join(" › "), 200);
}

function formatFailure(failure: NonNullable<RunInspectionItem["failure"]>, messageLimit: number): string {
  const layers = [
    `${failure.origin}${failure.code ? ` ${failure.code}` : ""}`,
    failure.upstream ? `acpx${failure.upstream.code ? ` ${failure.upstream.code}` : ""}` : undefined,
  ].filter((value): value is string => value !== undefined);
  return oneLine(`Error (${layers.join(" · ")}): ${failure.message}`, messageLimit);
}

function formatAgent(agent: AgentInspectionState, indent: number, nowMs: number): string[] {
  const prefix = "  ".repeat(indent);
  const lines: string[] = [];
  const summary = [agent.key, agent.turnCount === undefined ? undefined : `turns=${agent.turnCount}`, agent.tools === undefined ? undefined : `tools=${agent.tools.totalCallCount}`, agent.stopReason === undefined ? undefined : `stop=${agent.stopReason}`].filter(Boolean);
  if (summary.length > 0) lines.push(`${prefix}Agent: ${summary.join("  ")}`);
  const recentTools = agent.tools?.recent.slice(-3) ?? [];
  if (recentTools.length) lines.push(`${prefix}Last tools: ${recentTools.map(formatRecentTool).join(" · ")}`);
  if (agent.context) lines.push(`${prefix}Context: ${compactNumber(agent.context.used)}/${compactNumber(agent.context.size)}`);
  if (agent.tokenUsage) {
    const tokens = [
      agent.tokenUsage.inputTokens === undefined ? undefined : `in ${compactNumber(agent.tokenUsage.inputTokens)}`,
      agent.tokenUsage.outputTokens === undefined ? undefined : `out ${compactNumber(agent.tokenUsage.outputTokens)}`,
      agent.tokenUsage.totalTokens === undefined ? undefined : `total ${compactNumber(agent.tokenUsage.totalTokens)}`,
    ].filter(Boolean);
    if (tokens.length > 0) lines.push(`${prefix}Tokens: ${tokens.join(", ")}`);
  }
  if (agent.lastActivityAt) {
    const age = relativeAge(agent.lastActivityAt, nowMs);
    if (age) lines.push(`${prefix}Last active: ${age}`);
  }
  return lines;
}

function formatAgentProgress(agent: AgentInspectionState, nowMs: number): string {
  const fields: string[] = [];
  if (agent.lastActivityAt) {
    const age = relativeAge(agent.lastActivityAt, nowMs);
    if (age) fields.push(`active=${age.replace(/ ago$/, "")}`);
  }
  if (agent.turnCount !== undefined) fields.push(`turn=${agent.turnCount}`);
  if (agent.tools) {
    const recentTools = agent.tools.recent.slice(-3);
    const recent = recentTools.length > 0 ? `[${recentTools.map(formatRecentToolInline).join(",")}]` : "";
    fields.push(`tools=${agent.tools.totalCallCount}${recent}`);
  }
  if (agent.context) fields.push(`ctx=${compactNumber(agent.context.used)}/${compactNumber(agent.context.size)}`);
  if (agent.tokenUsage?.totalTokens !== undefined) fields.push(`tok=${compactNumber(agent.tokenUsage.totalTokens)}`);
  if (agent.stopReason) fields.push(`stop=${oneLine(agent.stopReason, 48)}`);
  return fields.join("  ");
}

function formatRecentTool(tool: RecentTool): string {
  const status = typeof tool.status === "string" ? tool.status : undefined;
  return `${toolStatusGlyph(status)} ${truncateToolCommand(tool.command)}`;
}

function formatRecentToolInline(tool: RecentTool): string {
  const status = typeof tool.status === "string" ? tool.status : undefined;
  return `${toolStatusGlyph(status)}${truncateToolCommand(tool.command).replace(": ", ":")}`;
}

function truncateToolCommand(command: string): string {
  const compact = command.replace(/\s+/g, " ").trim();
  const words = compact.split(" ");
  const wordLimited = words.length > 3 ? `${words.slice(0, 3).join(" ")}…` : compact;
  const visible = Array.from(wordLimited);
  return visible.length <= 32 ? wordLimited : `${visible.slice(0, 31).join("")}…`;
}

function toolStatusGlyph(status: string | undefined): string {
  if (status === "running" || status === "started") return "⠋";
  if (status === "completed" || status === "succeeded") return "✓";
  if (status === "failed") return "◆";
  if (status === "cancelled" || status === "canceled") return "✗";
  return "·";
}

function formatSignal(signal: NonNullable<RunInspectionItem["signal"]>, runId: string, indent: number, includePrompt: boolean, open: boolean): string[] {
  const prefix = "  ".repeat(indent);
  const lines: string[] = [];
  if (includePrompt && signal.promptPreview) lines.push(`${prefix}Prompt: ${oneLine(signal.promptPreview, 240)}`);
  if (signal.deadlineAt) lines.push(`${prefix}Deadline: ${signal.deadlineAt}`);
  if (!open) {
    lines.push(`${prefix}Signal wait is closed.`);
    return lines;
  }
  lines.push(`${prefix}Expected payload: ${signal.outputSchema ? schemaSummary(signal.outputSchema) : signal.schemaSummary ?? "JSON string"}`);
  const payload = signal.outputSchema || signal.schemaSummary ? "'<json>'" : `'\"text\"'`;
  lines.push(`${prefix}Signal: acpus runs signal ${runId} --target ${signal.target} --payload ${payload}`);
  return lines;
}

function formatHeader(run: RunInspectionRunSummary, nowMs: number): string {
  const duration = run.durationMs === undefined ? Math.max(0, nowMs - Date.parse(run.createdAt)) : run.durationMs;
  const lines = [`Run ${run.id}  ${run.name}  ${executionStatus(run)}  ${formatDurationMs(duration)}`];
  if (run.fork) {
    lines.push(`Fork: source=${run.fork.sourceRunId}${run.fork.target ? `  target=${run.fork.target}` : ""}${run.fork.unsafeReuse ? "  unsafe-reuse" : ""}`);
  }
  if (run.agentUsage) {
    lines.push(`Agent usage: instances=${run.agentUsage.instances}  attempts=${run.agentUsage.attempts}  turns=${run.agentUsage.turns}`);
  }
  return lines.join("\n");
}

function executionStatus(run: RunInspectionRunSummary): string {
  if (run.execution.state !== "stale") return run.status;
  const reason = run.execution.reason === "daemon_pid_dead" ? "daemon pid dead" : run.execution.reason === "run_lease_expired" ? "run lease expired" : "daemon heartbeat expired";
  return `stale (${reason}, last status: ${run.status})`;
}

function formatCounts(counts: RunInspectionStatusCounts): string {
  const labels: Array<[keyof RunInspectionStatusCounts, string]> = [
    ["notStarted", "not-started"], ["notSelected", "not-selected"], ["pending", "pending"], ["starting", "starting"], ["ready", "ready"], ["running", "running"], ["awaiting", "awaiting"], ["completed", "completed"], ["failed", "failed"], ["timedOut", "timed-out"], ["cancelled", "canceled"], ["mixed", "mixed"],
  ];
  return labels.flatMap(([key, label]) => counts[key] ? [`${label}=${counts[key]}`] : []).join("  ");
}

function schemaSummary(schema: SchemaIR): string {
  if (schema.kind === "array") return `${schemaSummary(schema.item)}[]`;
  if (schema.kind === "union") return schema.variants.map(schemaSummary).join(" | ");
  if (schema.kind === "literal") return JSON.stringify(schema.value);
  if (schema.kind === "enum") return schema.values.map(value => JSON.stringify(value)).join(" | ");
  if (schema.kind === "record") return `record<${schemaSummary(schema.value)}>`;
  if (schema.kind !== "object") return schema.kind;
  const required = new Set(schema.required);
  return `{ ${Object.entries(schema.fields).map(([name, field]) => `${name}: ${schemaSummary(field)}${required.has(name) ? "" : "?"}`).join(", ")} }`;
}

function statusGlyph(status: RunInspectionStatus): string {
  if (status === "pending" || status === "ready" || status === "not_started") return "○";
  if (status === "running" || status === "starting") return "⠋";
  if (status === "awaiting") return "⏳";
  if (status === "completed") return "✓";
  if (status === "failed" || status === "timed_out") return "◆";
  if (status === "cancelled") return "✗";
  if (status === "not_selected") return "·";
  return "◇";
}

function displayStatus(status: RunInspectionStatus): string {
  return status.replaceAll("_", "-").replace("cancelled", "canceled");
}

function displayTreeStatus(status: RunInspectionStatus): string {
  return status.replaceAll("_", " ").replace("cancelled", "canceled");
}

function changeState(change: RunInspectionChange): string {
  if (change.action === "retrying" || change.action === "requeued") return "retrying";
  if (change.action === "paused" || change.action === "resumed" || change.action === "advanced" || change.action === "consumed" || change.action === "admitted") return change.action;
  return displayStatus(change.status ?? statusForAction(change.action));
}

function statusForAction(action: RunInspectionChange["action"]): RunInspectionStatus {
  if (action === "started" || action === "progress") return "running";
  if (action === "awaiting") return "awaiting";
  if (action === "completed" || action === "consumed") return "completed";
  if (action === "failed") return "failed";
  if (action === "timed_out") return "timed_out";
  if (action === "cancelled") return "cancelled";
  return "ready";
}

function normalizeStatus(status: string): RunInspectionStatus {
  if (status === "canceled") return "cancelled";
  const known: RunInspectionStatus[] = ["not_started", "not_selected", "pending", "starting", "ready", "running", "awaiting", "completed", "failed", "timed_out", "cancelled", "mixed"];
  return known.includes(status as RunInspectionStatus) ? status as RunInspectionStatus : "mixed";
}

function between(start: string | undefined, end: string | undefined, nowMs: number, status: RunInspectionStatus = "running"): string | undefined {
  if (!start) return undefined;
  const startMs = Date.parse(start);
  const endMs = end ? Date.parse(end) : terminalItemStatus(status) ? undefined : nowMs;
  if (!Number.isFinite(startMs) || endMs === undefined || !Number.isFinite(endMs)) return undefined;
  return formatDurationMs(Math.max(0, endMs - startMs));
}

function formatDurationMs(ms: number): string {
  const seconds = Math.floor(Math.max(0, ms) / 1_000);
  if (seconds < 60) return seconds === 0 ? "<1s" : `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainSec = seconds % 60;
  if (minutes < 60) return remainSec > 0 ? `${minutes}m${remainSec}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

function formatHookDuration(ms: number): string {
  return ms < 1_000 ? `${ms}ms` : `${(ms / 1_000).toFixed(1)}s`;
}

function relativeAge(value: string, nowMs: number): string | undefined {
  const at = Date.parse(value);
  if (!Number.isFinite(at)) return undefined;
  return `${formatDurationMs(Math.max(0, nowMs - at))} ago`;
}

function elapsedSince(start: string, value: string): string {
  const startMs = Date.parse(start);
  const valueMs = Date.parse(value);
  if (!Number.isFinite(startMs) || !Number.isFinite(valueMs)) return "?";
  const elapsed = Math.max(0, valueMs - startMs);
  if (elapsed < 10_000) return `${(elapsed / 1_000).toFixed(1).replace(/\.0$/, "")}s`;
  return formatDurationMs(elapsed);
}

function actionableItems(items: readonly RunInspectionItem[]): RunInspectionItem[] {
  const rank: Partial<Record<RunInspectionStatus, number>> = {
    failed: 0,
    timed_out: 1,
    awaiting: 2,
    running: 3,
    starting: 4,
    ready: 5,
    pending: 6,
  };
  const active = items.filter(item => rank[item.status] !== undefined);
  const dynamic = active.some(item => item.role !== "static") ? active.filter(item => item.role !== "static") : active;
  return [...dynamic].sort((left, right) => {
    const status = (rank[left.status] ?? 99) - (rank[right.status] ?? 99);
    return status || left.path.join("/").localeCompare(right.path.join("/")) || left.key.localeCompare(right.key);
  });
}

function currentTargetItem(document: RunInspectionTargetDocument): RunInspectionItem | undefined {
  const { summary } = document;
  if (document.target.kind === "static-node" && summary.counts) return undefined;
  return document.items.find(item => item.key === document.target.id
    || summary.nodeKey !== undefined && (item.key === summary.nodeKey || item.nodeKey === summary.nodeKey)
    || summary.nodeId !== undefined && item.nodeId === summary.nodeId);
}

function terminalItemStatus(status: RunInspectionStatus): boolean {
  return status === "completed" || status === "failed" || status === "timed_out" || status === "cancelled" || status === "not_selected";
}

function prettyLines(value: unknown, indent: string): string[] {
  const json = JSON.stringify(value, null, 2) ?? String(value);
  return json.split("\n").map(line => `${indent}${line}`);
}

function oneLine(value: string, limit: number): string {
  const compact = stripVTControlCharacters(value).replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  const visible = Array.from(compact);
  return visible.length <= limit ? compact : `${visible.slice(0, limit - 1).join("")}…`;
}

function errorText(error: unknown): string {
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string") return error.message;
  if (error && typeof error === "object" && "reason" in error && typeof error.reason === "string") return error.reason;
  return JSON.stringify(error);
}

function compactNumber(value: number): string {
  return value < 1_000 ? String(value) : `${(value / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
}
