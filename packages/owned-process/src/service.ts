import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import type * as Stream from "effect/Stream";

export type ProcessOperation =
  | "spawn"
  | "stream"
  | "ipc"
  | "signal"
  | "lifecycle";

export type OwnedProcessError = Readonly<{
  type: "process";
  operation: ProcessOperation;
  message: string;
  code?: string;
  cause: unknown;
}>;

export type ProcessTarget = Readonly<{
  pid: number;
  processGroupId?: number;
}>;

export type ProcessIdentity = Readonly<{
  pid: number;
  startToken?: string;
}>;

export type ProcessLiveness = "live" | "dead" | "unverified";
export type ProcessIdentityLiveness = "match" | "absent" | "mismatch" | "unverified";

export type ProcessExit = Readonly<{
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}>;

export type ProcessStdio = "ignore" | "pipe";

export type SpawnOwnedProcessInput = Readonly<{
  command: string;
  args?: readonly string[];
  cwd?: string;
  env?: Readonly<NodeJS.ProcessEnv>;
  shell?: boolean | string;
  detached?: boolean;
  windowsHide?: boolean;
  stdin?: ProcessStdio;
  stdout?: ProcessStdio;
  stderr?: ProcessStdio;
  ipc?: boolean;
}>;

export type OwnedProcess = Readonly<{
  pid: number;
  target: ProcessTarget;
  stdin?: WritableStream<Uint8Array>;
  stdout: Stream.Stream<Uint8Array, OwnedProcessError>;
  stderr: Stream.Stream<Uint8Array, OwnedProcessError>;
  messages: Stream.Stream<unknown, OwnedProcessError>;
  closed: Effect.Effect<ProcessExit, OwnedProcessError>;
  send(message: unknown): Effect.Effect<void, OwnedProcessError>;
  signal(signal: NodeJS.Signals): Effect.Effect<void, OwnedProcessError>;
}>;

export type ProcessHostShape = Readonly<{
  spawn(input: SpawnOwnedProcessInput): Effect.Effect<OwnedProcess, OwnedProcessError, Scope.Scope>;
  signal(target: ProcessTarget, signal: NodeJS.Signals): Effect.Effect<void, OwnedProcessError>;
  liveness(target: ProcessTarget): Effect.Effect<ProcessLiveness>;
  startToken(pid: number): Effect.Effect<string | undefined>;
  identityLiveness(pid: number, expectedStartToken: string | undefined): Effect.Effect<ProcessIdentityLiveness>;
}>;

export class ProcessHost extends Context.Service<ProcessHost, ProcessHostShape>()(
  "acpus/owned-process/ProcessHost",
) {}
