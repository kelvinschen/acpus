import { stripVTControlCharacters } from "node:util";
import type {
  InspectionCandidates,
  InspectionError,
  InspectionObservation,
  InspectionView,
  InspectionViewQuery,
} from "@acpus/runtime";
import { renderShellCommand } from "./shell-command.js";
import { terminalTreeChildPrefix, terminalTreeConnector, type TerminalTreeEdge } from "./terminal-tree.js";

export type InspectionCandidateView = { timeline?: boolean };

type RunView = Extract<InspectionView, { kind: "run" }>;
type TargetSummaryView = Extract<InspectionView, { kind: "target"; detail: "summary" }>;
type TargetTimelineView = Extract<InspectionView, { kind: "target"; detail: "timeline" }>;
type Run = RunView["run"];
type Counts = RunView["counts"];
type TreeEntry = RunView["tree"][number];
type VisibleState = TargetSummaryView["state"];
type Attention = NonNullable<TargetSummaryView["attention"]>;
type Activity = NonNullable<TargetTimelineView["current"]>;
type TimelineEntry = TargetTimelineView["recent"][number];
type Change = Extract<InspectionObservation, { kind: "update" }>["changes"][number];

export function formatInspectionView(
  view: InspectionView,
  options: { showAwait?: boolean } = {},
): string {
  const showAwait = options.showAwait !== false;
  if (view.kind === "run") return formatRunView(view, showAwait);
  return view.detail === "summary"
    ? formatTargetSummary(view, showAwait)
    : formatTargetTimeline(view, showAwait);
}

export function formatInspectionCandidates(
  document: InspectionCandidates,
  view: InspectionCandidateView = {},
): string {
  const paged = document.total > document.entries.length;
  const args = view.timeline ? ["--timeline"] : [];
  const lines = [
    `Run ${document.run.id}  ${document.run.status}`,
    `Target ${document.target}  matches=${document.total}${paged ? `  page=${document.page}` : ""}`,
    ...(document.entries.length === 0
      ? ["  (no occurrences on this page)"]
      : document.entries.flatMap(entry => [
        `  ${statusGlyph(entry.status)} ${entry.selector}  ${entry.breadcrumb}`,
        `     Select: ${command("acpus", "runs", "inspect", document.run.id, "--target", entry.selector, ...args)}`,
      ])),
    ...(document.nextPage === undefined
      ? []
      : [`Next: ${command("acpus", "runs", "inspect", document.run.id, "--target", document.target, ...args, "--page", String(document.nextPage))}`]),
  ];
  return `${lines.join("\n")}\n`;
}

export function formatInspectionChanges(changes: readonly Change[]): string {
  return changes.map(change => `  ${statusGlyph(change.state.status)} ${subjectText(change.subject.label, change.subject.selector)} · ${formatState(change.state)}${change.progress ? ` · ${formatProgress(change.progress)}` : ""}${change.reason ? ` · ${change.reason.replaceAll("-", " ")}` : ""}`).join("\n");
}

export function formatTimelineEntries(entries: readonly TimelineEntry[]): string {
  return entries.map(entry => `  ${formatTimelineEntry(entry)}`).join("\n");
}

export function inspectionRecoveryCommand(view: InspectionViewQuery): string {
  return command(
    "acpus",
    "runs",
    "inspect",
    view.runId,
    ...(view.kind === "target" ? ["--target", view.target] : []),
    ...(view.kind === "target" && view.detail === "timeline" ? ["--timeline"] : []),
  );
}

export function formatInspectionError(error: InspectionError, view: InspectionViewQuery): string {
  if (error.type === "invalid-query") return `${error.message}\n`;
  if (error.type === "target-ambiguous") {
    const detail = view.kind === "target" && view.detail === "timeline";
    return `${formatInspectionCandidates(error.candidates, { timeline: detail }).trimEnd()}\nCannot attach: ${error.message}\n`;
  }
  return `Inspection failed: ${error.message}\nInspect: ${inspectionRecoveryCommand(view)}\n`;
}

function formatRunView(view: RunView, showAwait: boolean): string {
  const lines = [
    formatRunHeader(view.run),
    `Counts total=${view.counts.total}${formatCounts(view.counts)}`,
    "",
    "Tree:",
    ...formatTree(view.tree),
  ];
  const attention = treeAttention(view.tree);
  if (attention.length > 0) lines.push("", "Attention:", ...attention.flatMap(entry => formatTreeAttention(entry, view.run.id)));
  if (showAwait && !terminal(view.run.status) && view.run.status !== "paused" && !attention.some(entry => entry.attention?.kind === "awaiting-input")) {
    lines.push("", `Await: ${command("acpus", "runs", "inspect", view.run.id, "--await-decision")}`);
  }
  if (view.output !== undefined) lines.push("", "Output:", ...formatJson(view.output, "  "));
  return `${lines.join("\n")}\n`;
}

function formatTargetSummary(view: TargetSummaryView, showAwait: boolean): string {
  const lines = [
    `Run ${view.run.id}  ${view.run.status}`,
    `Target ${subjectText(view.subject.label, view.subject.selector)} · ${view.subject.kind}`,
    `State ${formatState(view.state)}`,
    ...(view.pulse === undefined ? [] : [`Pulse ${formatPulse(view.pulse)}`]),
    ...(view.acp === undefined ? [] : [`ACP silent for ${formatDurationMs(view.acp.silentForMs)}`]),
    ...(view.attention === undefined ? [] : formatAttention(view.attention, view.run.id)),
    ...(view.visibility === undefined ? [] : [formatVisibility(view.visibility.reason)]),
    ...(view.occurrences === undefined ? [] : [`Occurrences total=${view.occurrences.total}${formatCounts(view.occurrences)}`]),
    ...formatTargetNavigation(view, showAwait),
  ];
  return `${lines.join("\n")}\n`;
}

function formatTargetTimeline(view: TargetTimelineView, showAwait: boolean): string {
  const lines = [
    `Run ${view.run.id}  ${view.run.status}`,
    `Timeline ${subjectText(view.subject.label, view.subject.selector)} · ${view.subject.kind}`,
    `State ${formatState(view.state)}`,
    ...(view.visibility === undefined ? [] : [formatVisibility(view.visibility.reason)]),
    ...(view.current === undefined ? [] : ["Current:", `  ${formatActivity(view.current)}`]),
    "Recent:",
    ...(view.recent.length === 0 ? ["  (no recent activity)"] : formatTimelineEntries(view.recent).split("\n")),
    ...formatTimelineNavigation(view, showAwait),
  ];
  return `${lines.join("\n")}\n`;
}

function formatRunHeader(run: Run): string {
  const parts = [`Run ${run.id}`, run.name, run.status, run.durationMs === undefined ? undefined : formatDurationMs(run.durationMs)].filter((part): part is string => part !== undefined);
  const lines = [parts.join("  ")];
  if (run.liveness && run.liveness !== "active" && run.liveness !== "terminal") lines.push(`Liveness ${run.liveness}`);
  if (run.fork) lines.push(`Fork: source=${run.fork.sourceRunId}${run.fork.unsafeReuse ? "  unsafe-reuse" : ""}`);
  if (run.failure) lines.push(formatFailure(run.failure));
  return lines.join("\n");
}

function formatTree(tree: readonly TreeEntry[]): string[] {
  if (tree.length === 0) return ["  (empty workflow)"];
  const lines: string[] = [];
  const visit = (entry: TreeEntry, prefix: string, last: boolean, firstRoot: boolean): void => {
    const edge: TerminalTreeEdge = entry.type === "fold" ? "region" : "node";
    lines.push(`${prefix}${terminalTreeConnector(edge, last, firstRoot)} ${formatTreeEntry(entry)}`);
    const childPrefix = terminalTreeChildPrefix(prefix, last);
    entry.children.forEach((child, index) => visit(child, childPrefix, index === entry.children.length - 1, false));
  };
  tree.forEach((entry, index) => visit(entry, "", index === tree.length - 1, index === 0));
  return lines;
}

function formatTreeEntry(entry: TreeEntry): string {
  if (entry.type === "fold") {
    const range = entry.scope === "fanout-items"
      ? `item[${entry.range.start}–${entry.range.end}]`
      : `round ${entry.range.start}–${entry.range.end}`;
    return `… ${range} ×${entry.count} · ${statusGlyph(entry.state.status)} · ${formatState(entry.state)}`;
  }
  const fields = [
    `${statusGlyph(entry.state.status)} ${entry.subject.label}`,
    entry.subject.kind,
    entry.subject.selector,
    formatState(entry.state),
    entry.progress === undefined ? undefined : formatProgress(entry.progress),
    entry.pulse === undefined ? undefined : formatPulse(entry.pulse),
  ].filter((field): field is string => field !== undefined);
  return fields.join(" · ");
}

function treeAttention(tree: readonly TreeEntry[]): Array<Extract<TreeEntry, { type: "item" }>> {
  const items: Array<Extract<TreeEntry, { type: "item" }>> = [];
  const visit = (entries: readonly TreeEntry[]): void => {
    for (const entry of entries) {
      if (entry.type === "item" && entry.attention) items.push(entry);
      visit(entry.children);
    }
  };
  visit(tree);
  return items;
}

function formatTreeAttention(entry: Extract<TreeEntry, { type: "item" }>, runId: string): string[] {
  const attention = entry.attention!;
  const subject = subjectText(entry.subject.label, entry.subject.selector);
  if (attention.kind === "awaiting-input") {
    return [
      `  ${statusGlyph("awaiting")} ${subject} — ${attention.summary}`,
      ...(attention.prompt === undefined ? [] : [`     Prompt: ${oneLine(attention.prompt)}`]),
      ...(attention.expected === undefined ? [] : [`     Expected: ${oneLine(attention.expected)}`]),
      `     Signal: ${signalCommand(runId, attention.signal)}`,
      ...(entry.subject.selector === undefined ? [] : [`     Timeline: ${command("acpus", "runs", "inspect", runId, "--target", entry.subject.selector, "--timeline")}`]),
    ];
  }
  return [
    `  ${statusGlyph(entry.state.status)} ${subject} — ${attention.summary}`,
    ...(entry.subject.selector === undefined ? [] : [`     Timeline: ${command("acpus", "runs", "inspect", runId, "--target", entry.subject.selector, "--timeline")}`]),
  ];
}

function formatAttention(attention: Attention, runId: string): string[] {
  if (attention.kind === "awaiting-input") {
    return [
      `Attention ${attention.summary}`,
      ...(attention.prompt === undefined ? [] : [`Prompt ${oneLine(attention.prompt)}`]),
      ...(attention.expected === undefined ? [] : [`Expected ${oneLine(attention.expected)}`]),
      `Signal: ${signalCommand(runId, attention.signal)}`,
    ];
  }
  return [`Attention ${attention.summary}`];
}

function formatTargetNavigation(view: TargetSummaryView, showAwait: boolean): string[] {
  const selector = view.subject.selector;
  const boundary = view.attention?.kind === "awaiting-input";
  return [
    ...(selector && (!terminal(view.state.status) || view.attention) ? [`Timeline: ${command("acpus", "runs", "inspect", view.run.id, "--target", selector, "--timeline")}`] : []),
    ...(showAwait && selector && view.run.status !== "paused" && !terminal(view.state.status) && !boundary ? [`Await: ${command("acpus", "runs", "inspect", view.run.id, "--target", selector, "--await-decision")}`] : []),
  ];
}

function formatTimelineNavigation(view: TargetTimelineView, showAwait: boolean): string[] {
  if (terminal(view.state.status)) return [];
  if (view.current?.kind === "signal") return [`Signal: ${signalCommand(view.run.id, view.current.signal)}`];
  if (!showAwait || view.run.status === "paused") return [];
  return view.subject.selector === undefined
    ? []
    : [`Await: ${command("acpus", "runs", "inspect", view.run.id, "--target", view.subject.selector, "--timeline", "--await-decision")}`];
}

function formatState(state: VisibleState): string {
  const status = displayStatus(state.status);
  const duration = state.durationMs === undefined ? undefined : formatDurationMs(state.durationMs);
  const failure = state.failure === undefined ? undefined : formatFailure(state.failure);
  return [status, duration, failure].filter((part): part is string => part !== undefined).join(" · ");
}

function formatPulse(pulse: { phase: string; turn?: number; headline?: string }): string {
  return [pulse.phase.replaceAll("-", " "), pulse.turn === undefined ? undefined : `turn ${pulse.turn}`, pulse.headline === undefined ? undefined : oneLine(pulse.headline)].filter((part): part is string => part !== undefined).join(" · ");
}

function formatActivity(activity: Activity): string {
  const fields = [
    activity.kind,
    activity.phase.replaceAll("-", " "),
    activity.kind === "agent" && activity.turn !== undefined ? `turn ${activity.turn}` : undefined,
    activity.kind === "signal" && activity.prompt !== undefined ? oneLine(activity.prompt) : undefined,
    activity.kind === "signal" && activity.expected !== undefined ? `expected ${oneLine(activity.expected)}` : undefined,
    activity.kind !== "signal" && activity.headline !== undefined ? oneLine(activity.headline) : undefined,
  ].filter((part): part is string => part !== undefined);
  return fields.join(" · ");
}

function formatTimelineEntry(entry: TimelineEntry): string {
  if (entry.kind === "transition") return `${entry.at}  ${entry.action}${entry.status ? `/${displayStatus(entry.status)}` : ""}${entry.attempt === undefined ? "" : `  attempt=${entry.attempt}`}${entry.summary === undefined ? "" : `  ${oneLine(entry.summary)}`}`;
  if (entry.kind === "activity") return `${entry.at}  ${entry.channel}${entry.attempt === undefined ? "" : `  attempt=${entry.attempt}`}${entry.turn === undefined ? "" : `  turn=${entry.turn}`}  ${oneLine(entry.summary)}`;
  if (entry.kind === "control") return `${entry.at}  ${entry.action}${entry.attempt === undefined ? "" : `  attempt=${entry.attempt}`}`;
  if (entry.kind === "phase") return `${entry.at}  phase ${entry.phase.replaceAll("-", " ")}${entry.attempt === undefined ? "" : `  attempt=${entry.attempt}`}${entry.turn === undefined ? "" : `  turn=${entry.turn}`}`;
  if (entry.kind === "visibility") return `${entry.at}  Visibility ${entry.state}${entry.reason === undefined ? "" : `/${entry.reason}`}`;
  return `${entry.at}  gap  dropped=${entry.dropped}  ${oneLine(entry.reason)}`;
}

function formatCounts(counts: Counts): string {
  const fields: Array<[keyof Counts, string]> = [
    ["notStarted", "not-started"], ["notSelected", "not-selected"], ["pending", "pending"], ["starting", "starting"], ["ready", "ready"], ["running", "running"], ["awaiting", "awaiting"], ["completed", "completed"], ["failed", "failed"], ["timedOut", "timed-out"], ["cancelled", "canceled"], ["mixed", "mixed"],
  ];
  return fields.flatMap(([key, label]) => counts[key] === undefined ? [] : [`  ${label}=${counts[key]}`]).join("");
}

function formatProgress(progress: { completed: number; total: number }): string {
  return `${progress.completed}/${progress.total}`;
}

function formatFailure(failure: { origin: string; code?: string; message: string }): string {
  return `Error (${failure.origin}${failure.code ? ` ${failure.code}` : ""}): ${oneLine(failure.message)}`;
}

function formatVisibility(reason: string): string {
  return `Visibility degraded/${reason}  Inspection may be incomplete.`;
}

function signalCommand(runId: string, target: string): string {
  return command("acpus", "runs", "signal", runId, "--target", target, "--payload", "<json>");
}

function subjectText(label: string, selector: string | undefined): string {
  return selector === undefined || selector === label ? label : `${label}  ${selector}`;
}

function terminal(status: string): boolean {
  return status === "completed" || status === "failed" || status === "timed_out" || status === "cancelled" || status === "canceled";
}

function displayStatus(status: string): string {
  return status.replaceAll("_", " ").replaceAll("-", " ");
}

function statusGlyph(status: string): string {
  if (status === "completed") return "✓";
  if (status === "failed" || status === "timed_out") return "◆";
  if (status === "cancelled" || status === "canceled" || status === "not_selected") return "✗";
  if (status === "awaiting") return "⏳";
  if (status === "running" || status === "starting" || status === "ready") return "⠋";
  return "○";
}

export function formatDurationMs(value: number): string {
  if (value < 1_000) return `${Math.max(0, Math.floor(value))}ms`;
  const seconds = Math.floor(value / 1_000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h${minutes % 60}m`;
}

function formatJson(value: unknown, prefix: string): string[] {
  const rendered = JSON.stringify(value, null, 2);
  return (rendered === undefined ? "null" : rendered).split("\n").map(line => `${prefix}${line}`);
}

function oneLine(value: string, limit = 240): string {
  const compact = stripVTControlCharacters(value).replace(/\s+/gu, " ").trim();
  return Array.from(compact).length <= limit ? compact : `${Array.from(compact).slice(0, Math.max(1, limit - 1)).join("")}…`;
}

function command(...argv: string[]): string {
  return renderShellCommand(argv);
}
