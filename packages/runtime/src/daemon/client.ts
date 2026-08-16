import { connect } from "node:net";
import { StringDecoder } from "node:string_decoder";
import { err, ok, ResultAsync, type Result } from "neverthrow";
import { resolveRuntimeWorkspaceLayout } from "../runtime-layout.js";
import { sameRuntimeAuthority } from "./authority.js";
import {
  classifyDaemonStatus,
  describeDaemonRequest,
  isDaemonControlResult,
  isDaemonResponse,
  isDaemonRunStreamFrame,
  isDaemonShutdownResult,
  isDaemonStatus,
  type DaemonClientFailure,
  type DaemonControlIntent,
  type DaemonControlResult,
  type DaemonRequest,
  type DaemonResponse,
  type DaemonRunStreamClientFailure,
  type DaemonRunStreamFrame,
  type DaemonShutdownResult,
  type DaemonStatus,
  type DaemonStatusProbe,
  type DaemonSubmitAndObserveInput,
} from "./protocol.js";

export function daemonEndpoint(cwd: string): string {
  return resolveRuntimeWorkspaceLayout(cwd).daemonEndpoint;
}

export function requestDaemonStatus(cwd: string): ResultAsync<DaemonStatus, DaemonClientFailure> {
  return requestDaemonStatusAtEndpoint(daemonEndpoint(cwd));
}

export function requestDaemonStatusAtEndpoint(endpoint: string): ResultAsync<DaemonStatus, DaemonClientFailure> {
  const request = { method: "status" } as const;
  return requestDaemon(endpoint, request).andThen(response => daemonResult(request, response, isDaemonStatus));
}

/**
 * Probes only the closed current status shape and the one explicitly supported
 * predecessor shape. Everything else remains occupied but unknown to callers.
 */
export function requestDaemonStatusProbe(cwd: string): ResultAsync<DaemonStatusProbe, DaemonClientFailure> {
  return requestDaemonStatusProbeAtEndpoint(daemonEndpoint(cwd));
}

export function requestDaemonStatusProbeAtEndpoint(endpoint: string): ResultAsync<DaemonStatusProbe, DaemonClientFailure> {
  const request = { method: "status" } as const;
  return requestDaemon(endpoint, request).andThen(response => {
    if (!response.ok) return err({
      type: "rejected" as const,
      code: response.error.code,
      message: response.error.message,
      ...(response.error.ambiguity ? { ambiguity: true as const } : {}),
    });
    return ok(classifyDaemonStatus(response.result));
  });
}

export function requestDaemonControl(
  cwd: string,
  control: DaemonControlIntent,
): ResultAsync<DaemonControlResult, DaemonClientFailure> {
  const request = { method: "control", control } as const;
  return requestDaemon(daemonEndpoint(cwd), request).andThen(response => daemonResult(
    request,
    response,
    value => isDaemonControlResult(value, control.type),
  ));
}

export function requestDaemonSubmitAndObserve(
  cwd: string,
  input: DaemonSubmitAndObserveInput,
  options: { signal?: AbortSignal } = {},
): AsyncIterable<Result<DaemonRunStreamFrame, DaemonRunStreamClientFailure>> {
  return daemonRunStream(cwd, { ...input, method: "submitAndObserve" }, options.signal);
}

export function requestDaemonShutdown(cwd: string): ResultAsync<DaemonShutdownResult, DaemonClientFailure> {
  return requestDaemonShutdownAtEndpoint(daemonEndpoint(cwd));
}

export function requestDaemonShutdownAtEndpoint(endpoint: string): ResultAsync<DaemonShutdownResult, DaemonClientFailure> {
  const request = { method: "shutdown" } as const;
  return requestDaemon(endpoint, request).andThen(response => daemonResult(request, response, isDaemonShutdownResult));
}

/** The v3 retirement bridge deliberately exposes shutdown and nothing mutable. */
export function requestPredecessorDaemonShutdown(cwd: string): ResultAsync<DaemonShutdownResult, DaemonClientFailure> {
  return requestDaemonShutdown(cwd);
}

export function requestPredecessorDaemonShutdownAtEndpoint(endpoint: string): ResultAsync<DaemonShutdownResult, DaemonClientFailure> {
  return requestDaemonShutdownAtEndpoint(endpoint);
}

export async function probeDaemonEndpoint(cwd: string): Promise<boolean> {
  const endpoint = daemonEndpoint(cwd);
  return await new Promise(resolveProbe => {
    const socket = connect(endpoint);
    let settled = false;
    const finish = (occupied: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.destroy();
      resolveProbe(occupied);
    };
    const timeout = setTimeout(() => finish(true), 1_000);
    socket.once("connect", () => finish(true));
    socket.once("error", error => finish(!isDefinitivelyUnbound(error)));
  });
}

function isDefinitivelyUnbound(error: NodeJS.ErrnoException): boolean {
  return error.code === "ENOENT" || error.code === "ENOTDIR" || error.code === "ECONNREFUSED";
}

function requestDaemon(
  endpoint: string,
  request: Exclude<DaemonRequest, { method: "submitAndObserve" }>,
): ResultAsync<DaemonResponse, Extract<DaemonClientFailure, { type: "transport" | "protocol" }>> {
  return new ResultAsync(new Promise(resolveRequest => {
    const socket = connect(endpoint);
    const chunks: Buffer[] = [];
    const timeoutMs = request.method === "control" ? 30_000 : 1_000;
    const timeout = setTimeout(() => {
      socket.destroy();
      resolveRequest(err({
        type: "transport",
        reason: "timeout",
        method: request.method,
        message: `Timed out waiting for daemon ${describeDaemonRequest(request)} response.`,
      }));
    }, timeoutMs);
    socket.once("error", error => {
      clearTimeout(timeout);
      resolveRequest(err(daemonTransportFailure(request, error)));
    });
    socket.on("data", chunk => chunks.push(Buffer.from(chunk)));
    socket.once("end", () => {
      clearTimeout(timeout);
      try {
        const response = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
        if (!isDaemonResponse(response)) {
          resolveRequest(err({
            type: "protocol",
            stage: "envelope",
            method: request.method,
            message: "Daemon returned an invalid response.",
          }));
          return;
        }
        resolveRequest(ok(response));
      } catch {
        resolveRequest(err({
          type: "protocol",
          stage: "envelope",
          method: request.method,
          message: "Daemon returned invalid response JSON.",
        }));
      }
    });
    socket.once("connect", () => {
      socket.end(JSON.stringify(request));
    });
  }));
}

async function* daemonRunStream(
  cwd: string,
  request: Extract<DaemonRequest, { method: "submitAndObserve" }>,
  signal?: AbortSignal,
): AsyncIterable<Result<DaemonRunStreamFrame, DaemonRunStreamClientFailure>> {
  if (signal?.aborted) return;
  const socket = connect(daemonEndpoint(cwd));
  const decoder = new StringDecoder("utf8");
  const queue = new AsyncEventQueue<Result<DaemonRunStreamFrame, DaemonRunStreamClientFailure>>();
  let pending = "";
  let finished = false;
  let ended = false;
  let requestSent = false;
  let receivedFrame = false;
  let terminalFrame = false;
  let admittedRunId: string | undefined;
  let terminalOutcome: DaemonRunStreamClientFailure["outcome"] | undefined;
  let terminalRunId: string | undefined;

  const outcome = (): DaemonRunStreamClientFailure["outcome"] =>
    admittedRunId === undefined ? terminalOutcome ?? (requestSent ? "unknown" : "not-admitted") : "admitted";
  const outcomeRunId = (): string | undefined => admittedRunId ?? terminalRunId;
  const finish = (): void => {
    if (finished) return;
    finished = true;
    queue.end();
  };
  const fail = (failure: DaemonRunStreamClientFailure): void => {
    if (finished) return;
    finished = true;
    queue.push(err(failure));
    queue.end();
    socket.destroy();
  };
  const protocolFailure = (
    stage: "frame" | "stream",
    reason: "malformed" | "unexpected" | "truncated",
    message: string,
  ): DaemonRunStreamClientFailure => {
    const runId = outcomeRunId();
    return {
      type: "protocol",
      stage,
      reason,
      method: "submitAndObserve",
      outcome: outcome(),
      ...(runId === undefined ? {} : { runId }),
      message,
    };
  };
  const acceptFrame = (value: unknown): void => {
    if (!isDaemonRunStreamFrame(value)) {
      fail(protocolFailure("frame", "malformed", "Daemon returned a malformed run stream frame."));
      return;
    }
    if (terminalFrame) {
      fail(protocolFailure("stream", "unexpected", "Daemon returned a frame after the run stream had closed."));
      return;
    }
    if (value.kind === "admitted") {
      if (receivedFrame) {
        fail(protocolFailure("stream", "unexpected", "Daemon returned an unexpected admitted frame."));
        return;
      }
      admittedRunId = value.run.id;
      if (!sameRuntimeAuthority(value.authority, request.expectedAuthority)) {
        fail(protocolFailure("stream", "unexpected", "Daemon admitted the run under a different Runtime authority."));
        return;
      }
      if (request.until === "admitted") terminalFrame = true;
    } else if (value.kind === "observation") {
      if (admittedRunId === undefined || request.until === "admitted") {
        fail(protocolFailure("stream", "unexpected", "Daemon returned an observation before admission."));
        return;
      }
      if (value.observation.kind === "closed") terminalFrame = true;
    } else {
      if (admittedRunId !== undefined
        && (value.outcome !== "admitted" || value.runId !== undefined && value.runId !== admittedRunId)) {
        fail(protocolFailure("stream", "unexpected", "Daemon returned an inconsistent post-admission error outcome."));
        return;
      }
      terminalOutcome = value.outcome;
      terminalRunId = value.runId;
      terminalFrame = true;
    }
    receivedFrame = true;
    queue.push(ok(value));
  };
  const acceptLine = (line: string): void => {
    if (finished) return;
    try {
      acceptFrame(JSON.parse(line) as unknown);
    } catch {
      fail(protocolFailure("frame", "malformed", "Daemon returned malformed run stream JSON."));
    }
  };
  const acceptText = (text: string): void => {
    pending += text;
    let newline = pending.indexOf("\n");
    while (newline >= 0 && !finished) {
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      acceptLine(line);
      newline = pending.indexOf("\n");
    }
  };

  const abort = (): void => {
    if (finished) return;
    finished = true;
    socket.destroy();
    queue.end();
  };
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  socket.once("connect", () => {
    if (finished) return;
    requestSent = true;
    socket.write(`${JSON.stringify(request)}\n`);
  });
  socket.on("data", chunk => acceptText(decoder.write(Buffer.from(chunk))));
  socket.once("end", () => {
    ended = true;
    if (finished) return;
    acceptText(decoder.end());
    if (finished) return;
    if (pending.length > 0) {
      fail(protocolFailure("stream", "truncated", "Daemon truncated a run stream frame."));
      return;
    }
    if (!terminalFrame) {
      fail(protocolFailure("stream", "truncated", "Daemon ended the run stream before its terminal frame."));
      return;
    }
    finish();
  });
  socket.once("error", error => {
    if (finished) return;
    const failure = daemonRunStreamTransportFailure(error, outcome(), outcomeRunId());
    fail(failure);
  });
  socket.once("close", () => {
    if (finished || ended) return;
    fail(daemonRunStreamTransportFailure(
      new Error("Daemon closed the run stream connection."),
      outcome(),
      outcomeRunId(),
    ));
  });

  try {
    for await (const event of queue) yield event;
  } finally {
    signal?.removeEventListener("abort", abort);
    socket.destroy();
  }
}

function daemonResult<T>(
  request: Exclude<DaemonRequest, { method: "submitAndObserve" }>,
  response: DaemonResponse,
  validate: (value: unknown) => value is T,
): Result<T, DaemonClientFailure> {
  if (!response.ok) return err({
    type: "rejected",
    code: response.error.code,
    message: response.error.message,
    ...(response.error.ambiguity ? { ambiguity: true } : {}),
  });
  return validate(response.result)
    ? ok(response.result)
    : err({
      type: "protocol",
      stage: "result",
      method: request.method,
      message: `Daemon returned an invalid ${describeDaemonRequest(request)} result.`,
    });
}

function daemonTransportFailure(
  request: Exclude<DaemonRequest, { method: "submitAndObserve" }>,
  error: NodeJS.ErrnoException,
): Extract<DaemonClientFailure, { type: "transport" }> {
  const reason = error.code === "ENOENT" || error.code === "ENOTDIR"
    ? "not-found"
    : error.code === "ECONNREFUSED"
      ? "refused"
      : "io";
  return {
    type: "transport",
    reason,
    method: request.method,
    ...(error.code === undefined ? {} : { errno: error.code }),
    message: error.message,
  };
}

function daemonRunStreamTransportFailure(
  error: NodeJS.ErrnoException,
  outcome: DaemonRunStreamClientFailure["outcome"],
  runId?: string,
): Extract<DaemonRunStreamClientFailure, { type: "transport" }> {
  const reason = error.code === "ENOENT" || error.code === "ENOTDIR"
    ? "not-found"
    : error.code === "ECONNREFUSED"
      ? "refused"
      : "io";
  return {
    type: "transport",
    reason,
    method: "submitAndObserve",
    outcome,
    ...(runId === undefined ? {} : { runId }),
    ...(error.code === undefined ? {} : { errno: error.code }),
    message: error.message,
  };
}

type AsyncQueueWaiter<T> = (event: IteratorResult<T>) => void;

class AsyncEventQueue<T> implements AsyncIterable<T> {
  private readonly values: T[] = [];
  private readonly waiters: AsyncQueueWaiter<T>[] = [];
  private done = false;

  push(value: T): void {
    if (this.done) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ done: false, value });
    else this.values.push(value);
  }

  end(): void {
    if (this.done) return;
    this.done = true;
    for (const waiter of this.waiters.splice(0)) waiter({ done: true, value: undefined });
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    while (true) {
      const value = this.values.shift();
      if (value !== undefined) {
        yield value;
        continue;
      }
      if (this.done) return;
      const next = await new Promise<IteratorResult<T>>(resolve => this.waiters.push(resolve));
      if (next.done) return;
      yield next.value;
    }
  }
}
