import React, { useEffect, useMemo, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import type { RunSupervisorClient } from "@acpus/runtime";
import { useRunPoller, isTerminal } from "../poller.js";
import { buildRenderTree, buildRows, countByState, formatElapsed } from "../model.js";
import { applyControl, canApply, applyRunControl, canApplyRun, type ControlAction } from "../controls.js";
import { useTerminalSize, windowSlice } from "../useTerminalSize.js";
import { StatusOverview } from "./StatusOverview.js";
import { GraphPane } from "./GraphPane.js";
import { DetailsPane } from "./DetailsPane.js";
import { Footer } from "./Footer.js";

type Focus = "graph" | "details";

const KEY_TO_ACTION: Record<string, ControlAction> = {
  p: "pause",
  r: "resume",
  c: "cancel",
  R: "retry"
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
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [toast, setToast] = useState<{ msg: string; error: boolean } | undefined>();
  const [artifactPaths, setArtifactPaths] = useState<Record<string, string>>({});

  const snapshot = useRunPoller(client, runId, 400, refreshNonce);
  const { rows: termRows } = useTerminalSize();

  const rows = useMemo(() => {
    if (!snapshot.ir) return [];
    const tree = buildRenderTree(snapshot.ir, snapshot.nodes);
    return buildRows(tree);
  }, [snapshot.ir, snapshot.nodes]);

  const counts = useMemo(() => {
    if (!snapshot.ir) {
      return { pending: 0, running: 0, completed: 0, failed: 0, paused: 0, cancelled: 0, total: 0 };
    }
    return countByState(buildRenderTree(snapshot.ir, snapshot.nodes));
  }, [snapshot.ir, snapshot.nodes]);

  const clampedIndex = rows.length === 0 ? 0 : Math.min(selectedIndex, rows.length - 1);
  const selected = rows[clampedIndex];

  // Pre-fetch absolute paths for the selected node's artifacts so they render
  // as clickable OSC 8 hyperlinks. Only fetches uris not already cached.
  useEffect(() => {
    const refs = selected?.instance?.artifactRefs;
    if (!refs || refs.length === 0) return;
    const missing = refs.filter((r) => !(r in artifactPaths));
    if (missing.length === 0) return;
    let cancelled = false;
    void Promise.all(
      missing.map(async (uri) => {
        try {
          return [uri, await client.getArtifactPath(runId, uri)] as const;
        } catch {
          return [uri, ""] as const;
        }
      })
    ).then((pairs) => {
      if (cancelled) return;
      setArtifactPaths((prev) => {
        const next = { ...prev };
        for (const [uri, abs] of pairs) if (abs) next[uri] = abs;
        return next;
      });
    });
    return () => {
      cancelled = true;
    };
  }, [client, runId, selected, artifactPaths]);

  // Reset details scroll when the selection changes.
  useEffect(() => {
    setDetailsScroll(0);
  }, [clampedIndex]);

  useInput((input, key) => {
    if (input === "q" || (key.ctrl && input === "c")) {
      exit();
      return;
    }
    if (key.tab) {
      setFocus((f) => (f === "graph" ? "details" : "graph"));
      return;
    }
    if (key.upArrow) {
      if (focus === "details") setDetailsScroll((s) => Math.max(0, s - 1));
      else setSelectedIndex((i) => Math.max(0, i - 1));
      return;
    }
    if (key.downArrow) {
      if (focus === "details") setDetailsScroll((s) => s + 1);
      else setSelectedIndex((i) => Math.min(rows.length - 1, i + 1));
      return;
    }
    if (input === "g") {
      setSelectedIndex(0);
      return;
    }
    if (input === "G") {
      setSelectedIndex(rows.length - 1);
      return;
    }

    const action = KEY_TO_ACTION[input];
    if (action) {
      void runControl(action);
    }
  });

  async function runControl(action: ControlAction): Promise<void> {
    if (selected && selected.nodeKey) {
      // Node-level control
      if (!canApply(action, selected.state)) {
        setToast({ msg: `Cannot ${action} a ${selected.state ?? "not-started"} node.`, error: true });
        return;
      }
      try {
        const state = await applyControl(client, action, runId, selected.nodeKey);
        setToast({ msg: `${action} → ${selected.nodeKey} (${state.state})`, error: false });
        setRefreshNonce((n) => n + 1);
      } catch (err) {
        setToast({ msg: err instanceof Error ? err.message : String(err), error: true });
      }
    } else {
      // Run-level control (no node selected)
      if (!canApplyRun(action, run?.status)) {
        setToast({ msg: `Cannot ${action} a ${run?.status ?? "unknown"} run.`, error: true });
        return;
      }
      try {
        const state = await applyRunControl(client, action, runId);
        setToast({ msg: `${action} run → ${state.status}`, error: false });
        setRefreshNonce((n) => n + 1);
      } catch (err) {
        setToast({ msg: err instanceof Error ? err.message : String(err), error: true });
      }
    }
  }

  const run = snapshot.run;
  const live = run ? !isTerminal(run.status) : false;
  const elapsed = run ? formatElapsed(Date.now() - Date.parse(run.createdAt)) : "--:--:--";

  // Height budget. The whole frame MUST fit within the terminal height,
  // otherwise Ink cannot erase the previous frame and old frames linger
  // (appearing as duplicated panels). Chrome = top bar (3) + footer (2) +
  // margins; the rest goes to the three equal-height panes.
  const RESERVED = 6;
  const paneHeight = Math.max(8, termRows - RESERVED);
  // Box border + header consume ~4 lines, so the visible content window is
  // paneHeight - 4.
  const visibleRows = Math.max(3, paneHeight - 4);
  const win = windowSlice(rows.length, clampedIndex, visibleRows);
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
            ⛬ Workflow Runner
          </Text>
          <Text color="gray">  │  Run </Text>
          <Text>{run?.runId}</Text>
          <Text color="gray">  │  Workflow </Text>
          <Text color="green">{run?.workflowName}</Text>
          <Text color="gray">  │  Status </Text>
          <Text color={live ? "yellow" : "white"}>{run?.status}</Text>
        </Text>
        <Text>
          <Text color="gray">Elapsed </Text>
          <Text>{elapsed}  </Text>
          <Text color={live ? "green" : "gray"} bold>
            {live ? "● LIVE" : "■ ENDED"}
          </Text>
        </Text>
      </Box>

      {snapshot.error ? (
        <Box paddingX={1}>
          <Text color="red">⚠ supervisor poll error: {snapshot.error} (retrying)</Text>
        </Box>
      ) : null}

      {/* Main 3-pane row: STATUS OVERVIEW | WORKFLOW GRAPH | NODE DETAILS */}
      <Box height={paneHeight}>
        <StatusOverview counts={counts} height={paneHeight} />
        <GraphPane
          rows={windowedRows}
          selectedIndex={clampedIndex - win.start}
          focused={focus === "graph"}
          moreAbove={moreAbove}
          moreBelow={moreBelow}
          height={paneHeight}
        />
        <DetailsPane
          row={selected}
          height={paneHeight}
          focused={focus === "details"}
          scrollOffset={detailsScroll}
          artifactPaths={artifactPaths}
        />
      </Box>

      <Footer toast={toast?.msg} isError={toast?.error} />
    </Box>
  );
}
