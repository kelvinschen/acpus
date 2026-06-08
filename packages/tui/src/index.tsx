import React, { useState } from "react";
import { render } from "ink";
import { RunSupervisorClient } from "@acpus/runtime";
import { App } from "./components/App.js";
import { RunPicker } from "./components/RunPicker.js";

export interface RunTuiOptions {
  /** Run to visualize. If omitted, a picker is shown. */
  runId?: string;
  /** Supervisor endpoint URL (required). */
  endpoint: string;
}

function Root({ client, initialRunId }: { client: RunSupervisorClient; initialRunId?: string }): React.ReactElement {
  const [runId, setRunId] = useState<string | undefined>(initialRunId);
  if (!runId) {
    return <RunPicker client={client} onSelect={setRunId} />;
  }
  return <App client={client} runId={runId} />;
}

/** Launch the TUI. Resolves when the user exits. */
export async function runTui(options: RunTuiOptions): Promise<void> {
  const client = new RunSupervisorClient(options.endpoint);
  client.clientKind = "visualize";
  const { waitUntilExit } = render(<Root client={client} initialRunId={options.runId} />);
  await waitUntilExit();
}
