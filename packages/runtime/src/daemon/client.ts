import { connect } from "node:net";
import { StringDecoder } from "node:string_decoder";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import { resolveRuntimeWorkspaceLayout } from "../runtime-layout.js";
import { sameRuntimeAuthority } from "./authority.js";
import {
  classifyDaemonStatus,
  describeDaemonRequest,
  isDaemonControlResult,
  isDaemonInspectionResult,
  isDaemonResponse,
  isDaemonRunStreamFrame,
  isDaemonShutdownResult,
  isDaemonStatus,
  type DaemonClientFailure,
  type DaemonControlIntent,
  type DaemonControlResult,
  type DaemonInspectionResult,
  type DaemonRequest,
  type DaemonResponse,
  type DaemonRunStreamClientFailure,
  type DaemonRunStreamFrame,
  type DaemonShutdownResult,
  type DaemonStatus,
  type DaemonStatusProbe,
  type DaemonSubmitAndObserveInput,
} from "./protocol.js";
import type { ObservableInspectionViewQuery } from "../inspection/types.js";

export function daemonEndpoint(cwd: string): string {
  return resolveRuntimeWorkspaceLayout(cwd).daemonEndpoint;
}

export function requestDaemonStatus(cwd: string): Effect.Effect<DaemonStatus, DaemonClientFailure> {
  return requestDaemonStatusAtEndpoint(daemonEndpoint(cwd));
}

export function requestDaemonStatusAtEndpointResult(
  endpoint: string,
): Effect.Effect<Result.Result<DaemonStatus, DaemonClientFailure>> {
  return Effect.result(requestDaemonStatusAtEndpoint(endpoint));
}

function requestDaemonStatusAtEndpoint(
  endpoint: string,
): Effect.Effect<DaemonStatus, DaemonClientFailure> {
  const request = { method: "status" } as const;
  return requestDaemon(endpoint, request).pipe(
    Effect.flatMap(response => Effect.fromResult(daemonResult(request, response, isDaemonStatus))),
  );
}

/**
 * Probes only the closed current status shape and the one explicitly supported
 * predecessor shape. Everything else remains occupied but unknown to callers.
 */
export function requestDaemonStatusProbe(cwd: string): Effect.Effect<DaemonStatusProbe, DaemonClientFailure> {
  return requestDaemonStatusProbeAtEndpoint(daemonEndpoint(cwd));
}

export function requestDaemonStatusProbeAtEndpointResult(
  endpoint: string,
): Effect.Effect<Result.Result<DaemonStatusProbe, DaemonClientFailure>> {
  return Effect.result(requestDaemonStatusProbeAtEndpoint(endpoint));
}

function requestDaemonStatusProbeAtEndpoint(
  endpoint: string,
): Effect.Effect<DaemonStatusProbe, DaemonClientFailure> {
  const request = { method: "status" } as const;
  return requestDaemon(endpoint, request).pipe(Effect.flatMap(response => response.ok
    ? Effect.succeed(classifyDaemonStatus(response.result))
    : Effect.fail({
      type: "rejected" as const,
      code: response.error.code,
      message: response.error.message,
      ...(response.error.ambiguity ? { ambiguity: true as const } : {}),
    })));
}

export function requestDaemonControl(
  cwd: string,
  control: DaemonControlIntent,
): Effect.Effect<DaemonControlResult, DaemonClientFailure> {
  const request = { method: "control", control } as const;
  return requestDaemon(daemonEndpoint(cwd), request).pipe(
    Effect.flatMap(response => Effect.fromResult(daemonResult(
      request,
      response,
      candidate => isDaemonControlResult(candidate, control.type),
    ))),
  );
}

export function requestDaemonInspection(
  cwd: string,
  view: ObservableInspectionViewQuery,
): Effect.Effect<DaemonInspectionResult, DaemonClientFailure> {
  const request = { method: "inspect", view } as const;
  return requestDaemon(daemonEndpoint(cwd), request).pipe(
    Effect.flatMap(response => Effect.fromResult(daemonResult(request, response, isDaemonInspectionResult))),
  );
}

export function requestDaemonSubmitAndObserve(
  cwd: string,
  input: DaemonSubmitAndObserveInput,
  options: { signal?: AbortSignal } = {},
): Stream.Stream<DaemonRunStreamFrame, DaemonRunStreamClientFailure> {
  return daemonRunStream(cwd, { ...input, method: "submitAndObserve" }, options.signal);
}

export function requestDaemonShutdown(cwd: string): Effect.Effect<DaemonShutdownResult, DaemonClientFailure> {
  return requestDaemonShutdownAtEndpoint(daemonEndpoint(cwd));
}

export function requestDaemonShutdownAtEndpointResult(
  endpoint: string,
): Effect.Effect<Result.Result<DaemonShutdownResult, DaemonClientFailure>> {
  return Effect.result(requestDaemonShutdownAtEndpoint(endpoint));
}

function requestDaemonShutdownAtEndpoint(
  endpoint: string,
): Effect.Effect<DaemonShutdownResult, DaemonClientFailure> {
  const request = { method: "shutdown" } as const;
  return requestDaemon(endpoint, request).pipe(
    Effect.flatMap(response => Effect.fromResult(daemonResult(request, response, isDaemonShutdownResult))),
  );
}

/** The v3 retirement bridge deliberately exposes shutdown and nothing mutable. */
export function requestPredecessorDaemonShutdown(cwd: string): Effect.Effect<DaemonShutdownResult, DaemonClientFailure> {
  return requestDaemonShutdown(cwd);
}

export function requestPredecessorDaemonShutdownAtEndpointResult(
  endpoint: string,
): Effect.Effect<Result.Result<DaemonShutdownResult, DaemonClientFailure>> {
  return requestDaemonShutdownAtEndpointResult(endpoint);
}

export function probeDaemonEndpoint(cwd: string): Effect.Effect<boolean> {
  return probeDaemonEndpointValue(cwd);
}

export function probeDaemonEndpointValue(cwd: string): Effect.Effect<boolean> {
  const endpoint = daemonEndpoint(cwd);
  return Effect.scoped(Effect.acquireRelease(
    Effect.sync(() => connect(endpoint)),
    socket => Effect.sync(() => socket.destroy()),
  ).pipe(
    Effect.flatMap(socket => probeSocket(socket)),
    Effect.timeoutOrElse({ duration: 1_000, orElse: () => Effect.succeed(true) }),
  ));
}

function isDefinitivelyUnbound(error: NodeJS.ErrnoException): boolean {
  return error.code === "ENOENT" || error.code === "ENOTDIR" || error.code === "ECONNREFUSED";
}

function requestDaemon(
  endpoint: string,
  request: Exclude<DaemonRequest, { method: "submitAndObserve" }>,
): Effect.Effect<DaemonResponse, Extract<DaemonClientFailure, { type: "transport" | "protocol" }>> {
  const timeoutMs = request.method === "control" ? 30_000 : request.method === "inspect" ? 5_000 : 1_000;
  return Effect.scoped(Effect.acquireRelease(
    Effect.sync(() => connect(endpoint)),
    socket => Effect.sync(() => socket.destroy()),
  ).pipe(
    Effect.flatMap(socket => exchangeDaemonRequest(socket, request)),
    Effect.timeoutOrElse({
      duration: timeoutMs,
      orElse: () => Effect.fail({
        type: "transport" as const,
        reason: "timeout" as const,
        method: request.method,
        message: `Timed out waiting for daemon ${describeDaemonRequest(request)} response.`,
      }),
    }),
  ));
}

function probeSocket(socket: ReturnType<typeof connect>): Effect.Effect<boolean> {
  return Effect.callback<boolean>(resume => {
    let settled = false;
    const cleanup = (): void => {
      socket.off("connect", connected);
      socket.off("error", failed);
    };
    const finish = (occupied: boolean): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resume(Effect.succeed(occupied));
    };
    const connected = (): void => finish(true);
    const failed = (error: NodeJS.ErrnoException): void => finish(!isDefinitivelyUnbound(error));
    socket.once("connect", connected);
    socket.once("error", failed);
    return Effect.sync(cleanup);
  });
}

function exchangeDaemonRequest(
  socket: ReturnType<typeof connect>,
  request: Exclude<DaemonRequest, { method: "submitAndObserve" }>,
): Effect.Effect<DaemonResponse, Extract<DaemonClientFailure, { type: "transport" | "protocol" }>> {
  return Effect.callback<DaemonResponse, Extract<DaemonClientFailure, { type: "transport" | "protocol" }>>(resume => {
    const chunks: Buffer[] = [];
    let settled = false;
    const cleanup = (): void => {
      socket.off("error", failed);
      socket.off("data", received);
      socket.off("end", ended);
      socket.off("connect", connected);
    };
    const settle = (effect: Effect.Effect<DaemonResponse, Extract<DaemonClientFailure, { type: "transport" | "protocol" }>>): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resume(effect);
    };
    const failed = (error: NodeJS.ErrnoException): void => settle(Effect.fail(daemonTransportFailure(request, error)));
    const received = (chunk: Buffer): void => {
      chunks.push(Buffer.from(chunk));
    };
    const ended = (): void => {
      try {
        const response = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
        if (!isDaemonResponse(response)) {
          settle(Effect.fail({
            type: "protocol",
            stage: "envelope",
            method: request.method,
            message: "Daemon returned an invalid response.",
          }));
          return;
        }
        settle(Effect.succeed(response));
      } catch {
        settle(Effect.fail({
          type: "protocol",
          stage: "envelope",
          method: request.method,
          message: "Daemon returned invalid response JSON.",
        }));
      }
    };
    const connected = (): void => {
      socket.end(JSON.stringify(request));
    };
    socket.once("error", failed);
    socket.on("data", received);
    socket.once("end", ended);
    socket.once("connect", connected);
    return Effect.sync(cleanup);
  });
}

function daemonRunStream(
  cwd: string,
  request: Extract<DaemonRequest, { method: "submitAndObserve" }>,
  signal?: AbortSignal,
): Stream.Stream<DaemonRunStreamFrame, DaemonRunStreamClientFailure> {
  if (signal?.aborted) return Stream.empty;
  return Stream.callback<DaemonRunStreamFrame, DaemonRunStreamClientFailure>(queue =>
    Effect.acquireRelease(
      Effect.sync(() => {
        const socket = connect(daemonEndpoint(cwd));
        const decoder = new StringDecoder("utf8");
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
          Queue.endUnsafe(queue);
        };
        const fail = (failure: DaemonRunStreamClientFailure): void => {
          if (finished) return;
          finished = true;
          Queue.failCauseUnsafe(queue, Cause.fail(failure));
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
          Queue.offerUnsafe(queue, value);
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
          Queue.endUnsafe(queue);
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
          fail(daemonRunStreamTransportFailure(error, outcome(), outcomeRunId()));
        });
        socket.once("close", () => {
          if (finished || ended) return;
          fail(daemonRunStreamTransportFailure(
            new Error("Daemon closed the run stream connection."),
            outcome(),
            outcomeRunId(),
          ));
        });
        return { abort, socket };
      }),
      ({ abort, socket }) => Effect.sync(() => {
        signal?.removeEventListener("abort", abort);
        socket.destroy();
      }),
    ));
}

function daemonResult<T>(
  request: Exclude<DaemonRequest, { method: "submitAndObserve" }>,
  response: DaemonResponse,
  validate: (value: unknown) => value is T,
): Result.Result<T, DaemonClientFailure> {
  if (!response.ok) return Result.fail({
    type: "rejected",
    code: response.error.code,
    message: response.error.message,
    ...(response.error.ambiguity ? { ambiguity: true } : {}),
  });
  return validate(response.result)
    ? Result.succeed(response.result)
    : Result.fail({
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
