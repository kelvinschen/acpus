import React, { useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import type { RunMonitorView, WorkUnitDetailView } from "../projections/run-monitor.js";
import type { RunLocator } from "../run-index/locator.js";
import { loadMonitorSnapshot as defaultLoadMonitorSnapshot, loadWorkUnitDetail as defaultLoadWorkUnitDetail } from "./monitor-data.js";
import { clampIndex, defaultStageIndex, detailSummary, nextIndex, runProgressLabel, shorten, stageProgressLabel, statusMark, type MonitorFocus, workUnitsForStage } from "./monitor-rendering.js";

export type MonitorAppProps = {
  runArg: string;
  pollMs?: number;
  initialView?: RunMonitorView;
  initialLocator?: RunLocator;
  initialFocus?: MonitorFocus;
  loadSnapshot?: typeof defaultLoadMonitorSnapshot;
  loadDetail?: typeof defaultLoadWorkUnitDetail;
};

export function MonitorApp({ runArg, pollMs = 1000, initialView, initialLocator, initialFocus = "stages", loadSnapshot = defaultLoadMonitorSnapshot, loadDetail = defaultLoadWorkUnitDetail }: MonitorAppProps) {
  const { exit } = useApp();
  const [locator, setLocator] = useState<RunLocator | undefined>(initialLocator);
  const [view, setView] = useState<RunMonitorView | undefined>(initialView);
  const [error, setError] = useState<string | undefined>();
  const [focus, setFocus] = useState<MonitorFocus>(initialFocus);
  const [stageIndex, setStageIndex] = useState(() => initialView ? defaultStageIndex(initialView.stages) : 0);
  const [workUnitIndex, setWorkUnitIndex] = useState(0);
  const [detail, setDetail] = useState<WorkUnitDetailView | undefined>();
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
  const stageUnits = useMemo(() => workUnitsForStage(view, selectedStage?.id), [view, selectedStage?.id]);
  const selectedUnit = stageUnits[workUnitIndex];

  useEffect(() => {
    setWorkUnitIndex(0);
  }, [selectedStage?.id]);

  useEffect(() => {
    setWorkUnitIndex((current) => clampIndex(current, stageUnits.length));
  }, [stageUnits.length]);

  useEffect(() => {
    const requestId = ++detailRequest.current;
    if (focus !== "detail" || !locator || !selectedUnit) {
      setDetail(undefined);
      return;
    }
    setDetail(undefined);
    loadDetail(locator, selectedUnit.id)
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
  }, [focus, locator?.runId, selectedUnit?.id, loadDetail]);

  useInput((input, key) => {
    if (input === "q" || (key.ctrl && input === "c")) exit();
    if (input === "r") void refresh();
    if (key.escape && focus === "detail") {
      setFocus("workUnits");
      return;
    }
    if (focus === "detail") return;
    if (key.leftArrow) setFocus("stages");
    if (key.rightArrow && stageUnits.length > 0) setFocus("workUnits");
    if (key.upArrow) {
      if (focus === "workUnits") setWorkUnitIndex((current) => nextIndex(current, -1, stageUnits.length));
      else {
        userSelectedStage.current = true;
        setStageIndex((current) => nextIndex(current, -1, view?.stages.length ?? 0));
      }
    }
    if (key.downArrow) {
      if (focus === "workUnits") setWorkUnitIndex((current) => nextIndex(current, 1, stageUnits.length));
      else {
        userSelectedStage.current = true;
        setStageIndex((current) => nextIndex(current, 1, view?.stages.length ?? 0));
      }
    }
    if (key.return && focus === "workUnits" && selectedUnit) setFocus("detail");
  });

  if (!view) {
    return <Text>{error ? `Error: ${error}` : "Loading monitor..."}</Text>;
  }

  return (
    <Box flexDirection="column">
      <Header view={view} />
      {error ? <Text color="red">Error: {error}</Text> : null}
      <Box marginTop={1}>
        <StageList view={view} selectedIndex={stageIndex} focused={focus === "stages"} />
        {focus === "detail"
          ? <DetailPanel detail={detail} />
          : <WorkUnitList stageName={selectedStage?.id ?? ""} units={stageUnits} selectedIndex={workUnitIndex} focused={focus === "workUnits"} />}
      </Box>
      <Text dimColor>up/down move - left/right panel - enter detail - esc back - r refresh - q quit</Text>
    </Box>
  );
}

function Header({ view }: { view: RunMonitorView }) {
  const title = `${view.run.workflowName}`;
  const meta = `${runProgressLabel(view)} - ${view.run.status}`;
  return (
    <Box flexDirection="column">
      <Text color="blue" bold>{title}</Text>
      <Text dimColor>{shorten(view.run.logicalRunId, 48)} - {meta}</Text>
    </Box>
  );
}

function StageList({ view, selectedIndex, focused }: { view: RunMonitorView; selectedIndex: number; focused: boolean }) {
  return (
    <Box flexDirection="column" width={34} borderStyle="single" paddingX={1}>
      <Text bold>{focused ? "> " : "  "}Stages</Text>
      {view.stages.map((stage, index) => (
        <Text key={stage.id} color={index === selectedIndex ? "blue" : undefined}>
          {index === selectedIndex ? ">" : " "} {statusMark(stage.status)} {shorten(stage.id, 18)} {stageProgressLabel(stage)}
        </Text>
      ))}
    </Box>
  );
}

function WorkUnitList({ stageName, units, selectedIndex, focused }: { stageName: string; units: RunMonitorView["workUnits"]; selectedIndex: number; focused: boolean }) {
  return (
    <Box flexDirection="column" flexGrow={1} borderStyle="single" paddingX={1}>
      <Text bold>{focused ? "> " : "  "}{stageName || "Stage"} - {units.length} agents</Text>
      {units.length === 0 ? <Text dimColor>No known Agent Work Units</Text> : null}
      {units.map((unit, index) => (
        <Box key={unit.id}>
          <Text color={index === selectedIndex ? "blue" : undefined}>
            {index === selectedIndex ? ">" : " "} {statusMark(unit.status)} {shorten(unit.label, 32)}
          </Text>
          <Text dimColor> {shorten(unit.agent ?? "", 18)} {shorten(unit.blockedReason ?? unit.errorCode ?? "", 26)}</Text>
        </Box>
      ))}
    </Box>
  );
}

function DetailPanel({ detail }: { detail: WorkUnitDetailView | undefined }) {
  return (
    <Box flexDirection="column" flexGrow={1} borderStyle="single" paddingX={1}>
      <Text bold>{detail?.workUnit.label ?? "Work Unit Detail"}</Text>
      {detailSummary(detail).slice(0, 16).map((line, index) => (
        <Text key={`${index}-${line}`} dimColor={index > 0}>{shorten(line, 100)}</Text>
      ))}
    </Box>
  );
}
