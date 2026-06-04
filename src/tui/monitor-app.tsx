import React, { useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import type { RunMonitorView, RunMonitorTask, TaskDetailView } from "../projections/run-monitor.js";
import type { RunLocator } from "../run-index/locator.js";
import { loadMonitorSnapshot as defaultLoadMonitorSnapshot, loadTaskDetail as defaultLoadTaskDetail } from "./monitor-data.js";
import { clampIndex, defaultStageIndex, detailSummary, formatDuration, nextIndex, runProgressLabel, runStatusLabel, shorten, stageProgressLabel, statusMark, type MonitorFocus, tasksForStage } from "./monitor-rendering.js";

export type MonitorAppProps = {
  runArg: string;
  pollMs?: number;
  initialView?: RunMonitorView;
  initialLocator?: RunLocator;
  initialFocus?: MonitorFocus;
  loadSnapshot?: typeof defaultLoadMonitorSnapshot;
  loadDetail?: typeof defaultLoadTaskDetail;
};

export function MonitorApp({ runArg, pollMs = 1000, initialView, initialLocator, initialFocus = "stages", loadSnapshot = defaultLoadMonitorSnapshot, loadDetail = defaultLoadTaskDetail }: MonitorAppProps) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [locator, setLocator] = useState<RunLocator | undefined>(initialLocator);
  const [view, setView] = useState<RunMonitorView | undefined>(initialView);
  const [error, setError] = useState<string | undefined>();
  const [focus, setFocus] = useState<MonitorFocus>(initialFocus);
  const [stageIndex, setStageIndex] = useState(() => initialView ? defaultStageIndex(initialView.stages) : 0);
  const [taskIndex, setTaskIndex] = useState<number | undefined>(undefined);
  const [detailTaskId, setDetailTaskId] = useState<string | undefined>();
  const [detail, setDetail] = useState<TaskDetailView | undefined>();
  const refreshRequest = useRef(0);
  const detailRequest = useRef(0);
  const hasLoadedView = useRef(Boolean(initialView));
  const userSelectedStage = useRef(false);

  async function refresh() {
    const requestId = ++refreshRequest.current;
    try {
      const snapshot = await loadSnapshot(runArg);
      if (requestId !== refreshRequest.current) return;
      const shouldSelectDefaultStage = !hasLoadedView.current && !userSelectedStage.current;
      setLocator(snapshot.locator);
      setView(snapshot.view);
      setError(undefined);
      setStageIndex((current) => {
        if (shouldSelectDefaultStage) return defaultStageIndex(snapshot.view.stages);
        return clampIndex(current, snapshot.view.stages.length);
      });
      hasLoadedView.current = true;
    } catch (loadError) {
      if (requestId !== refreshRequest.current) return;
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    }
  }

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), pollMs);
    return () => clearInterval(timer);
  }, [runArg, pollMs, loadSnapshot]);

  const selectedStage = view?.stages[stageIndex];
  const stageTasks = useMemo(() => tasksForStage(view, selectedStage?.id), [view, selectedStage?.id]);
  const selectedTask = taskIndex === undefined ? undefined : stageTasks[taskIndex];
  const panelWidths = useMemo(() => monitorPanelWidths(stdout.columns), [stdout.columns]);

  useEffect(() => {
    setTaskIndex(undefined);
    setDetailTaskId(undefined);
    setDetail(undefined);
  }, [selectedStage?.id]);

  useEffect(() => {
    setTaskIndex((current) => current === undefined ? undefined : clampIndex(current, stageTasks.length));
  }, [stageTasks.length]);

  useEffect(() => {
    setDetailTaskId(selectedTask?.id);
  }, [selectedTask?.id]);

  useEffect(() => {
    const requestId = ++detailRequest.current;
    if (!locator || !detailTaskId) {
      setDetail(undefined);
      return;
    }
    setDetail(undefined);
    loadDetail(locator, detailTaskId)
      .then((nextDetail) => {
        if (requestId !== detailRequest.current) return;
        setDetail(nextDetail);
        setError(undefined);
      })
      .catch((detailError) => {
        if (requestId !== detailRequest.current) return;
        setDetail(undefined);
        setError(detailError instanceof Error ? detailError.message : String(detailError));
      });
  }, [locator?.runId, detailTaskId, loadDetail]);

  useInput((input, key) => {
    if (input === "q" || (key.ctrl && input === "c")) exit();
    if (input === "r") void refresh();
    if (key.escape && focus === "detail") {
      setFocus("tasks");
      return;
    }
    if (key.leftArrow) {
      if (focus === "detail") setFocus("tasks");
      else if (focus === "tasks") setFocus("stages");
      return;
    }
    if (key.rightArrow) {
      if (focus === "stages" && stageTasks.length > 0) {
        setTaskIndex((current) => current ?? 0);
        setFocus("tasks");
      } else if (focus === "tasks" && selectedTask) {
        setFocus("detail");
      }
      return;
    }
    if (key.upArrow) {
      if (focus === "tasks") setTaskIndex((current) => nextIndex(current ?? 0, -1, stageTasks.length));
      else if (focus === "stages") {
        userSelectedStage.current = true;
        setStageIndex((current) => nextIndex(current, -1, view?.stages.length ?? 0));
      }
    }
    if (key.downArrow) {
      if (focus === "tasks") setTaskIndex((current) => nextIndex(current ?? 0, 1, stageTasks.length));
      else if (focus === "stages") {
        userSelectedStage.current = true;
        setStageIndex((current) => nextIndex(current, 1, view?.stages.length ?? 0));
      }
    }
    if (key.return && focus === "tasks" && selectedTask) setFocus("detail");
  });

  if (!view) {
    return <Text>{error ? `Error: ${error}` : "Loading monitor..."}</Text>;
  }

  return (
    <Box flexDirection="column">
      <Header view={view} />
      {error ? <Text color="red">Error: {error}</Text> : null}
      <Box marginTop={1}>
        <StageList view={view} selectedIndex={stageIndex} focused={focus === "stages"} width={panelWidths.stages} />
        <StageTaskPanel view={view} stage={selectedStage} tasks={stageTasks} selectedIndex={taskIndex} focused={focus === "tasks"} width={panelWidths.tasks} />
        <DetailPanel detail={detail} focused={focus === "detail"} width={panelWidths.detail} />
      </Box>
      <Text dimColor>up/down move - left/right panel - enter detail - esc back - r refresh - q quit</Text>
    </Box>
  );
}

function Header({ view }: { view: RunMonitorView }) {
  const title = `${view.run.workflowName}`;
  const worker = view.run.worker ? ` - worker ${view.run.worker.status}` : "";
  const runTime = formatDuration(view.run.durationMs ?? view.run.elapsedMs);
  const meta = `${runProgressLabel(view)} - ${runStatusLabel(view)}${runTime ? ` - ${runTime}` : ""}${worker}`;
  return (
    <Box flexDirection="column">
      <Text color="blue" bold>{title}</Text>
      <Text dimColor>{shorten(view.run.logicalRunId, 48)} - {meta}</Text>
    </Box>
  );
}

function StageList({ view, selectedIndex, focused, width }: { view: RunMonitorView; selectedIndex: number; focused: boolean; width: number }) {
  const currentStage = view.stages.find((stage) => stage.status === "running")
    ?? view.stages.find((stage) => stage.status === "blocked" || stage.status === "failed")
    ?? view.stages[selectedIndex];
  const finished = view.stages.filter((stage) => stage.status === "completed" || stage.status === "skipped").length;
  return (
    <Box flexDirection="column" width={width} borderStyle="single" paddingX={1}>
      <Text bold>{focused ? "🟢 " : "  "}Stage List</Text>
      <Text dimColor>Current: {shorten(currentStage?.id ?? "-", Math.max(6, width - 13))}</Text>
      <Text dimColor>Finished: {finished}/{view.stages.length}</Text>
      {view.stages.map((stage, index) => (
        <Box key={stage.id}>
          <Text>{focused && index === selectedIndex ? "▶" : " "} </Text>
          <StatusMark status={stage.status} />
          <Text> {shorten(stage.id, 22)} {stageProgressLabel(stage)}</Text>
        </Box>
      ))}
    </Box>
  );
}

function StageTaskPanel({ view, stage, tasks, selectedIndex, focused, width }: { view: RunMonitorView; stage: RunMonitorView["stages"][number] | undefined; tasks: RunMonitorTask[]; selectedIndex: number | undefined; focused: boolean; width: number }) {
  const counts = stage?.taskCounts;
  const stageTime = formatDuration(stage?.durationMs ?? stage?.elapsedMs);
  return (
    <Box flexDirection="column" width={width} borderStyle="single" paddingX={1}>
      <Text bold>{focused ? "🟢 " : "  "}Stage Info</Text>
      {stage ? (
        <>
          <Text>{shorten(stage.id, 28)} <Text dimColor>{stage.kind}</Text></Text>
          <Text>Status: {stage.status}{counts ? ` - ${counts.completed}/${counts.total} tasks` : ""}{stageTime ? ` - ${stageTime}` : ""}</Text>
          {stage.dependsOn.length > 0 ? <Text dimColor>Depends: {shorten(stage.dependsOn.join(", "), 34)}</Text> : null}
          {stage.blockedReason ? <Text color="red">Reason: {shorten(stage.blockedReason, 34)}</Text> : null}
          {stage.outputPath ? <Text dimColor>Output: {shorten(stage.outputPath, 34)}</Text> : null}
          {stage.kind === "gate" && view.run.gateVerdict ? <Text dimColor>Gate: {view.run.gateVerdict}</Text> : null}
        </>
      ) : <Text dimColor>No stage selected</Text>}
      <Text bold>Tasks</Text>
      {tasks.length === 0 ? <Text dimColor>No known Stage Tasks</Text> : null}
      {tasks.map((task, index) => (
        <Box key={task.id}>
          <Text>{focused && index === selectedIndex ? "▶" : " "} </Text>
          <StatusMark status={task.status} />
          <Text> {shorten(task.label, Math.max(16, width - 24))}</Text>
          <Text dimColor> {shorten(task.agent ?? task.execution, 10)} {shorten(formatDuration(task.durationMs ?? task.elapsedMs), 7)} {shorten(task.blockedReason ?? task.errorCode ?? "", 10)}</Text>
        </Box>
      ))}
    </Box>
  );
}

function DetailPanel({ detail, focused, width }: { detail: TaskDetailView | undefined; focused: boolean; width: number }) {
  return (
    <Box flexDirection="column" width={width} borderStyle="single" paddingX={1}>
      <Text bold>{focused ? "🟢 " : "  "}Task Detail</Text>
      {detail ? <Text>{shorten(detail.task.label, 60)}</Text> : null}
      {detailSummary(detail).slice(0, 16).map((line, index) => (
        <Text key={`${index}-${line}`} dimColor={index > 0}>{shorten(line, 100)}</Text>
      ))}
    </Box>
  );
}

function monitorPanelWidths(columns: number | undefined): { stages: number; tasks: number; detail: number } {
  const total = Math.max(80, columns ?? 120);
  const stages = Math.max(16, Math.floor(total * 0.2));
  const tasks = Math.max(40, Math.floor(total * 0.5));
  const detail = Math.max(32, total - stages - tasks);
  return { stages, tasks, detail };
}

function StatusMark({ status }: { status: string | undefined }) {
  const mark = statusMark(status);
  if (status === "completed") return <Text color="green">{mark}</Text>;
  if (status === "running" || status === "raw_received" || status === "parsing") return <Text color="yellow">{mark}</Text>;
  if (status === "blocked" || status === "failed" || status === "cancelled" || status === "timed_out") return <Text color="red">{mark}</Text>;
  if (status === "skipped") return <Text dimColor>{mark}</Text>;
  return <Text dimColor>{mark}</Text>;
}
