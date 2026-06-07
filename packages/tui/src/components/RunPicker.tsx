import React, { useEffect, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import type { RunSupervisorClient, RunSummary } from "@acpus/runtime";

/** Run picker shown when no runId is given. Lists runs from the supervisor. */
export function RunPicker({
  client,
  onSelect
}: {
  client: RunSupervisorClient;
  onSelect: (runId: string) => void;
}): React.ReactElement {
  const { exit } = useApp();
  const [runs, setRuns] = useState<RunSummary[] | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [index, setIndex] = useState(0);

  useEffect(() => {
    client
      .listRuns()
      .then((r) => setRuns(r))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [client]);

  useInput((input, key) => {
    if (input === "q" || (key.ctrl && input === "c")) {
      exit();
      return;
    }
    if (!runs || runs.length === 0) return;
    if (key.upArrow) setIndex((i) => Math.max(0, i - 1));
    if (key.downArrow) setIndex((i) => Math.min(runs.length - 1, i + 1));
    if (key.return) onSelect(runs[index].runId);
  });

  if (error) {
    return (
      <Box padding={1}>
        <Text color="red">Failed to list runs: {error}</Text>
      </Box>
    );
  }
  if (!runs) {
    return (
      <Box padding={1}>
        <Text color="yellow">Loading runs…</Text>
      </Box>
    );
  }
  if (runs.length === 0) {
    return (
      <Box padding={1}>
        <Text color="gray">No runs found. Start one with `acpus run &lt;spec&gt;`.</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text bold color="magenta">
        SELECT A RUN  <Text color="gray">(↑/↓, Enter, q)</Text>
      </Text>
      <Box flexDirection="column" marginTop={1}>
        {runs.map((r, i) => (
          <Text
            key={r.runId}
            color={i === index ? "black" : undefined}
            backgroundColor={i === index ? "cyan" : undefined}
          >
            {r.runId}  {r.workflowName}  [{r.status}]  {r.updatedAt}
          </Text>
        ))}
      </Box>
    </Box>
  );
}
