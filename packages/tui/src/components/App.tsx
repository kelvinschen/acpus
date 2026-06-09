import React, { useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import type { RunSupervisorClient } from "@acpus/runtime";
import { open, stat } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { useRunPoller, isTerminal } from "../poller.js";
import { buildRenderTree, buildRows, countByState, formatElapsed } from "../model.js";
import { applyControl, canApply, applyRunControl, canApplyRun, type ControlAction } from "../controls.js";
import { useTerminalSize, windowSlice } from "../useTerminalSize.js";
import { StatusOverview } from "./StatusOverview.js";
import { GraphPane } from "./GraphPane.js";
import { DetailsPane, buildDetailLines, formatDetailLinesPlainText } from "./DetailsPane.js";
import { Footer } from "./Footer.js";
import { copyToClipboard } from "../osc52.js";
import {
  AgentTranscriptAccumulator,
  emptyAgentExecutionSummary,
  mergeAgentExecutionSummaries,
  type AgentExecutionSummary
} from "../agentTranscript.js";

type Focus = "graph" | "details";
type OverviewMessage = { text: string; level: "info" | "error" };
type TranscriptCache = {
  path?: string;
  offset: number;
  targetSize?: number;
  accumulator: AgentTranscriptAccumulator;
  summary: AgentExecutionSummary;
  inFlight: boolean;
};

const AGENT_TRANSCRIPT_REFRESH_MS = 3000;
const AGENT_TRANSCRIPT_CATCHUP_REFRESH_MS = 25;
const AGENT_TRANSCRIPT_READ_CHUNK_BYTES = 2 * 1024 * 1024;
const AGENT_TRANSCRIPT_READ_BUDGET_BYTES = 4 * 1024 * 1024;

const KEY_TO_ACTION: Record<string, ControlAction> = {
  p: "pause",
  r: "resume",
  c: "cancel",
  R: "retry",
  a: "approve",
  x: "reject"
};

/** Main dashboard: observe + control a single run. */
export function App({
  client,
  runId
}: {
  client: RunSupervisorClient;
  runId: string;
}): React.ReactElement {
  const { exit } = useApp();
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [focus, setFocus] = useState<Focus>("graph");
  const [detailsScroll, setDetailsScroll] = useState(0);
  const [collapsedRows, setCollapsedRows] = useState<Set<string>>(() => new Set());
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [messages, setMessages] = useState<OverviewMessage[]>([]);
  const [artifactPaths, setArtifactPaths] = useState<Record<string, string>>({});
  const [agentExecution, setAgentExecution] = useState<AgentExecutionSummary | undefined>(undefined);
  const transcriptCacheRef = useRef(new Map<string, TranscriptCache>());

  const snapshot = useRunPoller(client, runId, 400, refreshNonce);
  const { rows: termRows, columns: termCols } = useTerminalSize();

  // Build the render tree once per snapshot; rows and counts both derive from it.
  const tree = useMemo(
    () => (snapshot.ir ? buildRenderTree(snapshot.ir, snapshot.nodes) : null),
    [snapshot.ir, snapshot.nodes]
  );

  const allRows = useMemo(() => (tree ? buildRows(tree) : []), [tree]);
  const rows = useMemo(() => visibleRows(allRows, collapsedRows), [allRows, collapsedRows]);

  const counts = useMemo(
    () =>
      tree
        ? countByState(tree)
        : { pending: 0, running: 0, awaiting: 0, completed: 0, failed: 0, paused: 0, cancelled: 0, total: 0 },
    [tree]
  );

  const clampedIndex = rows.length === 0 ? 0 : Math.min(selectedIndex, rows.length - 1);
  const selected = rows[clampedIndex];
  const selectedArtifactRefs = selected?.instance?.artifactRefs ?? [];
  const selectedArtifactRefsKey = selectedArtifactRefs.join("\n");
  const selectedTranscriptRefs = useMemo(
    () => selected?.irNode.kind === "run.agent" ? attemptTranscriptRefs(selectedArtifactRefs) : [],
    [selected?.irNode.kind, selectedArtifactRefsKey]
  );
  const selectedTranscriptRefsKey = selectedTranscriptRefs.join("\n");
  const selectedTranscriptPathsKey = selectedTranscriptRefs.map((ref) => artifactPaths[ref] ?? "").join("\n");

  // ── Layout budget (height + width). Computed before line-building so the
  // details lines can be wrapped to the actual pane width. ──
  // The whole frame MUST fit within the terminal height, otherwise Ink cannot
  // erase the previous frame and old frames linger. Chrome = top bar (3) +
  // footer (2) + margins; the rest goes to the three equal-height panes.
  const RESERVED = 6;
  const paneHeight = Math.max(8, termRows - RESERVED);
  // Box border + header consume ~4 lines for the graph; details reserves an
  // extra line for the ↑/↓ more hints (see DetailsPane).
  const graphVisibleRows = Math.max(3, paneHeight - 4);
  const detailsVisibleRows = Math.max(1, paneHeight - 5);

  // Width budget. STATUS OVERVIEW stays a fixed sidebar; the remaining width is
  // split between GRAPH and DETAILS so the FOCUSED pane gets ~50% of the whole
  // screen and the unfocused one ~25%.
  const STATUS_WIDTH = 28;
  const remaining = Math.max(20, termCols - STATUS_WIDTH);
  const focusedShare = Math.round(termCols * 0.5);
  const detailsWidth = Math.max(
    24,
    Math.min(remaining - 20, focus === "details" ? focusedShare : remaining - focusedShare)
  );
  const graphWidth = Math.max(20, remaining - detailsWidth);
  const freezeAt = snapshot.run?.status === "running" ? undefined : snapshot.run?.updatedAt;

  // Flatten the selected node into a single array of colored lines, then derive
  // the scroll bound from its true length (so long prompts/outputs scroll fully).
  const detailLines = useMemo(
    () => buildDetailLines(selected, detailsWidth, artifactPaths, freezeAt, agentExecution),
    [selected, detailsWidth, artifactPaths, freezeAt, agentExecution]
  );
  const detailsMaxScroll = Math.max(0, detailLines.length - detailsVisibleRows);

  // Pre-fetch absolute filesystem paths for the selected node's artifacts so
  // DetailsPane can show "<filename>  <absPath>". Only successful resolutions are
  // cached; transient misses are retried when the selected node's refs change.
  useEffect(() => {
    const refs = selectedArtifactRefs;
    if (refs.length === 0) return;
    const missing = refs.filter((r) => !(r in artifactPaths));
    if (missing.length === 0) return;
    let cancelled = false;
    void Promise.all(
      missing.map(async (uri) => {
        try {
          return [uri, await client.getArtifactPath(runId, uri), undefined] as const;
        } catch (err) {
          return [uri, undefined, err instanceof Error ? err.message : String(err)] as const;
        }
      })
    ).then((triples) => {
      if (cancelled) return;
      const firstError = triples.find(([, , error]) => error !== undefined)?.[2];
      if (firstError) pushMessage(`artifact path unresolved: ${firstError}`, "error");
      const resolved = triples.filter((entry): entry is readonly [string, string, undefined] => entry[1] !== undefined);
      if (resolved.length > 0) {
        setArtifactPaths((prev) => {
          const next = { ...prev };
          for (const [uri, abs] of resolved) next[uri] = abs;
          return next;
        });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [client, runId, selectedArtifactRefsKey, artifactPaths]);

  // Read only the selected Agent node's attempt transcripts. Each artifact is
  // cached by URI and read incrementally so switching nodes can render cached
  // activity immediately without synchronously reparsing large transcript files.
  useEffect(() => {
    if (selected?.irNode.kind !== "run.agent") {
      setAgentExecution(undefined);
      return;
    }
    if (selectedTranscriptRefs.length === 0) {
      setAgentExecution(emptyAgentExecutionSummary());
      return;
    }

    setAgentExecution(summaryFromTranscriptCache(transcriptCacheRef.current, selectedTranscriptRefs));

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = async () => {
      await refreshTranscriptCaches(transcriptCacheRef.current, selectedTranscriptRefs, artifactPaths, () => {
        if (!cancelled) setAgentExecution(summaryFromTranscriptCache(transcriptCacheRef.current, selectedTranscriptRefs));
      });
      if (!cancelled) setAgentExecution(summaryFromTranscriptCache(transcriptCacheRef.current, selectedTranscriptRefs));
      const hasPendingReads = hasPendingTranscriptReads(transcriptCacheRef.current, selectedTranscriptRefs, artifactPaths);
      if (!cancelled && (snapshot.run?.status === "running" || hasPendingReads)) {
        timer = setTimeout(() => {
          void refresh();
        }, hasPendingReads ? AGENT_TRANSCRIPT_CATCHUP_REFRESH_MS : AGENT_TRANSCRIPT_REFRESH_MS);
      }
    };
    void refresh();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [
    artifactPaths,
    selected?.irNode.kind,
    selected?.rowKey,
    selectedTranscriptRefsKey,
    selectedTranscriptPathsKey,
    snapshot.run?.status
  ]);

  // Reset details scroll when the selection changes.
  useEffect(() => {
    setDetailsScroll(0);
  }, [selected?.rowKey]);

  useInput((input, key) => {
    if (input === "q" || (key.ctrl && input === "c")) {
      exit();
      return;
    }
    if (input === "h") {
      setFocus("graph");
      return;
    }
    if (input === "l") {
      setFocus("details");
      return;
    }

    if (focus === "details") {
      // DETAILS pane: j/k line scroll; u/d half-page scroll; y copy all.
      const halfPage = Math.max(1, Math.floor(detailsVisibleRows / 2));
      if (input === "j") {
        setDetailsScroll((s) => Math.min(detailsMaxScroll, s + 1));
        return;
      }
      if (input === "k") {
        setDetailsScroll((s) => Math.max(0, s - 1));
        return;
      }
      if (input === "d") {
        setDetailsScroll((s) => Math.min(detailsMaxScroll, s + halfPage));
        return;
      }
      if (input === "u") {
        setDetailsScroll((s) => Math.max(0, s - halfPage));
        return;
      }
      if (input === "y") {
        copyToClipboard(formatDetailLinesPlainText(detailLines));
        pushMessage("details copied via OSC52", "info");
        return;
      }
      // Fall through to run/node controls (p/r/c/R/a/x) below.
    } else {
      // GRAPH pane: k/j select, space folds headers.
      if (input === "k") {
        setSelectedIndex((i) => Math.max(0, i - 1));
        return;
      }
      if (input === "j") {
        setSelectedIndex((i) => rows.length === 0 ? 0 : Math.min(rows.length - 1, i + 1));
        return;
      }
      if (input === "g") {
        setSelectedIndex(0);
        return;
      }
      if (input === "G") {
        setSelectedIndex(rows.length === 0 ? 0 : rows.length - 1);
        return;
      }
      if (input === " " && selected?.isHeader) {
        setCollapsedRows((prev) => {
          const next = new Set(prev);
          if (next.has(selected.rowKey)) next.delete(selected.rowKey);
          else next.add(selected.rowKey);
          return next;
        });
        return;
      }
    }

    const action = KEY_TO_ACTION[input];
    if (action) {
      void runControl(action);
    }
  });

  async function runControl(action: ControlAction): Promise<void> {
    const isSelectedExecutable = selected?.irNode.kind === "run.agent" || selected?.irNode.kind === "run.program";
    const selectedNodeKey = selected?.nodeKey;
    const nodeRetry = action === "retry" && selectedNodeKey && isSelectedExecutable && selected?.state === "failed";
    const nodeDecision = (action === "approve" || action === "reject") && selectedNodeKey;

    if ((nodeRetry || nodeDecision) && selected && selectedNodeKey) {
      if (!canApply(action, selected.state)) {
        pushMessage(`Cannot ${action} a ${selected.state ?? "not-started"} node.`, "error");
        return;
      }
      try {
        const state = await applyControl(client, action, runId, selectedNodeKey);
        pushMessage(`${action} → ${selectedNodeKey} (${state.state})`, "info");
        setRefreshNonce((n) => n + 1);
      } catch (err) {
        pushMessage(err instanceof Error ? err.message : String(err), "error");
      }
      return;
    }

    if (action === "approve" || action === "reject") {
      pushMessage(`Select an awaiting approval node to ${action}.`, "error");
      return;
    }

    if (!canApplyRun(action, run?.status)) {
      pushMessage(`Cannot ${action} a ${run?.status ?? "unknown"} run.`, "error");
      return;
    }
    try {
      const state = await applyRunControl(client, action, runId);
      pushMessage(`${action} run → ${state.status}`, "info");
      setRefreshNonce((n) => n + 1);
    } catch (err) {
      pushMessage(err instanceof Error ? err.message : String(err), "error");
    }
  }

  function pushMessage(text: string, level: OverviewMessage["level"]): void {
    setMessages((prev) => [...prev, { text, level }].slice(-3));
  }

  const run = snapshot.run;
  const live = run ? !isTerminal(run.status) : false;
  // While live, elapsed grows with wall-clock. Once the run reaches a terminal
  // state, freeze it at (updatedAt − createdAt) so it stops ticking.
  const elapsed = run
    ? formatElapsed((live ? Date.now() : Date.parse(run.updatedAt)) - Date.parse(run.createdAt))
    : "--:--:--";
  const overviewMessages = [
    ...messages,
    ...(snapshot.error ? [{ text: `supervisor poll error: ${snapshot.error} (retrying)`, level: "error" as const }] : []),
    ...(selected?.state === "awaiting"
      ? [{ text: "selected gate is awaiting: a approve, x reject", level: "info" as const }]
      : [])
  ].slice(-3);

  const win = windowSlice(rows.length, clampedIndex, graphVisibleRows);
  const windowedRows = rows.slice(win.start, win.end);
  const moreAbove = win.start;
  const moreBelow = rows.length - win.end;

  if (!snapshot.loaded) {
    return (
      <Box padding={1}>
        <Text color="yellow">
          {snapshot.error ? `Error: ${snapshot.error}` : `Loading run ${runId}…`}
        </Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      {/* Top bar */}
      <Box borderStyle="round" borderColor="cyan" paddingX={1} justifyContent="space-between">
        <Text>
          <Text bold color="cyan">
            ⛬ Acpus Workflow Runner
          </Text>
          <Text color="gray">  │  Run </Text>
          <Text>{run?.runId}</Text>
          <Text color="gray">  │  Workflow </Text>
          <Text color="green">{run?.workflowName}</Text>
          <Text color="gray">  │  Status </Text>
          <Text color={live ? "yellow" : "white"}>{run?.status}</Text>
          {run && run.runAttempt > 1 ? (
            <>
              <Text color="gray">  │  </Text>
              <Text color="yellow">↺{run.runAttempt}</Text>
            </>
          ) : null}
        </Text>
        <Text>
          <Text color="gray">Elapsed </Text>
          <Text>{elapsed}  </Text>
          <Text color={live ? "green" : "gray"} bold>
            {live ? "● LIVE" : "■ ENDED"}
          </Text>
        </Text>
      </Box>

      {/* Main 3-pane row: STATUS OVERVIEW | WORKFLOW GRAPH | NODE DETAILS */}
      <Box height={paneHeight}>
        <StatusOverview counts={counts} messages={overviewMessages} height={paneHeight} />
        <GraphPane
          rows={windowedRows}
          selectedIndex={clampedIndex - win.start}
          focused={focus === "graph"}
          moreAbove={moreAbove}
          moreBelow={moreBelow}
          height={paneHeight}
          width={graphWidth}
          freezeAt={freezeAt}
        />
        <DetailsPane
          lines={detailLines}
          height={paneHeight}
          width={detailsWidth}
          focused={focus === "details"}
          scrollOffset={detailsScroll}
        />
      </Box>

      <Footer
        focus={focus}
      />
    </Box>
  );
}

export function visibleRows<T extends { rowKey: string; depth: number }>(rows: T[], collapsed: Set<string>): T[] {
  const visible: T[] = [];
  let hiddenUntilDepth: number | undefined;
  for (const row of rows) {
    if (hiddenUntilDepth !== undefined) {
      if (row.depth > hiddenUntilDepth) continue;
      hiddenUntilDepth = undefined;
    }
    visible.push(row);
    if (collapsed.has(row.rowKey)) {
      hiddenUntilDepth = row.depth;
    }
  }
  return visible;
}

function attemptTranscriptRefs(refs: string[] | undefined): string[] {
  return [...new Set(refs ?? [])]
    .map((ref) => ({ ref, attempt: attemptNumber(ref) }))
    .filter((entry): entry is { ref: string; attempt: number } => entry.attempt !== undefined)
    .sort((a, b) => a.attempt - b.attempt)
    .map((entry) => entry.ref);
}

function attemptNumber(ref: string): number | undefined {
  const match = /attempt-(\d+)\.transcript\.jsonl$/.exec(ref);
  return match ? Number(match[1]) : undefined;
}

function summaryFromTranscriptCache(cache: Map<string, TranscriptCache>, refs: string[]): AgentExecutionSummary {
  const summaries = refs.map((ref) => cache.get(ref)?.summary).filter((summary): summary is AgentExecutionSummary => summary !== undefined);
  return summaries.length > 0 ? mergeAgentExecutionSummaries(summaries) : emptyAgentExecutionSummary();
}

async function refreshTranscriptCaches(
  cache: Map<string, TranscriptCache>,
  refs: string[],
  artifactPaths: Record<string, string>,
  onProgress?: () => void
): Promise<void> {
  await Promise.all(refs.map((ref, index) => refreshTranscriptCache(cache, ref, artifactPaths[ref], index, onProgress)));
}

export async function refreshTranscriptCacheForTest(
  cache: Map<string, TranscriptCache>,
  ref: string,
  path: string | undefined,
  index: number,
  onProgress?: () => void
): Promise<void> {
  await refreshTranscriptCache(cache, ref, path, index, onProgress);
}

async function refreshTranscriptCache(
  cache: Map<string, TranscriptCache>,
  ref: string,
  path: string | undefined,
  index: number,
  onProgress?: () => void
): Promise<void> {
  if (!path) return;
  const orderOffset = (index + 1) * 1_000_000_000;
  const existing = cache.get(ref);
  const entry: TranscriptCache = existing ?? {
    offset: 0,
    accumulator: new AgentTranscriptAccumulator(),
    summary: emptyAgentExecutionSummary(),
    inFlight: false
  };
  if (entry.path !== path) {
    entry.path = path;
    entry.offset = 0;
    entry.targetSize = undefined;
    entry.accumulator.reset();
    entry.summary = emptyAgentExecutionSummary();
  }
  cache.set(ref, entry);
  if (entry.inFlight) return;

  entry.inFlight = true;
  try {
    const info = await stat(path);
    entry.targetSize = info.size;
    if (info.size < entry.offset) {
      entry.offset = 0;
      entry.targetSize = info.size;
      entry.accumulator.reset();
    }
    if (info.size === entry.offset) return;

    const handle = await open(path, "r");
    try {
      await readTranscriptChunks(handle, entry, info.size, orderOffset, onProgress);
    } finally {
      await handle.close();
    }
  } catch {
    entry.summary = entry.summary ?? emptyAgentExecutionSummary();
  } finally {
    entry.inFlight = false;
  }
}

function hasPendingTranscriptReads(
  cache: Map<string, TranscriptCache>,
  refs: string[],
  artifactPaths: Record<string, string>
): boolean {
  return refs.some((ref) => {
    const path = artifactPaths[ref];
    if (!path) return false;
    const entry = cache.get(ref);
    if (!entry || entry.path !== path) return true;
    return entry.targetSize !== undefined && entry.offset < entry.targetSize;
  });
}

async function readTranscriptChunks(
  handle: FileHandle,
  entry: TranscriptCache,
  targetSize: number,
  orderOffset: number,
  onProgress?: () => void
): Promise<void> {
  let bytesReadThisPass = 0;
  while (entry.offset < targetSize && bytesReadThisPass < AGENT_TRANSCRIPT_READ_BUDGET_BYTES) {
    const length = Math.min(
      AGENT_TRANSCRIPT_READ_CHUNK_BYTES,
      targetSize - entry.offset,
      AGENT_TRANSCRIPT_READ_BUDGET_BYTES - bytesReadThisPass
    );
    const buffer = Buffer.alloc(length);
    const result = await handle.read(buffer, 0, length, entry.offset);
    if (result.bytesRead <= 0) break;
    entry.offset += result.bytesRead;
    bytesReadThisPass += result.bytesRead;
    entry.accumulator.append(buffer.subarray(0, result.bytesRead).toString("utf8"));
    entry.summary = entry.accumulator.summary(orderOffset);
    onProgress?.();
    await yieldToEventLoop();
  }
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
