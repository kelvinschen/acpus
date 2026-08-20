import { randomUUID } from "node:crypto";
import {
  requestDaemonStatus,
  requestDaemonSubmitAndObserve,
} from "../../src/daemon/client.js";
import type {
  DaemonSubmitAndObserveInput,
} from "../../src/daemon/protocol.js";
import type { RunDetails } from "../../src/store/store.js";

type TestSubmitInput = Omit<
  DaemonSubmitAndObserveInput,
  "expectedAuthority" | "requestId" | "until"
> & { requestId?: string };

export async function submitRunThroughDaemon(
  cwd: string,
  input: TestSubmitInput,
): Promise<RunDetails> {
  const status = await requestDaemonStatus(cwd);
  if (status.isErr()) throw failureError(status.error);
  for await (const frame of requestDaemonSubmitAndObserve(cwd, {
    expectedAuthority: status.value.authority,
    requestId: input.requestId ?? `test:${randomUUID()}`,
    prepared: input.prepared,
    input: input.input,
    ...(input.agentInjections === undefined ? {} : { agentInjections: input.agentInjections }),
    until: "admitted",
  })) {
    if (frame.isErr()) throw failureError(frame.error);
    if (frame.value.kind === "admitted") return frame.value.run;
    if (frame.value.kind === "error") throw failureError(frame.value.error);
  }
  throw new Error("Daemon submission stream ended before admission was confirmed.");
}

function failureError(failure: { message: string; code?: string }): Error & { code?: string } {
  return Object.assign(new Error(failure.message), failure.code === undefined ? {} : { code: failure.code });
}
