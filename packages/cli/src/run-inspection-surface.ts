import { stripVTControlCharacters } from "node:util";
import type { SchemaIR } from "@acpus/core/ir";
import type {
  AgentInspectionState,
  AgentAttemptEvidenceCapsule,
  FollowableInspectionDocument,
  RunInspectionChange,
  RunInspectionAction,
  RunInspectionCurrentActivity,
  RunInspectionCurrentActivityPatch,
  RunInspectionDelta,
  RunInspectionDocument,
  RunInspectionEmission,
  RunInspectionExcerpt,
  RunInspectionItem,
  RunInspectionOverviewAction,
  RunInspectionRunSummary,
  RunInspectionSnapshot,
  RunInspectionStatus,
  RunInspectionStatusCounts,
  RunInspectionTargetDetailsDocument,
  RunInspectionTargetSummaryDocument,
  RunInspectionTimelineDocument,
  RunInspectionTimelineEntry,
  RunInspectionToolActivity,
  RunInspectionVisibility,
} from "@acpus/runtime";
import { terminalTreeChildPrefix, terminalTreeConnector, type TerminalTreeEdge } from "./terminal-tree.js";

type RunInspectionDeltaEmission = Extract<RunInspectionEmission, { kind: "delta" }>;
type AgentDecisionState = NonNullable<RunInspectionItem["agent"]>;
type RecentTool = NonNullable<AgentInspectionState["tools"]>["recent"][number];
const targetSummaryTextBytes = 1536;

export function formatRunInspectionDocument(document: RunInspectionDocument, nowMs = Date.now()): string {
  if (document.kind === "raw") return "Raw run inspection is available only as JSON.\n";
  if (document.kind === "target") return formatTargetSummary(document);
  if (document.kind === "timeline") return formatTimeline(document);
  if (document.kind === "details") return formatTargetDetails(document, nowMs);
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
  } & (
    | { kind: "snapshot"; availableActions: readonly RunInspectionOverviewAction[] }
    | { kind: "target" }
  ),
): string {
  const items = new Map(context.items.map(item => [item.key, item]));
  const actions = indexActions(context.kind === "snapshot" ? context.availableActions : []);
  const suppressRootFailure = context.kind === "snapshot"
    && rootFailureWasPropagated(context.items, deepestAttentionCandidates(context.items, actions));
  const visible = changes.filter(change => {
    if (change.entity.kind !== "run") return true;
    if (change.action === "completed" || change.action === "cancelled") return false;
    if (change.action !== "failed" && change.action !== "timed_out") return true;
    return context.kind === "snapshot" && !suppressRootFailure;
  });
  const lines: string[] = [];
  let runLevelRecoveryTransition = false;
  for (const change of visible) {
    const item = change.itemKey ? items.get(change.itemKey) : undefined;
    const elapsed = elapsedSince(context.run.createdAt, change.at);
    const subject = change.subject || item?.label || change.entity.nodeId || change.entity.id;
    const state = changeState(change);
    const attempt = change.attemptNo === undefined ? "" : `  attempt=${change.attemptNo}`;
    const structuredFailure = item?.failure
      ?? (change.entity.kind === "run" && (change.action === "failed" || change.action === "timed_out")
        ? context.run.failure
        : undefined);
    const failure = structuredFailure && (change.action === "failed" || change.action === "timed_out")
      ? `  ${formatFailure(structuredFailure, 160)}`
      : "";
    const message = failure || (change.message ? `  ${oneLine(change.message, 160)}` : "");
    const progress = item?.agent ? formatAgentProgress(item.agent) : "";
    const agent = progress ? `  ${progress}` : "";
    lines.push(`+${elapsed}  ${subject}  ${state}${attempt}${agent}${message}`);
    const actionable = change.action === "awaiting" || change.action === "failed" || change.action === "timed_out";
    if (item && actionable) {
      runLevelRecoveryTransition ||= (actions.byItem.get(item.key) ?? []).some(action => action.kind === "retry");
      lines.push(...formatActionCommands(item, actions, context.run.id).map(line => `  ${line}`));
    } else if (context.kind === "snapshot"
      && change.entity.kind === "run"
      && (change.action === "failed" || change.action === "timed_out")) {
      lines.push(`  Inspect: acpus runs inspect ${context.run.id} --target root`);
    }
  }
  if (runLevelRecoveryTransition) lines.push(...formatRunLevelActionCommands(actions, context.run.id).map(line => `  ${line}`));
  return lines.join("\n") + (lines.length > 0 ? "\n" : "");
}

export function formatRunInspectionCheckpoint(document: FollowableInspectionDocument, nowMs = Date.now()): string {
  if (document.kind === "target") {
    return `· checkpoint  ${document.run.status}  ${document.subject.label}\n`;
  }
  if (document.kind === "timeline") {
    return `· checkpoint  ${document.run.status}  ${document.subject.label}\n`;
  }

  const elapsed = elapsedSince(document.run.createdAt, new Date(nowMs).toISOString());
  const counts = formatCounts(document.counts);
  return `· checkpoint +${elapsed}  ${document.run.status}${counts ? `  ${counts}` : ""}\n`;
}

export function applyRunInspectionUpdate(
  document: FollowableInspectionDocument,
  update: RunInspectionDeltaEmission,
  timelineLimit = 12,
): FollowableInspectionDocument {
  let next: FollowableInspectionDocument = { ...document, revision: update.revision };
  for (const delta of update.changes) next = applyInspectionDelta(next, delta, timelineLimit);
  return next;
}

export function formatRunInspectionDelta(
  emission: Extract<RunInspectionEmission, { kind: "delta" }>,
  document?: FollowableInspectionDocument,
  runId = document?.run.id,
): string {
  const lines: string[] = [];
  for (const delta of emission.changes) {
    if (delta.kind === "overview") {
      if (document !== undefined && document.kind !== "snapshot") continue;
      lines.push(formatRunInspectionChanges(delta.changes, {
        kind: "snapshot",
        run: delta.run,
        items: document?.kind === "snapshot" ? document.items : delta.patch.upsertItems,
        availableActions: document?.kind === "snapshot"
          ? document.availableActions
          : delta.patch.availableActions ?? [],
      }).trimEnd());
    } else if (delta.kind === "run") {
      lines.push(`Run ${delta.run.id}  ${delta.run.status}`);
    } else if (delta.kind === "state") {
      lines.push(`State ${displayStatus(delta.state.status)}${delta.state.reason ? `  ${oneLine(delta.state.reason, 160)}` : ""}`);
    } else if (delta.kind === "pulse" && delta.pulse) {
      lines.push(`Pulse ${formatPhase(delta.pulse.phase)}${delta.pulse.headline ? `  ${oneLine(delta.pulse.headline, 240)}` : ""}`);
    } else if (delta.kind === "attention" && delta.attention) {
      lines.push(`Attention ${delta.attention.code}  ${oneLine(delta.attention.summary, 160)}`);
    } else if (delta.kind === "visibility") {
      lines.push(delta.visibility ? formatVisibility(delta.visibility) : "Visibility restored");
    } else if (delta.kind === "current" && delta.current) {
      lines.push(`Current ${formatCurrentHeadline(delta.current, exactAttemptTimeline(document))}`);
    } else if (delta.kind === "current-patch") {
      lines.push(...formatCurrentPatch(
        delta.patch,
        document?.kind === "timeline" ? document.current : undefined,
        exactAttemptTimeline(document),
      ));
    } else if (delta.kind === "recent") {
      lines.push(...delta.upsert.map(entry => formatTimelineEntry(entry, exactAttemptTimeline(document))));
      const previousRetentionOmitted = document?.kind === "timeline"
        ? document.recent.retentionOmittedBefore ?? 0
        : undefined;
      if ((delta.page.retentionOmittedBefore ?? 0) > 0
        && delta.page.retentionOmittedBefore !== previousRetentionOmitted) {
        lines.push(`History ${delta.page.retentionOmittedBefore} earlier entries expired from bounded history`);
      }
    } else if (delta.kind === "available-actions" && runId) {
      lines.push(...formatSummaryActions(delta.availableActions, runId));
    } else if (delta.kind === "evidence" && delta.evidence) {
      lines.push(...formatEvidence(delta.evidence));
    }
  }
  return lines.filter(Boolean).join("\n") + (lines.some(Boolean) ? "\n" : "");
}

export function formatTerminalOutput(output: unknown): string {
  if (output === undefined) return "";
  return `\nOutput:\n${prettyLines(output, "  ").join("\n")}\n`;
}

function applyInspectionDelta(
  document: FollowableInspectionDocument,
  delta: RunInspectionDelta,
  timelineLimit: number,
): FollowableInspectionDocument {
  if (delta.kind === "overview") {
    if (document.kind !== "snapshot") return document;
    const removed = new Set(delta.patch.removeItemKeys);
    const replacements = new Map(delta.patch.upsertItems.map(item => [item.key, item]));
    const items = document.items
      .filter(item => !removed.has(item.key))
      .map(item => replacements.get(item.key) ?? item);
    const existing = new Set(items.map(item => item.key));
    for (const item of delta.patch.upsertItems) if (!existing.has(item.key)) items.push(item);
    if (delta.patch.itemOrder) {
      const order = new Map(delta.patch.itemOrder.map((key, index) => [key, index]));
      items.sort((left, right) =>
        (order.get(left.key) ?? Number.MAX_SAFE_INTEGER)
        - (order.get(right.key) ?? Number.MAX_SAFE_INTEGER));
    }
    const { omitted: _omitted, hooks: _hooks, ...base } = document;
    return {
      ...base,
      run: delta.run,
      counts: delta.patch.counts ?? document.counts,
      availableActions: delta.patch.availableActions ?? document.availableActions,
      items,
      ...(delta.patch.omitted === undefined
        ? document.omitted ? { omitted: document.omitted } : {}
        : delta.patch.omitted ? { omitted: delta.patch.omitted } : {}),
      ...((delta.patch.hooks ?? document.hooks ?? []).length > 0
        ? { hooks: delta.patch.hooks ?? document.hooks }
        : {}),
    };
  }
  if (delta.kind === "run") {
    if (document.kind === "snapshot") return document;
    return { ...document, run: { ...document.run, ...delta.run } };
  }
  if (delta.kind === "state" && document.kind !== "snapshot") {
    return { ...document, state: delta.state };
  }
  if (document.kind === "target") {
    if (delta.kind === "pulse") {
      const { pulse: _pulse, ...rest } = document;
      return delta.pulse ? { ...rest, pulse: delta.pulse } : rest;
    }
    if (delta.kind === "attention") {
      const { attention: _attention, ...rest } = document;
      return delta.attention ? { ...rest, attention: delta.attention } : rest;
    }
    if (delta.kind === "visibility") {
      const { visibility: _visibility, ...rest } = document;
      return delta.visibility ? { ...rest, visibility: delta.visibility } : rest;
    }
    if (delta.kind === "available-actions") {
      return { ...document, availableActions: delta.availableActions };
    }
    if (delta.kind === "evidence") {
      const { evidence: _evidence, ...rest } = document;
      return delta.evidence ? { ...rest, evidence: delta.evidence } : rest;
    }
  }
  if (document.kind === "timeline") {
    if (delta.kind === "visibility") {
      const { visibility: _visibility, ...rest } = document;
      return delta.visibility ? { ...rest, visibility: delta.visibility } : rest;
    }
    if (delta.kind === "current") {
      const { current: _current, ...rest } = document;
      return delta.current ? { ...rest, current: delta.current } : rest;
    }
    if (delta.kind === "current-patch" && document.current?.kind === delta.patch.kind) {
      return { ...document, current: applyCurrentActivityPatch(document.current, delta.patch) };
    }
    if (delta.kind === "recent") {
      const entries = new Map(document.recent.entries.map(entry => [entry.id, entry]));
      for (const entry of delta.upsert) {
        entries.set(entry.id, entry);
      }
      const bounded = delta.order
        .flatMap(id => entries.get(id) ?? [])
        .slice(-timelineLimit);
      return {
        ...document,
        recent: {
          ...delta.page,
          entries: bounded,
        },
      };
    }
  }
  return document;
}

function applyCurrentActivityPatch(
  current: RunInspectionCurrentActivity,
  patch: RunInspectionCurrentActivityPatch,
): RunInspectionCurrentActivity {
  const updated = { ...current } as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(patch.changes)) {
    if (value === null) delete updated[key];
    else updated[key] = value;
  }
  return updated as RunInspectionCurrentActivity;
}

function formatCurrentPatch(
  patch: RunInspectionCurrentActivityPatch,
  current: RunInspectionCurrentActivity | undefined,
  exactAttempt: boolean,
): string[] {
  const changes = patch.changes as Record<string, unknown>;
  const phase = "phase" in patch.changes && typeof patch.changes.phase === "string"
    ? formatPhase(patch.changes.phase)
    : "updated";
  const lines: string[] = [];
  const postFence = "postFence" in changes
    ? changes.postFence === true
    : current?.kind === "agent" && current.postFence === true;
  const agentIdentity = patch.kind === "agent"
    ? patch
    : current?.kind === "agent" ? current : undefined;
  const currentPrefix = [
    phase,
    agentIdentity ? formatAttemptAttribution(agentIdentity, exactAttempt).trim() : undefined,
    postFence ? "post-fence/discarded" : undefined,
  ].filter((value): value is string => Boolean(value)).join(" · ");
  const add = (value: string): void => {
    lines.push(`Current ${currentPrefix} · ${value}`);
  };

  if ("response" in changes) {
    const response = changes.response as RunInspectionExcerpt | null;
    add(response ? `Response: ${formatExcerpt(response, 160)}` : "Response cleared");
  }
  if ("intent" in changes) {
    const intent = changes.intent as Extract<RunInspectionCurrentActivity, { kind: "agent" }>["intent"] | null;
    add(intent
      ? `${intent.kind === "plan" ? "Plan" : "Reported thought"}: ${formatExcerpt(intent.excerpt, 160)}`
      : "Intent cleared");
  }
  if ("tools" in changes) {
    const tools = changes.tools as Extract<RunInspectionCurrentActivity, { kind: "agent" }>["tools"] | null;
    const tool = tools?.active[0];
    add(tool ? `Tool: ${formatTool(tool)}` : "Tools cleared");
  }
  if ("message" in changes) {
    const message = changes.message;
    add(typeof message === "string" ? oneLine(message, 160) : "Message cleared");
  }
  if ("prompt" in changes) {
    const prompt = changes.prompt as RunInspectionExcerpt | null;
    add(prompt ? `Prompt: ${formatExcerpt(prompt, 160)}` : "Prompt cleared");
  }
  if ("schemaSummary" in changes) {
    const summary = changes.schemaSummary;
    add(typeof summary === "string" ? `Expected: ${oneLine(summary, 160)}` : "Expected schema cleared");
  }
  return lines.length > 0 ? lines : [`Current ${currentPrefix} · ${patch.kind}`];
}

function formatTargetSummary(document: RunInspectionTargetSummaryDocument): string {
  const subject = [
    boundedInline(document.subject.label, 240),
    document.subject.id === document.subject.label ? undefined : boundedInline(document.subject.id, 240),
    boundedInline(document.subject.kind, 80),
  ].filter((value): value is string => value !== undefined).join("  ");
  const state = [
    displayStatus(document.state.status),
    document.state.reason ? oneLine(document.state.reason, 160) : undefined,
    document.state.durationMs === undefined ? undefined : formatDurationMs(document.state.durationMs),
  ].filter((value): value is string => value !== undefined).join("  ");
  const lines = [
    `Run ${boundedInline(document.run.id, 160)}  ${document.run.status}`,
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
  if (document.evidence) lines.push(...formatEvidence(document.evidence));
  return boundedTextOutput(`${lines.join("\n")}\n`, targetSummaryTextBytes);
}

function formatSummaryActions(actions: readonly RunInspectionAction[], runId: string): string[] {
  if (actions.length === 0) return [];
  return [
    "Available operations:",
    ...actions.slice(0, 2)
      .map(action => `  ${boundedInline(formatSummaryAction(action, runId), 480)}`),
  ];
}

function formatEvidence(evidence: AgentAttemptEvidenceCapsule): string[] {
  const disposition = evidence.dispositionReason
    ? `${evidence.schedulerDisposition}/${evidence.dispositionReason}`
    : evidence.schedulerDisposition;
  const lines = [
    `Evidence ${evidence.state}/${evidence.completeness}  turns=${evidence.turnCount}  gaps=${evidence.gapCount}  scheduler=${disposition}${evidence.providerOutcome ? `  provider=${evidence.providerOutcome}` : ""}`,
    `  Directory: ${boundedInline(evidence.directory, 480)}`,
  ];
  for (const record of evidence.records) {
    const sizes = [
      `durable=${record.lastDurableResponseBytes}B`,
      record.responseAtFenceBytes === undefined ? undefined : `fence=${record.responseAtFenceBytes}B`,
      record.finalObservedResponseBytes === undefined ? undefined : `final=${record.finalObservedResponseBytes}B`,
    ].filter((value): value is string => value !== undefined).join("  ");
    const trace = record.trace
      ? `  trace=${record.trace.state}${record.trace.file ? `/${record.trace.file}` : ""}${record.trace.bytes === undefined ? "" : `/${record.trace.bytes}B`}`
      : "";
    lines.push(boundedInline(
      `  Turn ${record.turn}  ${record.file}  prompt=${record.prompt.kind}/${record.prompt.bytes}B/${record.prompt.digest}  ${sizes}${trace}`,
      480,
    ));
  }
  if (evidence.omittedTurns > 0) lines.push(`  … ${evidence.omittedTurns} turns omitted`);
  return lines;
}

function formatSummaryAction(action: RunInspectionAction, runId: string): string {
  if (action.kind === "inspect-timeline") return `Timeline: acpus runs inspect ${runId} --target ${action.target} --timeline`;
  if (action.kind === "follow-target") return `Follow: acpus runs inspect ${runId} --target ${action.target} --follow`;
  if (action.kind === "steer") return `Steer: acpus runs steer ${runId} --target ${action.target} --instruction '<correction>'`;
  if (action.kind === "signal") {
    return `Signal: acpus runs signal ${runId} --target ${action.target} --payload ${action.schemaSummary ? "'<json>'" : `'\"text\"'`}`;
  }
  if (action.kind === "retry") return `Retry: acpus runs retry ${runId}${action.target ? ` --target ${action.target}` : ""}`;
  return `Fork: acpus runs fork ${runId}${action.target ? ` --target ${action.target}` : ""}`;
}

function formatTimeline(document: RunInspectionTimelineDocument): string {
  const lines = [
    `Run ${document.run.id}  ${document.run.status}`,
    `Timeline ${document.subject.label}  ${document.subject.id}  ${displayStatus(document.state.status)}`,
  ];
  if (document.visibility) lines.push(formatVisibility(document.visibility));
  const exactAttempt = document.subject.targetKind === "attempt";
  if (document.current) {
    lines.push("Current:", ...formatCurrent(document.current, exactAttempt).map(line => `  ${line}`));
  }
  lines.push("Recent:");
  if (document.recent.entries.length === 0) lines.push("  (no closed activity)");
  else lines.push(...document.recent.entries.map(entry => `  ${formatTimelineEntry(entry, exactAttempt)}`));
  if (document.recent.hasOlder) {
    lines.push(`  … ${document.recent.omittedBefore} older${document.recent.olderCursor ? `  before=${document.recent.olderCursor}` : ""}`);
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

function formatCurrentHeadline(current: RunInspectionCurrentActivity, exactAttempt: boolean): string {
  if (current.kind === "signal") return current.prompt ? `awaiting · ${formatExcerpt(current.prompt, 160)}` : "awaiting";
  if (current.kind !== "agent") return `${current.phase}${current.message ? ` · ${oneLine(current.message, 160)}` : ""}`;
  const prefix = [
    formatPhase(current.phase),
    formatAttemptAttribution(current, exactAttempt).trim(),
    current.postFence ? "post-fence/discarded" : undefined,
  ].filter((value): value is string => Boolean(value)).join(" · ");
  const tool = current.tools?.active[0];
  if (tool) return `${prefix} · ${formatTool(tool)}`;
  if (current.intent) return `${prefix} · ${formatExcerpt(current.intent.excerpt, 160)}`;
  if (current.response) return `${prefix} · ${formatExcerpt(current.response, 160)}`;
  return prefix;
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
  return `${entry.at}  gap  dropped=${entry.dropped}  ${oneLine(entry.reason, 240)}`;
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

function exactAttemptTimeline(
  document: FollowableInspectionDocument | undefined,
): boolean {
  return document?.kind === "timeline" && document.subject.targetKind === "attempt";
}

function formatAttemptAttribution(
  value: { attemptNo?: number; attemptId?: string },
  exactAttempt: boolean,
): string {
  if (exactAttempt) return "";
  if (value.attemptNo !== undefined) return `  attempt=${value.attemptNo}`;
  return value.attemptId ? `  attempt=${boundedInline(value.attemptId, 48)}` : "";
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
  const lines = [formatHeader(document.run, nowMs), "", "Tree:"];
  lines.push(...formatInspectionTree(document.items));
  if (document.omitted && !document.items.some(item => item.role === "fold")) {
    lines.push(`  … ${document.omitted.dynamicContexts} contexts omitted (${formatCounts(document.omitted.counts)})`);
  }
  const inspectAll = document.availableActions.find(action => action.kind === "inspect-all");
  if (inspectAll) lines.push(`  More: acpus runs inspect ${document.run.id} --all`);

  const active = activeItems(document.items);
  const hiddenActive = (document.omitted?.counts.starting ?? 0) + (document.omitted?.counts.running ?? 0);
  if (active.length + hiddenActive > 0) {
    const byKey = new Map(document.items.map(item => [item.key, item]));
    lines.push("", "Active:");
    for (const item of active.slice(0, 3)) lines.push(`  ${formatActiveItem(item, byKey)}`);
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

function formatTargetDetails(document: RunInspectionTargetDetailsDocument, nowMs: number): string {
  const { summary } = document;
  const current = currentTargetItem(document);
  const nodeStatus = current?.status ?? summary.nodeStatus;
  const lines = [formatHeader(document.run, nowMs, true), `Target ${document.target.id}  [${document.target.kind}]${nodeStatus ? `  ${nodeStatus}` : ""}`];
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
  if (summary.staticKind === "agent" && summary.latestAttempt?.status === "started") {
    lines.push(`  Steer: acpus runs steer ${document.run.id} --target ${summary.latestAttempt.attemptId} --instruction '<correction>'`);
  }
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
      const status = attempt.cancelReason ? `${attempt.status} / ${attempt.cancelReason}` : attempt.status;
      lines.push(`  ${statusGlyph(normalizeStatus(attempt.status))} ${attempt.attemptId}  ${status}  attempt=${attempt.attemptNo}${duration ? `  ${duration}` : ""}`);
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

function formatActiveItem(item: RunInspectionItem, byKey: ReadonlyMap<string, RunInspectionItem>): string {
  const kind = item.kind === "agent" && item.agent ? `agent(${item.agent.key})` : item.kind;
  const agentPulse = item.agent ? formatAgentPulse(item.agent) : "";
  const pulse = agentPulse ? ` · ${agentPulse}` : "";
  return `${statusGlyph(item.status)} ${itemBreadcrumb(item, byKey)} · ${kind}${pulse}`;
}

function formatAgentPulse(agent: AgentDecisionState): string {
  const fields = [
    agent.turn === undefined ? undefined : `turn ${agent.turn}`,
    agent.activeTool ? formatDecisionTool(agent.activeTool) : undefined,
  ].filter((value): value is string => value !== undefined);
  return fields.join(" · ");
}

function formatAttention(document: RunInspectionSnapshot): string[] {
  const byKey = new Map(document.items.map(item => [item.key, item]));
  const actions = indexActions(document.availableActions);
  const candidates = deepestAttentionCandidates(document.items, actions);
  const lines: string[] = [];
  if (document.run.execution.state === "stale") {
    const reason = document.run.execution.reason?.replaceAll("_", " ") ?? "execution inactive";
    lines.push(`  ◆ run — stale: ${reason}`);
  }
  if (document.run.failure && !rootFailureWasPropagated(document.items, candidates)) {
    lines.push(`  ◆ run — ${formatFailure(document.run.failure, 240)}`);
    lines.push(`     Inspect: acpus runs inspect ${document.run.id} --target root`);
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

function deepestAttentionCandidates(
  items: readonly RunInspectionItem[],
  actions: ActionIndex,
): RunInspectionItem[] {
  const byKey = new Map(items.map(item => [item.key, item]));
  const exceptional = items.filter(item => item.role !== "fold"
    && (item.status === "awaiting" || failureStatus(item.status))
    && (item.role !== "context" || item.failure !== undefined || actions.byItem.has(item.key)));
  const exceptionalAncestors = new Set<string>();
  for (const item of exceptional) {
    let parentKey = item.parentKey;
    while (parentKey && !exceptionalAncestors.has(parentKey)) {
      exceptionalAncestors.add(parentKey);
      parentKey = byKey.get(parentKey)?.parentKey;
    }
  }
  return exceptional.filter(item => !exceptionalAncestors.has(item.key));
}

function rootFailureWasPropagated(
  items: readonly RunInspectionItem[],
  candidates: readonly RunInspectionItem[],
): boolean {
  const byKey = new Map(items.map(item => [item.key, item]));
  return candidates.some(candidate => {
    if (!failureStatus(candidate.status) || candidate.failure === undefined) return false;
    const seen = new Set<string>();
    let current = candidate;
    while (current.parentKey && byKey.has(current.parentKey)) {
      if (!failureStatus(current.status) || seen.has(current.key)) return false;
      seen.add(current.key);
      current = byKey.get(current.parentKey)!;
    }
    return failureStatus(current.status);
  });
}

function failureStatus(status: RunInspectionStatus): boolean {
  return status === "failed" || status === "timed_out";
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
  byItem: Map<string, RunInspectionOverviewAction[]>;
  unscopedForks: Array<Extract<RunInspectionOverviewAction, { kind: "fork" }>>;
};

function indexActions(actions: readonly RunInspectionOverviewAction[]): ActionIndex {
  const byItem = new Map<string, RunInspectionOverviewAction[]>();
  const unscopedForks: ActionIndex["unscopedForks"] = [];
  for (const action of actions) {
    if (action.kind === "inspect-all") continue;
    if (action.kind === "fork" && action.itemKey === undefined) {
      unscopedForks.push(action);
      continue;
    }
    const itemKey = "itemKey" in action ? action.itemKey : undefined;
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

function formatFailure(failure: NonNullable<RunInspectionRunSummary["failure"]>, messageLimit: number): string {
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
  if (agent.lastObservedAt) {
    const age = relativeAge(agent.lastObservedAt, nowMs);
    if (age) lines.push(`${prefix}Last observed: ${age}`);
  }
  return lines;
}

function formatAgentProgress(agent: AgentDecisionState): string {
  return [
    agent.turn === undefined ? undefined : `turn=${agent.turn}`,
    agent.activeTool ? `tool=[${formatDecisionTool(agent.activeTool)}]` : undefined,
  ].filter((value): value is string => value !== undefined).join("  ");
}

function formatDecisionTool(tool: NonNullable<AgentDecisionState["activeTool"]>): string {
  return `${toolStatusGlyph(tool.status)} ${truncateToolCommand(tool.command)}`;
}

function formatRecentTool(tool: RecentTool): string {
  const status = typeof tool.status === "string" ? tool.status : undefined;
  return `${toolStatusGlyph(status)} ${truncateToolCommand(tool.command)}`;
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

function formatHeader(run: RunInspectionRunSummary, nowMs: number, includeDiagnostics = false): string {
  const duration = run.durationMs === undefined ? Math.max(0, nowMs - Date.parse(run.createdAt)) : run.durationMs;
  const lines = [`Run ${run.id}  ${run.name}  ${executionStatus(run)}  ${formatDurationMs(duration)}`];
  if (run.fork) {
    lines.push(`Fork: source=${run.fork.sourceRunId}${run.fork.target ? `  target=${run.fork.target}` : ""}${run.fork.unsafeReuse ? "  unsafe-reuse" : ""}`);
  }
  if (includeDiagnostics && run.agentUsage) {
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
  if (change.action === "steered") return "steered";
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
  if (status === "canceled" || status === "superseded") return "cancelled";
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

function currentTargetItem(document: RunInspectionTargetDetailsDocument): RunInspectionItem<AgentInspectionState> | undefined {
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

function boundedInline(value: string, maxBytes: number): string {
  const compact = stripVTControlCharacters(value)
    .replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ")
    .trim();
  if (Buffer.byteLength(compact) <= maxBytes) return compact;
  return `${utf8Head(compact, Math.max(0, maxBytes - Buffer.byteLength("…")))}…`;
}

function boundedTextOutput(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value) <= maxBytes) return value;
  return `${utf8Head(value, maxBytes - Buffer.byteLength("…\n")).trimEnd()}…\n`;
}

function utf8Head(value: string, maxBytes: number): string {
  let bytes = Buffer.from(value).subarray(0, maxBytes);
  while (bytes.length > 0) {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      // Only the selected edge can split a UTF-8 sequence.
    }
    bytes = bytes.subarray(0, -1);
  }
  return "";
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
