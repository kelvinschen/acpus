import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
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
  const status = await Effect.runPromise(Effect.result(requestDaemonStatus(cwd)));
  if (Result.isFailure(status)) throw failureError(status.failure);
  for await (const frame of Stream.toAsyncIterable(Stream.result(requestDaemonSubmitAndObserve(cwd, {
    expectedAuthority: status.success.authority,
    requestId: input.requestId ?? `test:${randomUUID()}`,
    prepared: input.prepared,
    input: input.input,
    ...(input.agentInjections === undefined ? {} : { agentInjections: input.agentInjections }),
    until: "admitted",
  })))) {
    if (Result.isFailure(frame)) throw failureError(frame.failure);
    if (frame.success.kind === "admitted") return frame.success.run;
    if (frame.success.kind === "error") throw failureError(frame.success.error);
  }
  throw new Error("Daemon submission stream ended before admission was confirmed.");
}

function failureError(failure: { message: string; code?: string }): Error & { code?: string } {
  return Object.assign(new Error(failure.message), failure.code === undefined ? {} : { code: failure.code });
}
