import { randomUUID } from "node:crypto";
import type { JsonValue } from "@acpus/expression/ir";
import type { PreparedRunWorkflow } from "@acpus/runtime";
import type { RunControlIntent } from "../../src/scheduler/control.js";
import { openExistingWritableRuntimeStore, type RunDetails } from "../../src/store/store.js";
import { advanceRuntimeRun, applySchedulerControlIntent } from "./scheduler.js";

export type ForkOptions = {
  requestId?: string;
  target?: string;
  prepared?: PreparedRunWorkflow;
  input?: JsonValue;
};

export async function controlRun(
  workspace: string,
  runId: string,
  type: "pause" | "resume" | "retry" | "cancel",
  target?: string,
): Promise<RunDetails> {
  const intent: RunControlIntent = type === "retry" || type === "cancel"
    ? { requestId: `${type}:${randomUUID()}`, runId, type, ...(target === undefined ? {} : { target }) }
    : { requestId: `${type}:${randomUUID()}`, runId, type };
  return await applyControl(workspace, intent);
}
export async function signalRun(
  workspace: string,
  runId: string,
  node: string,
  payload: JsonValue,
  commandIdempotencyKey?: string,
): Promise<{ run: RunDetails }> {
  const requestId = `signal:${randomUUID()}`;
  return {
    run: await applyControl(workspace, {
      requestId,
      runId,
      type: "signal",
      node,
      payload,
      commandIdempotencyKey: commandIdempotencyKey ?? requestId,
    }),
  };
}

async function applyControl(workspace: string, intent: RunControlIntent): Promise<RunDetails> {
  const store = await openExistingWritableRuntimeStore(workspace);
  if (!store) throw new Error("Expected runtime store.");
  try {
    const result = await applySchedulerControlIntent(workspace, store, intent, { ownerId: `test:${intent.requestId}` });
    if (result.advanced?.status === "lease_lost") throw new Error(`Run '${intent.runId}' is controlled by another owner.`);
    const run = store.getRun(intent.runId);
    if (!run) throw new Error(`Run '${intent.runId}' was not found.`);
    return run;
  } finally {
    store.close();
  }
}

export async function forkRun(workspace: string, runId: string, options: ForkOptions = {}): Promise<{ run: RunDetails }> {
  const store = await openExistingWritableRuntimeStore(workspace);
  if (!store) throw new Error("Expected runtime store.");
  try {
    const forkResult = await store.forkRun(runId, options);
    if (forkResult.isErr()) throw Object.assign(new Error(forkResult.error.message), { failure: forkResult.error });
    const fork = forkResult.value;
    const run = store.getRun(fork.id);
    if (!run) throw new Error(`Fork run '${fork.id}' was not found.`);
    return { run };
  } finally {
    store.close();
  }
}

export async function advanceRun(workspace: string, runId: string): Promise<void> {
  const store = await openExistingWritableRuntimeStore(workspace);
  if (!store) throw new Error("Expected runtime store.");
  try {
    await advanceRuntimeRun(workspace, store, runId, `test:${runId}`);
  } finally {
    store.close();
  }
}

export async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error("condition was not met");
}
