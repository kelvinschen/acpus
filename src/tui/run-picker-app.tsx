import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import { formatDuration, nextIndex, shorten, statusMark } from "./monitor-rendering.js";
import { listRunSummaries as defaultListRunSummaries, type RunSummaryList } from "../run-index/run-summary.js";

export type RunPickerAppProps = {
  title: string;
  pollMs?: number;
  initialList?: RunSummaryList;
  loadRuns?: typeof defaultListRunSummaries;
  onSelect: (runId: string | undefined) => void;
};

export function RunPickerApp({ title, pollMs = 1000, initialList, loadRuns = defaultListRunSummaries, onSelect }: RunPickerAppProps) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [list, setList] = useState<RunSummaryList | undefined>(initialList);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [error, setError] = useState<string | undefined>();
  const loadRunsRef = useRef(loadRuns);

  useEffect(() => {
    loadRunsRef.current = loadRuns;
  }, [loadRuns]);

  const refresh = useCallback(async () => {
    try {
      const next = await loadRunsRef.current();
      setList(next);
      setSelectedIndex((current) => Math.max(0, Math.min(current, Math.max(0, next.entries.length - 1))));
      setError(undefined);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), pollMs);
    return () => clearInterval(timer);
  }, [pollMs, refresh]);

  useInput((input, key) => {
    if (input === "q" || (key.ctrl && input === "c")) {
      onSelect(undefined);
      exit();
      return;
    }
    if (input === "r") void refresh();
    if (key.upArrow) setSelectedIndex((current) => nextIndex(current, -1, list?.entries.length ?? 0));
    if (key.downArrow) setSelectedIndex((current) => nextIndex(current, 1, list?.entries.length ?? 0));
    if (key.return) {
      const selected = list?.entries[selectedIndex];
      if (!selected || selected.invalid) return;
      onSelect(selected.runId);
      exit();
    }
  });

  const width = Math.max(80, stdout.columns ?? 120);
  const entries = useMemo(() => list?.entries ?? [], [list?.entries]);

  return (
    <Box flexDirection="column">
      <Text color="blue" bold>{title}</Text>
      <Text dimColor>{list ? `runs in ${list.dir}` : "Loading runs..."}</Text>
      {error ? <Text color="red">Error: {error}</Text> : null}
      {entries.length === 0 ? <Text dimColor>No runs found.</Text> : null}
      <Box flexDirection="column" marginTop={1}>
        {entries.map((entry, index) => (
          <Box key={entry.runId}>
            <Text>{index === selectedIndex ? ">" : " "} </Text>
            <Text dimColor={entry.invalid}>{statusMark(entry.status ?? "invalid")} </Text>
            <Text>{shorten(entry.runId, 40)} </Text>
            <Text>{shorten(entry.status ?? "invalid", 10)} </Text>
            <Text dimColor>{shorten(entry.progress?.label ?? "-", 12)} </Text>
            <Text dimColor>{shorten(entry.worker ? `worker ${entry.worker.status}` : "", 16)} </Text>
            <Text>{shorten(entry.workflowName ?? "", Math.max(12, width - 100))} </Text>
            <Text dimColor>{formatDuration(entry.durationMs ?? entry.elapsedMs)}</Text>
          </Box>
        ))}
      </Box>
      <Text dimColor>up/down move - enter select - r refresh - q quit</Text>
    </Box>
  );
}
