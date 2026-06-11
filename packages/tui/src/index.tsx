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
  /** Disable mutating Run controls while preserving navigation. */
  readOnly?: boolean;
}

function Root({
  client,
  initialRunId,
  readOnly
}: {
  client: RunSupervisorClient;
  initialRunId?: string;
  readOnly?: boolean;
}): React.ReactElement {
  const [runId, setRunId] = useState<string | undefined>(initialRunId);
  if (!runId) {
    return <RunPicker client={client} onSelect={setRunId} />;
  }
  return <App client={client} runId={runId} readOnly={readOnly} />;
}

/** Launch the TUI. Resolves when the user exits. */
export async function runTui(options: RunTuiOptions): Promise<void> {
  const client = new RunSupervisorClient(options.endpoint);
  client.clientKind = "visualize";
  const { waitUntilExit } = render(<Root client={client} initialRunId={options.runId} readOnly={options.readOnly} />);
  try {
    await waitUntilExit();
  } finally {
    clearTerminalViewport();
  }
}

/** Clear the TUI frame after exit without touching non-interactive output. */
export function clearTerminalViewport(stdout: NodeJS.WriteStream = process.stdout): boolean {
  if (!stdout.isTTY) return false;
  stdout.write("\x1b[2J\x1b[H");
  return true;
}
