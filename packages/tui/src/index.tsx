import React, { useState } from "react";
import { render } from "ink";
import { DaemonClient } from "@acpus/runtime";
import { App } from "./components/App.js";
import { RunPicker } from "./components/RunPicker.js";

export interface RunTuiOptions {
  /** Run to watch. If omitted, a picker is shown. */
  runId?: string;
  /** Daemon base URL (default http://127.0.0.1:3839). */
  baseUrl?: string;
}

function Root({ client, initialRunId }: { client: DaemonClient; initialRunId?: string }): React.ReactElement {
  const [runId, setRunId] = useState<string | undefined>(initialRunId);
  if (!runId) {
    return <RunPicker client={client} onSelect={setRunId} />;
  }
  return <App client={client} runId={runId} />;
}

/** Launch the TUI. Resolves when the user exits. */
export async function runTui(options: RunTuiOptions = {}): Promise<void> {
  const client = new DaemonClient(options.baseUrl);
  const { waitUntilExit } = render(<Root client={client} initialRunId={options.runId} />);
  await waitUntilExit();
}
