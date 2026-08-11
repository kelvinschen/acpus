import { connect } from "node:net";
import { err, ok, ResultAsync, type Result } from "neverthrow";
import { resolveRuntimeWorkspaceLayout } from "../runtime-layout.js";
import {
  describeDaemonRequest,
  isDaemonControlResult,
  isDaemonResponse,
  isDaemonShutdownResult,
  isDaemonStatus,
  isRunDetails,
  type DaemonAdmitRunInput,
  type DaemonClientFailure,
  type DaemonControlIntent,
  type DaemonControlResult,
  type DaemonRequest,
  type DaemonResponse,
  type DaemonShutdownResult,
  type DaemonStatus,
} from "./protocol.js";
import type { RunDetails } from "../store/store.js";

export function daemonEndpoint(cwd: string): string {
  return resolveRuntimeWorkspaceLayout(cwd).daemonEndpoint;
}

export function requestDaemonStatus(cwd: string): ResultAsync<DaemonStatus, DaemonClientFailure> {
  const request = { method: "status" } as const;
  return requestDaemon(cwd, request).andThen(response => daemonResult(request, response, isDaemonStatus));
}

export function requestDaemonControl(
  cwd: string,
  control: DaemonControlIntent,
): ResultAsync<DaemonControlResult, DaemonClientFailure> {
  const request = { method: "control", control } as const;
  return requestDaemon(cwd, request).andThen(response => daemonResult(
    request,
    response,
    value => isDaemonControlResult(value, control.type),
  ));
}

export function requestDaemonAdmitRun(
  cwd: string,
  input: DaemonAdmitRunInput,
): ResultAsync<RunDetails, DaemonClientFailure> {
  const request = { ...input, method: "admitRun" } as const;
  return requestDaemon(cwd, request).andThen(response => daemonResult(request, response, isRunDetails));
}

export function requestDaemonShutdown(cwd: string): ResultAsync<DaemonShutdownResult, DaemonClientFailure> {
  const request = { method: "shutdown" } as const;
  return requestDaemon(cwd, request).andThen(response => daemonResult(request, response, isDaemonShutdownResult));
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
  cwd: string,
  request: DaemonRequest,
): ResultAsync<DaemonResponse, Extract<DaemonClientFailure, { type: "transport" | "protocol" }>> {
  const endpoint = daemonEndpoint(cwd);
  return new ResultAsync(new Promise(resolveRequest => {
    const socket = connect(endpoint);
    const chunks: Buffer[] = [];
    const timeoutMs = request.method === "admitRun"
      ? undefined
      : request.method === "control"
        ? 30_000
        : 1_000;
    const timeout = timeoutMs === undefined
      ? undefined
      : setTimeout(() => {
          socket.destroy();
          resolveRequest(err({
            type: "transport",
            reason: "timeout",
            method: request.method,
            message: `Timed out waiting for daemon ${describeDaemonRequest(request)} response.`,
          }));
        }, timeoutMs);
    socket.once("error", error => {
      if (timeout) clearTimeout(timeout);
      resolveRequest(err(daemonTransportFailure(request, error)));
    });
    socket.on("data", chunk => chunks.push(Buffer.from(chunk)));
    socket.once("end", () => {
      if (timeout) clearTimeout(timeout);
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

function daemonResult<T>(
  request: DaemonRequest,
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
  request: DaemonRequest,
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
