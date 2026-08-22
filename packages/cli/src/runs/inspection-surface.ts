import { stripVTControlCharacters } from "node:util";
import type {
  InspectionCandidates,
  InspectionError,
  InspectionObservation,
  InspectionView,
  InspectionViewQuery,
} from "@acpus/runtime";
import { renderShellCommand } from "../presentation/shell-command.js";
import { terminalTreeChildPrefix, terminalTreeConnector, type TerminalTreeEdge } from "../presentation/terminal-tree.js";

type RunView = Extract<InspectionView, { kind: "run" }>;
type TargetSummaryView = Extract<InspectionView, { kind: "target"; detail: "summary" }>;
type TargetTimelineView = Extract<InspectionView, { kind: "target"; detail: "timeline" }>;
type TargetForensicsView = Extract<InspectionView, { kind: "target"; detail: "forensics" }>;
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
  if (view.detail === "summary") return formatTargetSummary(view, showAwait);
  if (view.detail === "timeline") return formatTargetTimeline(view, showAwait);
  return formatTargetForensics(view);
}

export function formatInspectionCandidates(document: InspectionCandidates): string {
  const lines = [
    `Run ${document.run.id}  ${document.run.status}`,
    `Target ${document.target}  matches=${document.entries.length}`,
    ...document.entries.map(entry => `  ${statusGlyph(entry.status)} ${entry.selector}  ${entry.breadcrumb}`),
  ];
  return `${lines.join("\n")}\n`;
}

export function formatInspectionChanges(changes: readonly Change[], runId: string): string {
  return changes.flatMap(change => {
    const lines = [
      `  ${statusGlyph(change.state.status)} ${subjectText(change.subject.label, change.subject.selector)} · ${formatState(change.state)}${change.progress ? ` · ${formatProgress(change.progress)}` : ""}${change.occurrences ? ` · occurrences total=${change.occurrences.total}${formatCounts(change.occurrences)}` : ""}${change.reason ? ` · ${change.reason.replaceAll("-", " ")}` : ""}`,
    ];
    if (change.attention?.kind === "awaiting-input") {
      const prompt = change.attention.prompt === undefined ? undefined : oneLine(change.attention.prompt);
      const summary = oneLine(change.attention.summary);
      lines.push(
        `     Attention ${summary}`,
        ...(prompt === undefined || prompt === summary ? [] : [`     Prompt ${prompt}`]),
        ...(change.attention.expected === undefined ? [] : [`     Expected ${oneLine(change.attention.expected)}`]),
        `     Signal: ${signalCommand(runId, change.attention.signal)}`,
      );
    } else if (change.attention && !sameText(change.attention.summary, change.state.failure?.message)) {
      lines.push(`     Attention ${oneLine(change.attention.summary)}`);
    }
    if (change.visibility) lines.push(`     ${formatVisibility(change.visibility.reason)}`);
    return lines;
  }).join("\n");
}

export function formatTimelineEntries(
  entries: readonly TimelineEntry[],
  selector?: string,
): string {
  const exactAttempt = selectorAttempt(selector);
  if (exactAttempt !== undefined) {
    return entries.map(entry => `  ${formatTimelineEntry(entry, exactAttempt)}`).join("\n");
  }
  const attempts = new Set(entries.flatMap(entry => {
    const attempt = timelineAttempt(entry);
    return attempt === undefined ? [] : [attempt];
  }));
  if (attempts.size < 2 && ![...attempts].some(attempt => attempt > 1)) {
    return entries.map(entry => `  ${formatTimelineEntry(entry)}`).join("\n");
  }
  const lines: string[] = [];
  let activeAttempt: number | undefined;
  for (const entry of entries) {
    const attempt = timelineAttempt(entry);
    if (attempt === undefined) {
      activeAttempt = undefined;
      lines.push(`  ${formatTimelineEntry(entry)}`);
      continue;
    }
    if (attempt !== activeAttempt) lines.push(`  Attempt ${attempt}:`);
    lines.push(`    ${formatTimelineEntry(entry, attempt)}`);
    activeAttempt = attempt;
  }
  return lines.join("\n");
}

export function inspectionRecoveryCommand(view: InspectionViewQuery): string {
  return command(
    "acpus",
    "runs",
    "inspect",
    view.runId,
    ...(view.kind === "target" ? ["--target", view.target] : []),
    ...(view.kind === "target" && view.detail === "timeline" ? ["--timeline"] : []),
    ...(view.kind === "target" && view.detail === "forensics" ? ["--forensics"] : []),
  );
}

export function formatInspectionError(error: InspectionError, view: InspectionViewQuery): string {
  if (error.type === "invalid-query") return `${error.message}\n`;
  if (error.type === "runtime-store-repair-required") {
    return `${error.message}\nError code: RUNTIME_STORE_REPAIR_REQUIRED\n`;
  }
  if (error.type === "runtime-store-unsupported") {
    return `${error.message}\nRun: acpus doctor\nError code: RUNTIME_STORE_UNSUPPORTED\n`;
  }
  if (error.type === "archived-run-detail-unavailable") {
    return `${error.message}\nError code: ARCHIVED_RUN_DETAIL_UNAVAILABLE\n`;
  }
  if (error.type === "archived-run-lookup-unavailable") {
    return `${error.message}\nError code: ARCHIVED_RUN_LOOKUP_UNAVAILABLE\n`;
  }
  if (error.type === "target-ambiguous") {
    return `${formatInspectionCandidates(error.candidates).trimEnd()}\nCannot attach: ${error.message}\n`;
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
  const pulse = terminal(view.state.status) || view.pulse === undefined
    ? undefined
    : formatSummaryPulse(view.state.status, view.pulse);
  const lines = [
    `Run ${view.run.id}  ${view.run.status}`,
    `Target ${subjectText(view.subject.label, view.subject.selector)} · ${view.subject.kind}`,
    `State ${formatState(view.state)}`,
    ...formatTargetResult(view.result),
    ...(pulse === undefined ? [] : [pulse]),
    ...(terminal(view.state.status) || view.acp === undefined ? [] : [`ACP silent for ${formatDurationMs(view.acp.silentForMs)}`]),
    ...(view.attention === undefined ? [] : formatAttention(view.attention, view.run.id, view.state.failure?.message)),
    ...(view.visibility === undefined ? [] : [formatVisibility(view.visibility.reason)]),
    ...(view.occurrences === undefined ? [] : [`Occurrences total=${view.occurrences.total}${formatCounts(view.occurrences)}`]),
    ...formatTargetNavigation(view, showAwait),
  ];
  return `${lines.join("\n")}\n`;
}

function formatTargetResult(result: TargetSummaryView["result"]): string[] {
  if (result?.status === "accepted") return ["Output:", ...formatJson(result.value, "  ")];
  if (result?.status === "completed_without_output") return ["Result completed without output"];
  return result?.status === "not_accepted" ? ["Result not accepted"] : [];
}

function formatTargetTimeline(view: TargetTimelineView, showAwait: boolean): string {
  const activity = view.current === undefined
    ? undefined
    : formatActivity(view.current, view.subject.kind, view.state.status);
  const lines = [
    `Run ${view.run.id}  ${view.run.status}`,
    `Timeline ${subjectText(view.subject.label, view.subject.selector)} · ${view.subject.kind}`,
    `State ${formatState(view.state)}`,
    ...(view.visibility === undefined ? [] : [formatVisibility(view.visibility.reason)]),
    ...(activity === undefined ? [] : [`${activity.heading}:`, `  ${activity.text}`]),
    "Recent:",
    ...(view.recent.length === 0
      ? ["  (no recent activity)"]
      : formatTimelineEntries(view.recent, view.subject.selector).split("\n")),
    ...formatTimelineNavigation(view, showAwait),
  ];
  return `${lines.join("\n")}\n`;
}

function formatTargetForensics(view: TargetForensicsView): string {
  const lines = [
    `Run ${view.run.id}  ${view.run.status}`,
    `Forensics ${subjectText(view.subject.label, view.subject.selector)} · ${view.subject.kind}`,
    `State ${formatState(view.state)}`,
    "",
    "Definition:",
    ...formatForensicsValue(view.definition, "  "),
    "",
    "Invocation:",
    ...formatForensicsValue(view.invocation, "  "),
    "",
    "Result:",
    ...formatForensicsValue(view.result, "  "),
  ];
  return `${lines.join("\n")}\n`;
}

function formatRunHeader(run: Run): string {
  const parts = [`Run ${run.id}`, run.name, run.status, run.durationMs === undefined ? undefined : formatDurationMs(run.durationMs)].filter((part): part is string => part !== undefined);
  const lines = [parts.join("  ")];
  if (run.liveness && run.liveness !== "active" && run.liveness !== "terminal") lines.push(`Liveness ${run.liveness}`);
  if (run.fork) lines.push(`Fork: source=${run.fork.sourceRunId}`);
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
  const pulse = entry.pulse === undefined
    ? undefined
    : formatPulse(entry.pulse, terminal(entry.state.status) && entry.pulse.phase === "settled");
  const fields = [
    `${statusGlyph(entry.state.status)} ${entry.subject.label}`,
    entry.subject.kind,
    entry.subject.selector === entry.subject.label ? undefined : entry.subject.selector,
    formatState(entry.state),
    entry.progress === undefined ? undefined : formatProgress(entry.progress),
    pulse,
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
    const prompt = attention.prompt === undefined ? undefined : oneLine(attention.prompt);
    const summary = oneLine(attention.summary);
    return [
      `  ${statusGlyph("awaiting")} ${subject} — ${summary}`,
      ...(prompt === undefined || prompt === summary ? [] : [`     Prompt: ${prompt}`]),
      ...(attention.expected === undefined ? [] : [`     Expected: ${oneLine(attention.expected)}`]),
      `     Signal: ${signalCommand(runId, attention.signal)}`,
      ...(entry.subject.selector === undefined ? [] : [`     Timeline: ${command("acpus", "runs", "inspect", runId, "--target", entry.subject.selector, "--timeline")}`]),
    ];
  }
  const summary = sameText(attention.summary, entry.state.failure?.message)
    ? ""
    : ` — ${oneLine(attention.summary)}`;
  return [
    `  ${statusGlyph(entry.state.status)} ${subject}${summary}`,
    ...(entry.subject.selector === undefined ? [] : [`     Timeline: ${command("acpus", "runs", "inspect", runId, "--target", entry.subject.selector, "--timeline")}`]),
  ];
}

function formatAttention(attention: Attention, runId: string, failureMessage?: string): string[] {
  if (attention.kind === "awaiting-input") {
    const prompt = attention.prompt === undefined ? undefined : oneLine(attention.prompt);
    const summary = oneLine(attention.summary);
    return [
      `Attention ${summary}`,
      ...(prompt === undefined || prompt === summary ? [] : [`Prompt ${prompt}`]),
      ...(attention.expected === undefined ? [] : [`Expected ${oneLine(attention.expected)}`]),
      `Signal: ${signalCommand(runId, attention.signal)}`,
    ];
  }
  return sameText(attention.summary, failureMessage) ? [] : [`Attention ${oneLine(attention.summary)}`];
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

function formatSummaryPulse(
  status: string,
  pulse: { phase: string; turn?: number; headline?: string },
): string | undefined {
  const settled = terminal(status) && pulse.phase === "settled";
  const text = formatPulse(pulse, settled);
  return text === undefined ? undefined : `${settled ? "Last" : "Pulse"} ${text}`;
}

function formatPulse(
  pulse: { phase: string; turn?: number; headline?: string },
  omitSettled = false,
): string | undefined {
  const phase = omitSettled && pulse.phase === "settled"
    ? visibleHeadline(pulse.phase, pulse.headline)
    : formatAgentPhase(pulse.phase, pulse.headline);
  const fields = [formatTurn(pulse.turn), phase].filter((part): part is string => part !== undefined);
  return fields.length === 0 ? undefined : fields.join(" · ");
}

function formatActivity(
  activity: Activity,
  subjectKind: string,
  stateStatus: string,
): { heading: "Current" | "Last"; text: string } | undefined {
  const kind = activity.kind === subjectKind ? undefined : activity.kind;
  if (activity.kind === "agent") {
    const settled = terminal(stateStatus) && activity.phase === "settled";
    const headline = visibleHeadline(activity.phase, activity.headline);
    const turn = formatTurn(activity.turn);
    if (kind === undefined && turn === undefined && headline === undefined && (settled || impliedPhase(stateStatus, activity.phase))) return undefined;
    return {
      heading: settled ? "Last" : "Current",
      text: [
        kind,
        turn,
        settled ? headline : formatAgentPhase(activity.phase, activity.headline),
      ].filter((part): part is string => part !== undefined).join(" · "),
    };
  }
  const headline = activity.kind !== "signal"
    ? visibleHeadline(activity.phase, activity.headline)
    : undefined;
  const prompt = activity.kind === "signal" && activity.prompt !== undefined
    ? oneLine(activity.prompt)
    : undefined;
  const expected = activity.kind === "signal" && activity.expected !== undefined
    ? `expected ${oneLine(activity.expected)}`
    : undefined;
  if (kind === undefined && headline === undefined && prompt === undefined && expected === undefined && impliedPhase(stateStatus, activity.phase)) return undefined;
  const fields = [
    kind,
    activity.phase.replaceAll("-", " "),
    prompt,
    expected,
    headline,
  ].filter((part): part is string => part !== undefined);
  return { heading: "Current", text: fields.join(" · ") };
}

function formatAgentPhase(phase: string, headline?: string): string {
  const label = displayAgentPhase(phase);
  const visible = visibleHeadline(phase, headline);
  return visible === undefined ? label : `${label}: ${visible}`;
}

function displayAgentPhase(phase: string): string {
  if (phase === "reported-thought") return "thinking";
  if (phase === "tool") return "using tool";
  if (phase === "output-repair") return "repairing output";
  if (phase === "settling") return "finishing";
  return phase.replaceAll("-", " ");
}

function formatTimelineEntry(entry: TimelineEntry, impliedAttempt?: number): string {
  if (entry.kind === "transition") {
    const status = entry.status === undefined || entry.status === impliedTransitionStatus(entry.action)
      ? ""
      : `/${displayStatus(entry.status)}`;
    return `${entry.at}  ${entry.action}${status}${formatAttempt(entry.attempt, impliedAttempt)}${entry.summary === undefined ? "" : `  ${oneLine(entry.summary)}`}`;
  }
  if (entry.kind === "activity") return `${entry.at}  ${entry.channel}${formatAttempt(entry.attempt, impliedAttempt)}${formatTimelineTurn(entry.turn)}  ${oneLine(entry.summary)}`;
  if (entry.kind === "control") return `${entry.at}  ${entry.action}${formatAttempt(entry.attempt, impliedAttempt)}`;
  if (entry.kind === "phase") return `${entry.at}  phase ${entry.phase.replaceAll("-", " ")}${formatAttempt(entry.attempt, impliedAttempt)}${formatTimelineTurn(entry.turn)}`;
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
  return status === "completed" || status === "failed" || status === "timed_out" || status === "cancelled" || status === "canceled" || status === "not_selected";
}

function impliedPhase(status: string, phase: string): boolean {
  return displayStatus(status) === displayStatus(phase) || terminal(status) && phase === "settled";
}

function impliedTransitionStatus(action: Extract<TimelineEntry, { kind: "transition" }>["action"]): string {
  if (action === "started" || action === "resumed") return "running";
  if (action === "retry") return "pending";
  if (action === "steer") return "ready";
  return action === "timed-out" ? "timed_out" : action;
}

function formatTurn(turn: number | undefined): string | undefined {
  return turn !== undefined && turn > 1 ? `turn ${turn}` : undefined;
}

function formatAttempt(attempt: number | undefined, impliedAttempt?: number): string {
  return attempt !== undefined && attempt !== impliedAttempt && (impliedAttempt !== undefined || attempt > 1)
    ? `  attempt=${attempt}`
    : "";
}

function formatTimelineTurn(turn: number | undefined): string {
  return turn !== undefined && turn > 1 ? `  turn=${turn}` : "";
}

function timelineAttempt(entry: TimelineEntry): number | undefined {
  return "attempt" in entry ? entry.attempt : undefined;
}

function selectorAttempt(selector: string | undefined): number | undefined {
  const value = selector?.match(/#([1-9]\d*)$/u)?.[1];
  if (value === undefined) return undefined;
  const attempt = Number(value);
  return Number.isSafeInteger(attempt) ? attempt : undefined;
}

function visibleHeadline(phase: string, headline: string | undefined): string | undefined {
  if (headline === undefined) return undefined;
  const visible = oneLine(headline);
  return visible.length === 0 || visible === phase.replaceAll("-", " ") ? undefined : visible;
}

function sameText(left: string | undefined, right: string | undefined): boolean {
  return left !== undefined && right !== undefined && oneLine(left) === oneLine(right);
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

function formatForensicsValue(value: unknown, prefix: string): string[] {
  const blocks: Array<{ path: string; value: string }> = [];
  const visit = (current: unknown, path: string): unknown => {
    if (typeof current === "string" && current.includes("\n")) {
      blocks.push({ path, value: current });
      return `<multiline:${path}>`;
    }
    if (Array.isArray(current)) return current.map((item, index) => visit(item, `${path}[${index}]`));
    if (current && typeof current === "object") {
      return Object.fromEntries(Object.entries(current).map(([key, item]) => [key, visit(item, forensicsPropertyPath(path, key))]));
    }
    return current;
  };
  const rendered = JSON.stringify(visit(value, ""), null, 2) ?? "null";
  const lines = rendered.split("\n").map(line => `${prefix}${escapeForensicsControls(line)}`);
  for (const block of blocks) {
    lines.push("", `${prefix}${escapeForensicsControls(block.path)}: |`, ...block.value.split("\n").map(line => `${prefix}  ${safeForensicsLine(line)}`));
  }
  return lines;
}

function forensicsPropertyPath(path: string, key: string): string {
  if (/^[A-Za-z_$][\w$]*$/u.test(key)) return path ? `${path}.${key}` : key;
  return `${path}[${JSON.stringify(key)}]`;
}

function safeForensicsLine(value: string): string {
  return escapeForensicsControls(value.replaceAll("\\", "\\\\"));
}

function escapeForensicsControls(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/gu, character =>
    `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

function oneLine(value: string, limit = 240): string {
  const compact = stripVTControlCharacters(value).replace(/\s+/gu, " ").trim();
  return Array.from(compact).length <= limit ? compact : `${Array.from(compact).slice(0, Math.max(1, limit - 1)).join("")}…`;
}

function command(...argv: string[]): string {
  return renderShellCommand(argv);
}
