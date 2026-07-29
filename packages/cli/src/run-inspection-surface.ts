import { stripVTControlCharacters } from "node:util";
import type { SchemaIR } from "@acpus/core/ir";
import type {
  InspectTargetResult,
  RunInspectionCandidatesDocument,
  RunInspectionAction,
  RunInspectionCurrentActivity,
  RunInspectionEvidenceCandidatesDocument,
  RunInspectionEvidenceDocument,
  RunInspectionExcerpt,
  RunInspectionItem,
  RunInspectionOverviewAction,
  RunInspectionRaw,
  RunInspectionRunSummary,
  RunInspectionSnapshot,
  RunInspectionStatus,
  RunInspectionStatusCounts,
  RunInspectionTargetSummaryDocument,
  RunInspectionTimelineDocument,
  RunInspectionTimelineEntry,
  RunInspectionToolActivity,
  RunInspectionVisibility,
} from "@acpus/runtime";
import { renderShellCommand } from "./shell-command.js";
import { terminalTreeChildPrefix, terminalTreeConnector, type TerminalTreeEdge } from "./terminal-tree.js";
import {
  buildRunInspectionTree,
  inspectionTreeAttention,
  type RunInspectionTree,
  type RunInspectionTreeEntry,
  type RunInspectionTreeFold,
} from "./run-inspection-tree.js";

type AgentDecisionState = NonNullable<RunInspectionItem["agent"]>;

/** Internal CLI presentation union; it does not cross the Runtime API seam. */
export type CliInspectionResult =
  | RunInspectionSnapshot
  | InspectTargetResult
  | RunInspectionTimelineDocument
  | RunInspectionEvidenceDocument
  | RunInspectionEvidenceCandidatesDocument
  | RunInspectionRaw;

/** Command flags retained when an ambiguous target needs one exact selector. */
export type InspectionCandidateView = {
  timeline?: boolean;
  evidence?: boolean;
  all?: boolean;
  controls?: boolean;
};

export function formatRunInspectionDocument(document: CliInspectionResult, nowMs = Date.now()): string {
  if (document.kind === "raw") return "Raw run inspection is available only as JSON.\n";
  if (document.kind === "candidates") return formatInspectionCandidates(document);
  if (document.kind === "target") return formatTargetSummary(document);
  if (document.kind === "timeline") return formatTimeline(document);
  if (document.kind === "evidence") return formatEvidence(document);
  if (document.kind === "evidence-candidates") return formatEvidenceCandidates(document);
  return formatSnapshot(document, nowMs);
}

export function formatRunInspectionHeader(run: RunInspectionRunSummary, nowMs = Date.now()): string {
  return `${formatHeader(run, nowMs)}\n`;
}

function formatTargetSummary(document: RunInspectionTargetSummaryDocument): string {
  const subject = [
    document.subject.label,
    document.subject.id === document.subject.label ? undefined : document.subject.ref ?? document.subject.id,
    document.subject.kind,
  ].filter((value): value is string => value !== undefined).join("  ");
  const state = [
    displayStatus(document.state.status),
    document.state.reason ? oneLine(document.state.reason, 160) : undefined,
    document.state.durationMs === undefined ? undefined : formatDurationMs(document.state.durationMs),
  ].filter((value): value is string => value !== undefined).join("  ");
  const lines = [
    `Run ${document.run.id}  ${document.run.status}`,
    `Target ${subject}`,
    `State ${state}`,
  ];
  if (document.pulse) {
    const turn = document.pulse.turn === undefined ? "" : `  turn=${document.pulse.turn}`;
    const headline = document.pulse.headline ? `  ${oneLine(document.pulse.headline, 240)}` : "";
    lines.push(`Pulse ${formatPhase(document.pulse.phase)}${turn}${headline}`);
  }
  if (document.attention) {
    lines.push(`Attention ${document.attention.code}  ${oneLine(document.attention.summary, 160)}`);
  }
  if (document.visibility) lines.push(formatVisibility(document.visibility));
  if (document.occurrence) {
    const counts = formatCounts(document.occurrence.counts);
    lines.push(`Occurrences ${document.occurrence.total}${counts ? `  ${counts}` : ""}`);
  }
  lines.push(...formatSummaryActions(document.availableActions, document.run.id));
  return `${lines.join("\n")}\n`;
}

function formatSummaryActions(actions: readonly RunInspectionAction[], runId: string): string[] {
  const controls = actions.filter(isTargetControlAction);
  const operations = actions.filter(action => !isTargetControlAction(action));
  return [
    ...(operations.length === 0 ? [] : [
      "Available operations:",
      ...operations.map(action => `  ${formatSummaryAction(action, runId)}`),
    ]),
    ...(controls.length === 0 ? [] : [
      "Controls (runtime-approved capability; not a recommendation):",
      ...controls.map(action => `  ${formatTargetControlAction(action, runId)}`),
    ]),
  ];
}

function formatEvidence(document: RunInspectionEvidenceDocument): string {
  const { evidence } = document;
  const disposition = evidence.dispositionReason
    ? `${evidence.schedulerDisposition}/${evidence.dispositionReason}`
    : evidence.schedulerDisposition;
  const lines = [
    `Run ${document.run.id}  ${document.run.status}`,
    `Evidence ${document.subject.label}  ${document.subject.ref ?? document.subject.id}`,
    ...(document.visibility ? [formatVisibility(document.visibility)] : []),
    `Evidence ${evidence.state}/${evidence.completeness}  turns=${evidence.turnCount}  gaps=${evidence.gapCount}  scheduler=${disposition}${evidence.providerOutcome ? `  provider=${evidence.providerOutcome}` : ""}`,
    `  Directory: ${evidence.directory}`,
  ];
  if (evidence.records.entries.length === 0) lines.push("  (no retained Evidence records on this page)");
  for (const record of evidence.records.entries) {
    const sizes = [
      `durable=${record.lastDurableResponseBytes}B`,
      record.responseAtFenceBytes === undefined ? undefined : `fence=${record.responseAtFenceBytes}B`,
      record.finalObservedResponseBytes === undefined ? undefined : `final=${record.finalObservedResponseBytes}B`,
    ].filter((value): value is string => value !== undefined).join("  ");
    const trace = record.trace
      ? `  trace=${record.trace.state}${record.trace.file ? `/${record.trace.file}` : ""}${record.trace.bytes === undefined ? "" : `/${record.trace.bytes}B`}`
      : "";
    lines.push(`  Turn ${record.turn}  ${record.file}  prompt=${record.prompt.kind}/${record.prompt.bytes}B/${record.prompt.digest}  ${sizes}${trace}`);
  }
  if (evidence.records.nextPage !== undefined) {
    const argv = ["acpus", "runs", "inspect", document.run.id, "--target", document.subject.ref ?? document.subject.id, "--evidence"];
    if (evidence.records.limit !== 12) argv.push("--limit", String(evidence.records.limit));
    argv.push("--page", String(evidence.records.nextPage));
    lines.push(`Next: ${command(...argv)}`);
  }
  return `${lines.join("\n")}\n`;
}

function formatEvidenceCandidates(document: RunInspectionEvidenceCandidatesDocument): string {
  const lines = [
    `Run ${document.run.id}  ${document.run.status}`,
    `Evidence ${document.target}  matches=${document.candidates.total}`,
  ];
  if (document.candidates.entries.length === 0) lines.push("  (no attempts on this page)");
  else {
    for (const candidate of document.candidates.entries) {
      lines.push(`  ${statusGlyph(candidate.status)} ${candidate.target}  attempt=${candidate.attemptNo}  ${candidate.breadcrumb}`);
    }
  }
  lines.push(`Select: ${command("acpus", "runs", "inspect", document.run.id, "--target", "@ref#N", "--evidence")}`);
  if (document.candidates.nextPage !== undefined) {
    const argv = ["acpus", "runs", "inspect", document.run.id, "--target", document.target, "--evidence"];
    if (document.candidates.limit !== 12) argv.push("--limit", String(document.candidates.limit));
    argv.push("--page", String(document.candidates.nextPage));
    lines.push(`Next: ${command(...argv)}`);
  }
  return `${lines.join("\n")}\n`;
}

function formatSummaryAction(action: RunInspectionAction, runId: string): string {
  if (action.kind === "inspect-timeline") return `Timeline: ${command("acpus", "runs", "inspect", runId, "--target", action.target, "--timeline")}`;
  if (action.kind === "follow-target") return `Follow: ${command("acpus", "runs", "inspect", runId, "--target", action.target, "--follow")}`;
  if (action.kind === "signal") {
    return `Signal: ${command("acpus", "runs", "signal", runId, "--target", action.target, "--payload", action.schemaSummary ? "<json>" : "\"text\"")}`;
  }
  return "";
}

type TargetControlAction = Extract<RunInspectionAction, { kind: "retry" | "cancel" | "steer" }>;

function isTargetControlAction(action: RunInspectionAction): action is TargetControlAction {
  return action.kind === "retry" || action.kind === "cancel" || action.kind === "steer";
}

function formatTargetControlAction(action: TargetControlAction, runId: string): string {
  if (action.kind === "steer") {
    return `Steer: ${command("acpus", "runs", "steer", runId, "--target", action.target, "--instruction", "<correction>")}`;
  }
  if (action.kind === "retry") return `Retry: ${command("acpus", "runs", "retry", runId, ...(action.target ? ["--target", action.target] : []))}`;
  return `Cancel: ${command("acpus", "runs", "cancel", runId, ...(action.target ? ["--target", action.target] : []))}`;
}

export function formatInspectionCandidates(
  document: RunInspectionCandidatesDocument,
  view: InspectionCandidateView = {},
): string {
  const lines = [
    `Run ${document.run.id}  ${document.run.status}`,
    `Target ${document.target}  matches=${document.candidates.total}`,
  ];
  if (document.candidates.entries.length === 0) lines.push("  (no occurrences on this page)");
  else {
    for (const candidate of document.candidates.entries) {
      lines.push(`  ${statusGlyph(candidate.status)} ${candidate.ref}  ${candidate.breadcrumb}  ${candidate.kind}`);
    }
  }
  const selectedView = inspectionCandidateArgs(view);
  lines.push(`Select: ${command("acpus", "runs", "inspect", document.run.id, "--target", "@ref", ...selectedView)}`);
  if (document.candidates.nextPage !== undefined) {
    const argv = ["acpus", "runs", "inspect", document.run.id, "--target", document.target, ...selectedView];
    if (document.candidates.limit !== 12) argv.push("--limit", String(document.candidates.limit));
    argv.push("--page", String(document.candidates.nextPage));
    lines.push(`Next: ${command(...argv)}`);
  }
  return `${lines.join("\n")}\n`;
}

function inspectionCandidateArgs(view: InspectionCandidateView): string[] {
  return [
    ...(view.timeline ? ["--timeline"] : []),
    ...(view.evidence ? ["--evidence"] : []),
    ...(view.all ? ["--all"] : []),
    ...(view.controls ? ["--controls"] : []),
  ];
}

function formatTimeline(document: RunInspectionTimelineDocument): string {
  const lines = [
    `Run ${document.run.id}  ${document.run.status}`,
    `Timeline ${document.subject.label}  ${document.subject.ref ?? document.subject.id}  ${displayStatus(document.state.status)}`,
  ];
  if (document.visibility) lines.push(formatVisibility(document.visibility));
  const exactAttempt = document.subject.targetKind === "attempt";
  if (document.current) {
    lines.push("Current:", ...formatCurrent(document.current, exactAttempt).map(line => `  ${line}`));
  }
  lines.push("Recent:");
  if (document.recent.entries.length === 0) lines.push("  (no closed activity)");
  else lines.push(...document.recent.entries.map(entry => `  ${formatTimelineEntry(entry, exactAttempt)}`));
  if (document.recent.olderPage !== undefined) {
    const argv = ["acpus", "runs", "inspect", document.run.id, "--target", document.subject.ref ?? document.subject.id, "--timeline"];
    if (document.recent.limit !== 12) argv.push("--limit", String(document.recent.limit));
    argv.push("--page", String(document.recent.olderPage));
    lines.push(`Older: ${command(...argv)}`);
  }
  if ((document.recent.retentionOmittedBefore ?? 0) > 0) {
    lines.push(`  … ${document.recent.retentionOmittedBefore} earlier entries expired from bounded history`);
  }
  return `${lines.join("\n")}\n`;
}

function formatCurrent(current: RunInspectionCurrentActivity, exactAttempt: boolean): string[] {
  if (current.kind === "agent") {
    const attempt = formatAttemptAttribution(current, exactAttempt);
    const disposition = current.postFence ? "  post-fence/discarded" : "";
    const turn = current.turn === undefined ? "" : `  turn=${current.turn}${current.turnKind ? `/${current.turnKind}` : ""}`;
    const lines = [`${formatPhase(current.phase)}${attempt}${turn}${disposition}`];
    if (current.response) lines.push(`Response: ${formatExcerpt(current.response, 240)}`);
    if (current.intent) {
      lines.push(`${current.intent.kind === "plan" ? "Plan" : "Reported thought"}: ${formatExcerpt(current.intent.excerpt, 240)}`);
    }
    if (current.tools) {
      for (const tool of current.tools.active) lines.push(`Tool: ${formatTool(tool)}`);
      if (current.tools.omittedActive > 0) lines.push(`… ${current.tools.omittedActive} active tools omitted`);
    }
    return lines;
  }
  if (current.kind === "signal") {
    return [
      `awaiting  updated=${current.updatedAt}${current.deadlineAt ? `  deadline=${current.deadlineAt}` : ""}`,
      ...(current.prompt ? [`Prompt: ${formatExcerpt(current.prompt, 240)}`] : []),
      ...(current.schemaSummary ? [`Expected: ${oneLine(current.schemaSummary, 240)}`] : []),
    ];
  }
  return [`${current.phase}  updated=${current.updatedAt}${current.message ? `  ${oneLine(current.message, 240)}` : ""}`];
}

function formatTimelineEntry(entry: RunInspectionTimelineEntry, exactAttempt = false): string {
  if (entry.kind === "transition") {
    const attempt = formatAttemptAttribution(entry, exactAttempt);
    return `${entry.at}  ${entry.action}${entry.status ? `/${displayStatus(entry.status)}` : ""}${attempt}${entry.summary ? `  ${formatExcerpt(entry.summary, 240)}` : ""}`;
  }
  if (entry.kind === "activity") {
    const channel = entry.channel === "reported-thought" ? "Reported thought" : entry.channel;
    const disposition = entry.postFence ? "  post-fence/discarded" : "";
    return `${entry.at}  ${channel}${formatAttemptAttribution(entry, exactAttempt)}${entry.turn === undefined ? "" : `  turn=${entry.turn}`}${disposition}  ${entry.tool ? formatTool(entry.tool) : formatExcerpt(entry.summary, 240)}`;
  }
  if (entry.kind === "control") {
    return `${entry.at}  ${entry.action}${formatAttemptAttribution(entry, exactAttempt)}${entry.responseAtFenceBytes === undefined ? "" : `  response-at-fence=${entry.responseAtFenceBytes}B`}`;
  }
  if (entry.kind === "phase") {
    return `${entry.at}  phase ${formatPhase(entry.phase)}${formatAttemptAttribution(entry, exactAttempt)}${entry.turn === undefined ? "" : `  turn=${entry.turn}`}`;
  }
  if (entry.kind === "visibility") {
    return entry.state === "restored"
      ? `${entry.at}  Visibility restored`
      : `${entry.at}  Visibility degraded/${entry.reason ?? "unknown"}  Inspection may be incomplete; Agent execution health is unknown.`;
  }
  return `${entry.at}  gap  dropped=${entry.dropped}  ${oneLine(entry.reason, 240)}`;
}

/** A Timeline follow entry is complete by itself and needs no replayed document. */
export function formatRunInspectionTimelineEntry(entry: RunInspectionTimelineEntry): string {
  return `Timeline: ${formatTimelineEntry(entry)}\n`;
}

function formatTool(tool: RunInspectionToolActivity): string {
  const fields = [
    tool.name,
    tool.status,
    tool.input ? `in=${formatExcerpt(tool.input, 120)}` : undefined,
    tool.output ? `out=${formatExcerpt(tool.output, 120)}` : undefined,
  ].filter((value): value is string => value !== undefined);
  return oneLine(fields.join("  "), 240);
}

function formatExcerpt(excerpt: RunInspectionExcerpt, limit: number): string {
  const suffix = excerpt.truncated ? `… [${excerpt.originalBytes}B]` : "";
  return `${oneLine(excerpt.text, Math.max(1, limit - suffix.length))}${suffix}`;
}

function formatAttemptAttribution(
  value: { attemptNo?: number },
  exactAttempt: boolean,
): string {
  if (exactAttempt) return "";
  if (value.attemptNo !== undefined) return `  attempt=${value.attemptNo}`;
  return "";
}

function formatPhase(phase: string): string {
  if (phase === "reported-thought") return "Reported thought";
  if (phase === "output-repair") return "Automatic output repair";
  return phase;
}

function formatVisibility(visibility: RunInspectionVisibility): string {
  return `Visibility degraded/${visibility.reason}  Inspection may be incomplete; Agent execution health is unknown.`;
}

function formatSnapshot(document: RunInspectionSnapshot, nowMs: number): string {
  const tree = buildRunInspectionTree(document.items, {
    all: document.all === true,
    actions: document.availableActions,
  });
  const counts = formatCounts(document.counts);
  const lines = [
    formatHeader(document.run, nowMs),
    `Counts total=${document.counts.total}${counts ? `  ${counts}` : ""}`,
    "",
    "Tree:",
  ];
  lines.push(...formatInspectionTree(tree, document.all === true));

  const attention = formatAttention(document, tree);
  if (attention.length > 0) lines.push("", "Attention:", ...attention);
  const controls = formatSnapshotControls(document, tree);
  if (controls.length > 0) {
    lines.push("", "Controls (runtime-approved capability; not a recommendation):", ...controls);
  }
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

function formatInspectionTree(tree: RunInspectionTree, showAllRefs = false): string[] {
  if (tree.roots.length === 0) return ["  (empty workflow)"];
  const lines: string[] = [];
  const visit = (
    entry: RunInspectionTreeEntry,
    prefix: string,
    last: boolean,
    firstRoot = false,
    insideFold = false,
  ): void => {
    const item = entry.type === "fold" ? entry.representative.item : entry.item;
    const connector = terminalTreeConnector(entry.type === "fold" ? "region" : treeEdge(item), last, firstRoot);
    const forceRef = !insideFold && entry.type === "item" && entry.children.some(child => child.type === "fold");
    const row = entry.type === "fold"
      ? formatFoldTreeItem(entry)
      : formatTreeItem(item, showAllRefs, forceRef, insideFold);
    lines.push(`${prefix}${connector} ${row}`);
    const nested = entry.type === "fold" ? entry.representative.children : entry.children;
    const childPrefix = terminalTreeChildPrefix(prefix, last);
    nested.forEach((child, index) => visit(child, childPrefix, index === nested.length - 1, false, insideFold || entry.type === "fold"));
  };
  tree.roots.forEach((root, index) => visit(root, "", index === tree.roots.length - 1, index === 0));
  return lines;
}

function treeEdge(item: RunInspectionItem): TerminalTreeEdge {
  return item.scope || item.role === "context" ? "region" : "node";
}

function formatTreeItem(item: RunInspectionItem, showAllRefs: boolean, forceRef = false, suppressRef = false): string {
  const parts = [`${statusGlyph(item.status)} ${item.label}`];
  const selector = item.ref ?? (forceRef && item.role === "static" ? item.nodeId : undefined);
  const showRef = !suppressRef && (forceRef
    || showAllRefs
    || item.status === "starting"
    || item.status === "running"
    || item.status === "awaiting"
    || failureStatus(item.status));
  if (item.scope) {
    if (item.scope.kind === "branch" && item.scope.ownerKind !== "parallel") {
      parts.push(item.scope.selection.replace("_", " "));
      if (item.scope.selection === "selected" && item.status !== "completed") parts.push(displayTreeStatus(item.status));
    }
    else if (item.status !== "completed") parts.push(displayTreeStatus(item.status));
    if (item.scope.empty) parts.push("empty");
    if (selector && showRef) {
      parts.push(selector);
    }
    return parts.join(" · ");
  }

  parts.push(item.kind === "agent" && item.agent ? `agent(${item.agent.key})` : item.kind);
  if (selector && showRef) {
    parts.push(selector);
  }
  if (item.status !== "completed") parts.push(displayTreeStatus(item.status));
  const progress = treeProgress(item);
  if (progress) parts.push(progress);
  if ((item.status === "starting" || item.status === "running") && item.agent) {
    const pulse = formatAgentPulse(item.agent);
    if (pulse) parts.push(pulse);
  }
  return parts.join(" · ");
}

function formatFoldTreeItem(fold: RunInspectionTreeFold): string {
  const item = fold.representative.item;
  const parts = [`… ${formatFoldRange(fold)} ×${fold.count}`, statusGlyph(item.status)];
  if (item.status !== "completed") parts.push(displayTreeStatus(item.status));
  if (item.scope?.empty) parts.push("empty");
  return parts.join(" · ");
}

function formatFoldRange(fold: RunInspectionTreeFold): string {
  return fold.scope === "fanout_item"
    ? `item[${fold.range.start}–${fold.range.end}]`
    : `round ${fold.range.start}–${fold.range.end}`;
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

function formatAgentPulse(agent: AgentDecisionState): string {
  const fields = [
    agent.turn === undefined ? undefined : `turn ${agent.turn}`,
    agent.activeTool ? formatDecisionTool(agent.activeTool) : undefined,
  ].filter((value): value is string => value !== undefined);
  return fields.join(" · ");
}

function formatAttention(document: RunInspectionSnapshot, tree: RunInspectionTree): string[] {
  const lines: string[] = [];
  if (document.run.execution.state === "stale") {
    const reason = document.run.execution.reason?.replaceAll("_", " ") ?? "execution inactive";
    lines.push(`  ◆ run — stale: ${reason}`);
  }
  if (document.run.failure) {
    lines.push(`  ◆ run — ${formatFailure(document.run.failure, 240)}`);
    lines.push(`     Inspect: ${command("acpus", "runs", "inspect", document.run.id, "--target", "root")}`);
  }
  for (const candidate of inspectionTreeAttention(tree)) {
    const item = candidate.item.item;
    const subject = formatAttentionSubject(item, candidate.fold, tree.itemsByKey);
    if (item.status === "awaiting") {
      lines.push(`  ${statusGlyph(item.status)} ${subject} — waiting for input`);
      if (item.signal?.promptPreview) lines.push(`     Prompt: ${oneLine(item.signal.promptPreview, 240)}`);
      if (item.signal) {
        const schema = item.signal.outputSchema ? schemaSummary(item.signal.outputSchema) : item.signal.schemaSummary ?? "JSON string";
        lines.push(`     Expected payload: ${oneLine(schema, 240)}`);
      }
    } else {
      const detail = item.failure ? formatFailure(item.failure, 240) : displayStatus(item.status);
      lines.push(`  ${statusGlyph(item.status)} ${subject} — ${detail}`);
    }
    if (candidate.fold) {
      const owner = inspectionSelector(candidate.fold.owner);
      if (owner) {
        lines.push(`     Expand: ${command("acpus", "runs", "inspect", document.run.id, "--target", owner, "--all")}`);
      }
      continue;
    }
    if (item.status === "awaiting" && item.signal && item.ref) {
      const payload = item.signal.outputSchema || item.signal.schemaSummary ? "<json>" : "\"text\"";
      lines.push(`     Signal: ${command("acpus", "runs", "signal", document.run.id, "--target", item.ref, "--payload", payload)}`);
    }
  }
  return lines;
}

function formatAttentionSubject(
  item: RunInspectionItem,
  fold: RunInspectionTreeFold | undefined,
  itemsByKey: ReadonlyMap<string, RunInspectionItem>,
): string {
  if (!fold) return `${itemBreadcrumb(item, itemsByKey)}${item.ref ? `  ${item.ref}` : ""}`;
  const suffix = item.scope?.kind === fold.scope ? "" : ` › ${item.label}`;
  return `${formatFoldRange(fold)} ×${fold.count}${suffix}`;
}

type OverviewControlAction = Extract<RunInspectionOverviewAction, { kind: "retry" | "cancel" | "steer" }>;

function isOverviewControlAction(action: RunInspectionOverviewAction): action is OverviewControlAction {
  return action.kind === "retry" || action.kind === "cancel" || action.kind === "steer";
}

function formatSnapshotControls(document: RunInspectionSnapshot, tree: RunInspectionTree): string[] {
  const lines: string[] = [];
  const visit = (entries: readonly RunInspectionTreeEntry[]): void => {
    for (const entry of entries) {
      if (entry.type === "fold") {
        if (!foldHasControls(entry)) continue;
        lines.push(`  ${formatFoldRange(entry)} ×${entry.count}`);
        const owner = inspectionSelector(entry.owner);
        if (owner) lines.push(`     Expand: ${command("acpus", "runs", "inspect", document.run.id, "--target", owner, "--all")}`);
        continue;
      }
      const controls = entry.actions.filter(isOverviewControlAction);
      if (controls.length > 0) {
        const selector = inspectionSelector(entry.item);
        const subject = `${itemBreadcrumb(entry.item, tree.itemsByKey)}${selector ? `  ${selector}` : ""}`;
        lines.push(`  ${subject}`);
        lines.push(...controls.flatMap(action => formatOverviewControlCommand(action, entry.item, document.run.id)
          .map(commandLine => `     ${commandLine}`)));
      }
      visit(entry.children);
    }
  };
  visit(tree.roots);

  for (const action of document.availableActions) {
    if (action.kind !== "cancel" || action.itemKey !== undefined) continue;
    lines.push(`  Run\n     ${formatOverviewControlCommand(action, undefined, document.run.id)[0]}`);
  }
  return lines;
}

function foldHasControls(fold: RunInspectionTreeFold): boolean {
  const hasControls = (entry: RunInspectionTreeEntry): boolean => entry.type === "fold"
    ? hasControls(entry.representative)
    : entry.actions.some(isOverviewControlAction) || entry.children.some(hasControls);
  return hasControls(fold.representative);
}

function inspectionSelector(item: RunInspectionItem): string | undefined {
  return item.ref ?? (item.role === "static" ? item.nodeId : undefined);
}

function formatOverviewControlCommand(
  action: OverviewControlAction,
  item: RunInspectionItem | undefined,
  runId: string,
): string[] {
  const selector = item === undefined ? undefined : inspectionSelector(item);
  if (action.kind === "retry") {
    return selector ? [`Retry: ${command("acpus", "runs", "retry", runId, "--target", selector)}`] : [];
  }
  if (action.kind === "cancel") {
    return [`Cancel: ${command("acpus", "runs", "cancel", runId, ...(selector ? ["--target", selector] : []))}`];
  }
  if (!selector || item?.attemptNo === undefined) return [];
  return [`Steer: ${command("acpus", "runs", "steer", runId, "--target", `${selector}#${item.attemptNo}`, "--instruction", "<correction>")}`];
}

function failureStatus(status: RunInspectionStatus): boolean {
  return status === "failed" || status === "timed_out";
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

function formatFailure(failure: NonNullable<RunInspectionRunSummary["failure"]>, messageLimit: number): string {
  const layers = [
    `${failure.origin}${failure.code ? ` ${failure.code}` : ""}`,
    failure.upstream ? `acpx${failure.upstream.code ? ` ${failure.upstream.code}` : ""}` : undefined,
  ].filter((value): value is string => value !== undefined);
  return oneLine(`Error (${layers.join(" · ")}): ${failure.message}`, messageLimit);
}

function formatDecisionTool(tool: NonNullable<AgentDecisionState["activeTool"]>): string {
  return `${toolStatusGlyph(tool.status)} ${truncateToolCommand(tool.command)}`;
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

function formatHeader(run: RunInspectionRunSummary, nowMs: number): string {
  const duration = run.durationMs === undefined ? Math.max(0, nowMs - Date.parse(run.createdAt)) : run.durationMs;
  const lines = [`Run ${run.id}  ${run.name}  ${executionStatus(run)}  ${formatDurationMs(duration)}`];
  if (run.fork) {
    lines.push(`Fork: source=${run.fork.sourceRunId}${run.fork.unsafeReuse ? "  unsafe-reuse" : ""}`);
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

function prettyLines(value: unknown, indent: string): string[] {
  const json = JSON.stringify(value, null, 2) ?? String(value);
  return json.split("\n").map(line => `${indent}${line}`);
}

function oneLine(value: string, limit: number): string {
  const compact = stripVTControlCharacters(value).replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  const visible = Array.from(compact);
  return visible.length <= limit ? compact : `${visible.slice(0, limit - 1).join("")}…`;
}

function command(...argv: string[]): string {
  return renderShellCommand(argv);
}
