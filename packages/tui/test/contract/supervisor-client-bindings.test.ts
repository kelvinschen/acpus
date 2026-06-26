import { describe, expect, it } from "vitest";
import { RunSupervisorClient } from "@acpus/bindings";
import type {
  AcpusIr,
  JsonObject,
  NodeExecutionState,
  ReplayResult,
  RunCleanResult,
  RunState,
  RunSummary,
  SupervisorHealth
} from "@acpus/bindings";
import type { RunSupervisorClient as TuiRunSupervisorClient } from "../../src/acpus.js";

describe("generated supervisor client contract", () => {
  it("matches the TUI client surface", () => {
    const client: TuiRunSupervisorClient = new RunSupervisorClient("http://127.0.0.1:1/");
    expect(client.endpoint).toBe("http://127.0.0.1:1");
  });
});

function assertClientMethodTypes(client: TuiRunSupervisorClient): void {
  const health: Promise<SupervisorHealth> = client.health();
  const runs: Promise<RunSummary[]> = client.listRuns();
  const clean: Promise<RunCleanResult> = client.cleanRuns({ dryRun: true });
  const run: Promise<RunState> = client.getRun("run-1");
  const ir: Promise<AcpusIr> = client.getIr("run-1");
  const input: Promise<JsonObject> = client.getInput("run-1");
  const nodes: Promise<NodeExecutionState[]> = client.getNodeStates("run-1");
  const node: Promise<NodeExecutionState> = client.getNode("run-1", "workflow/build");
  const artifact: Promise<string> = client.getArtifactPath("run-1", "artifact://runs/run-1/nodes/build/out.json");
  const retryNode: Promise<NodeExecutionState> = client.retryNode("run-1", "workflow/build");
  const signal: Promise<NodeExecutionState> = client.signalNode("run-1", "workflow/gate", { ok: true });
  const pause: Promise<RunState> = client.pauseRun("run-1");
  const resume: Promise<RunState> = client.resumeRun("run-1");
  const cancel: Promise<RunState> = client.cancelRun("run-1");
  const retryRun: Promise<RunState> = client.retryRun("run-1");
  const replay: Promise<ReplayResult> = client.replay("run-1");

  void health;
  void runs;
  void clean;
  void run;
  void ir;
  void input;
  void nodes;
  void node;
  void artifact;
  void retryNode;
  void signal;
  void pause;
  void resume;
  void cancel;
  void retryRun;
  void replay;
}

void assertClientMethodTypes;
