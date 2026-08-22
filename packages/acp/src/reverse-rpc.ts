import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, realpath, stat, unlink, type FileHandle } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type {
  CreateTerminalRequest,
  CreateTerminalResponse,
  KillTerminalRequest,
  KillTerminalResponse,
  PermissionOption,
  ReadTextFileRequest,
  ReadTextFileResponse,
  ReleaseTerminalRequest,
  ReleaseTerminalResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  TerminalOutputRequest,
  TerminalOutputResponse,
  ToolKind,
  WaitForTerminalExitRequest,
  WaitForTerminalExitResponse,
  WriteTextFileRequest,
  WriteTextFileResponse,
} from "@agentclientprotocol/sdk";
import type { OwnedProcess, ProcessHostShape } from "@acpus/owned-process";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FiberSet from "effect/FiberSet";
import * as Result from "effect/Result";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

const MAX_TERMINAL_OUTPUT_BYTES = 1024 * 1024;
const TERMINAL_KILL_GRACE_MS = 250;
const INHERIT_PROCESS_GROUP_ENV = "ACPUS_INTERNAL_ACP_INHERIT_PROCESS_GROUP";

export type ReverseRpcPermissionMode = "approve-reads" | "approve-all" | "deny-all";

export type ClientOperation =
  | "session/request_permission"
  | "fs/read_text_file"
  | "fs/write_text_file"
  | "terminal/create"
  | "terminal/output"
  | "terminal/wait_for_exit"
  | "terminal/kill"
  | "terminal/release";

export type ClientOperationIssueReason =
  | "session"
  | "permission"
  | "path"
  | "filesystem"
  | "terminal"
  | "cancelled";

/** Recoverable client-side ACP operation failure for the session layer to map. */
export class ClientOperationIssue extends Error {
  readonly type = "client_operation" as const;
  readonly retryable = false as const;

  constructor(
    readonly operation: ClientOperation,
    readonly reason: ClientOperationIssueReason,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ClientOperationIssue";
  }
}

export type CreateReverseRpcHandlersOptions = {
  getSessionId: () => string | undefined;
  cwd: string;
  env?: Readonly<NodeJS.ProcessEnv>;
  permissionMode: ReverseRpcPermissionMode;
  onActivity?: (operation: ClientOperation) => void;
};

export type ReverseRpcHandlers = {
  requestPermission(params: RequestPermissionRequest): Effect.Effect<RequestPermissionResponse, ClientOperationIssue>;
  readTextFile(params: ReadTextFileRequest): Effect.Effect<ReadTextFileResponse, ClientOperationIssue>;
  writeTextFile(params: WriteTextFileRequest): Effect.Effect<WriteTextFileResponse, ClientOperationIssue>;
  createTerminal(params: CreateTerminalRequest): Effect.Effect<CreateTerminalResponse, ClientOperationIssue>;
  terminalOutput(params: TerminalOutputRequest): Effect.Effect<TerminalOutputResponse, ClientOperationIssue>;
  waitForTerminalExit(params: WaitForTerminalExitRequest): Effect.Effect<WaitForTerminalExitResponse, ClientOperationIssue>;
  killTerminal(params: KillTerminalRequest): Effect.Effect<KillTerminalResponse, ClientOperationIssue>;
  releaseTerminal(params: ReleaseTerminalRequest): Effect.Effect<ReleaseTerminalResponse, ClientOperationIssue>;
  cancelPendingPermissions(): Effect.Effect<void>;
  closeAll(): Effect.Effect<void, ClientOperationIssue>;
};

type ManagedTerminal = {
  readonly scope: Scope.Closeable;
  readonly child: OwnedProcess;
  readonly exited: Deferred.Deferred<WaitForTerminalExitResponse, ClientOperationIssue>;
  readonly outputByteLimit: number;
  output: Buffer;
  truncated: boolean;
  status?: WaitForTerminalExitResponse;
  terminate: Effect.Effect<void, ClientOperationIssue>;
  cleanupObserved: boolean;
  released: boolean;
};

const cancelledPermission = (): RequestPermissionResponse => ({
  outcome: { outcome: "cancelled" },
});

export function createReverseRpcHandlers(
  options: CreateReverseRpcHandlersOptions,
  processes: ProcessHostShape,
): Effect.Effect<ReverseRpcHandlers, never, Scope.Scope> {
  return Effect.gen(function*() {
    const scope = yield* Scope.Scope;
    const rootLexical = resolve(options.cwd);
    const rootReal = yield* Effect.cached(fileOperation(
      "fs/read_text_file",
      "filesystem",
      () => realpath(rootLexical),
    ));
    const permissionFibers = yield* FiberSet.make<RequestPermissionResponse>();
    const terminalCreates = yield* FiberSet.make<CreateTerminalResponse, ClientOperationIssue>();
    const terminalCreateGate = Semaphore.makeUnsafe(1);
    const terminals = new Map<string, ManagedTerminal>();
    let permissionGeneration = 0;
    let closing = false;

    const begin = (operation: ClientOperation, sessionId: string): Effect.Effect<void, ClientOperationIssue> =>
      Effect.suspend(() => {
        if (closing) {
          return Effect.fail(issue(
            operation,
            "cancelled",
            `Client operation rejected while closing: ${operation}.`,
          ));
        }
        let expectedSessionId: string | undefined;
        try {
          expectedSessionId = options.getSessionId();
        } catch (cause) {
          return Effect.fail(issue(
            operation,
            "session",
            "Failed to resolve the active ACP session.",
            cause,
          ));
        }
        if (expectedSessionId === undefined || sessionId !== expectedSessionId) {
          return Effect.fail(issue(
            operation,
            "session",
            `Request targets an inactive ACP session: ${sessionId}.`,
          ));
        }
        const denied = operationDenied(operation, options.permissionMode);
        if (denied !== undefined) return Effect.fail(denied);
        try {
          options.onActivity?.(operation);
        } catch {
          // Activity observers never participate in protocol settlement.
        }
        return Effect.void;
      });

    const requestPermission: ReverseRpcHandlers["requestPermission"] = params =>
      Effect.gen(function*() {
        const operation = "session/request_permission" as const;
        yield* begin(operation, params.sessionId);
        const generation = permissionGeneration;
        const fiber = yield* FiberSet.run(
          permissionFibers,
          Effect.yieldNow.pipe(Effect.andThen(Effect.sync(() =>
            closing || generation !== permissionGeneration
              ? cancelledPermission()
              : permissionResponse(params, options.permissionMode)
          ))),
        );
        const settled = yield* Effect.exit(Fiber.join(fiber));
        if (Exit.isSuccess(settled)) return settled.value;
        if (Cause.hasInterrupts(settled.cause)) return cancelledPermission();
        return yield* Effect.failCause(settled.cause);
      });

    const readTextFile: ReverseRpcHandlers["readTextFile"] = params => {
      const operation = "fs/read_text_file" as const;
      return Effect.gen(function*() {
        yield* begin(operation, params.sessionId);
        const canonicalRoot = yield* rootReal;
        const filePath = yield* fileOperation(
          operation,
          "filesystem",
          () => canonicalReadPath(operation, rootLexical, canonicalRoot, params.path),
        );
        return yield* withPinnedParent(operation, canonicalRoot, filePath, target =>
          withFileHandle(
            operation,
            fileOperation(operation, "filesystem", () => openNoFollow(target, fsConstants.O_RDONLY)),
            file => Effect.gen(function*() {
              yield* fileOperation(
                operation,
                "filesystem",
                () => assertOpenFileWithin(operation, canonicalRoot, file, filePath),
              );
              const content = yield* fileOperation(
                operation,
                "filesystem",
                () => file.readFile("utf8"),
              );
              return { content: sliceLines(content, params.line, params.limit) };
            }),
          ));
      });
    };

    const writeTextFile: ReverseRpcHandlers["writeTextFile"] = params => {
      const operation = "fs/write_text_file" as const;
      return Effect.gen(function*() {
        yield* begin(operation, params.sessionId);
        const canonicalRoot = yield* rootReal;
        const filePath = yield* fileOperation(
          operation,
          "filesystem",
          () => canonicalWritePath(operation, rootLexical, canonicalRoot, params.path),
        );
        yield* withPinnedParent(operation, canonicalRoot, filePath, target =>
          withFileHandle(
            operation,
            fileOperation(operation, "filesystem", () => openWriteTarget(target)),
            opened => Effect.gen(function*() {
              yield* fileOperation(
                operation,
                "filesystem",
                () => assertOpenFileWithin(operation, canonicalRoot, opened.file, filePath),
              );
              yield* fileOperation(operation, "filesystem", () => opened.file.truncate(0));
              yield* fileOperation(operation, "filesystem", () => opened.file.writeFile(params.content, "utf8"));
            }).pipe(Effect.tapError(() => opened.created
              ? fileOperation(operation, "filesystem", () => unlink(target)).pipe(Effect.ignore)
              : Effect.void)),
            opened => opened.file,
          ));
        return {};
      });
    };

    const createTerminalValue = (
      params: CreateTerminalRequest,
    ): Effect.Effect<CreateTerminalResponse, ClientOperationIssue> => {
      const operation = "terminal/create" as const;
      return Effect.gen(function*() {
        yield* begin(operation, params.sessionId);
        const canonicalRoot = yield* rootReal;
        const cwd = yield* fileOperation(
          operation,
          "terminal",
          () => canonicalDirectory(
            operation,
            rootLexical,
            canonicalRoot,
            params.cwd ?? rootLexical,
          ),
        );
        const env = terminalEnvironment(options.env, params.env);
        const inheritProcessGroup = globalThis.process.env[INHERIT_PROCESS_GROUP_ENV] !== undefined
          && options.env?.[INHERIT_PROCESS_GROUP_ENV] === globalThis.process.env[INHERIT_PROCESS_GROUP_ENV];
        const detached = globalThis.process.platform !== "win32" && !inheritProcessGroup;
        delete env[INHERIT_PROCESS_GROUP_ENV];
        const terminalScope = yield* Scope.fork(scope);
        const opened = yield* Scope.provide(terminalScope)(openManagedTerminal(
          processes,
          {
            command: params.command,
            args: params.args ?? [],
            cwd,
            env,
            detached,
            windowsHide: true,
            stdin: "ignore",
            stdout: "pipe",
            stderr: "pipe",
          },
          terminalOutputLimit(params.outputByteLimit),
        )).pipe(Effect.onError(cause => Scope.close(terminalScope, Exit.failCause(cause))));
        const terminalId = randomUUID();
        terminals.set(terminalId, opened);
        return { terminalId };
      });
    };

    const createTerminal: ReverseRpcHandlers["createTerminal"] = params => Effect.suspend(() => {
      if (closing) {
        return Effect.fail(issue(
          "terminal/create",
          "cancelled",
          "Client operation rejected while closing: terminal/create.",
        ));
      }
      return terminalCreateGate.withPermit(Effect.gen(function*() {
        const fiber = yield* FiberSet.run(terminalCreates, createTerminalValue(params));
        return yield* Fiber.join(fiber);
      }));
    });

    const terminalOutput: ReverseRpcHandlers["terminalOutput"] = params => {
      const operation = "terminal/output" as const;
      return Effect.gen(function*() {
        yield* begin(operation, params.sessionId);
        const terminal = yield* requireTerminal(terminals, operation, params.terminalId);
        return {
          output: terminal.output.toString("utf8"),
          truncated: terminal.truncated,
          ...(terminal.status === undefined ? {} : { exitStatus: terminal.status }),
        };
      });
    };

    const waitForTerminalExit: ReverseRpcHandlers["waitForTerminalExit"] = params => {
      const operation = "terminal/wait_for_exit" as const;
      return Effect.gen(function*() {
        yield* begin(operation, params.sessionId);
        const terminal = yield* requireTerminal(terminals, operation, params.terminalId);
        return yield* Deferred.await(terminal.exited);
      });
    };

    const killTerminal: ReverseRpcHandlers["killTerminal"] = params => {
      const operation = "terminal/kill" as const;
      return Effect.gen(function*() {
        yield* begin(operation, params.sessionId);
        const terminal = yield* requireTerminal(terminals, operation, params.terminalId);
        terminal.cleanupObserved = true;
        yield* terminal.terminate;
        return {};
      });
    };

    const releaseTerminal: ReverseRpcHandlers["releaseTerminal"] = params => {
      const operation = "terminal/release" as const;
      return Effect.gen(function*() {
        yield* begin(operation, params.sessionId);
        const terminal = yield* requireTerminal(terminals, operation, params.terminalId);
        terminal.released = true;
        yield* closeTerminal(terminal);
        terminals.delete(params.terminalId);
        terminal.output = Buffer.alloc(0);
        return {};
      });
    };

    const cancelPendingPermissions = (): Effect.Effect<void> => Effect.sync(() => {
      permissionGeneration += 1;
    }).pipe(Effect.andThen(FiberSet.clear(permissionFibers)));

    const closeAll = yield* Effect.cached(Effect.uninterruptible(Effect.gen(function*() {
      closing = true;
      yield* cancelPendingPermissions();
      yield* terminalCreateGate.withPermit(Effect.void);
      yield* FiberSet.awaitEmpty(terminalCreates);
      const active = [...terminals.entries()];
      for (const [, terminal] of active) terminal.released = true;
      const results = yield* Effect.all(active.map(([terminalId, terminal]) =>
        Effect.result(closeTerminal(terminal)).pipe(Effect.tap(() => Effect.sync(() => {
          terminals.delete(terminalId);
          terminal.output = Buffer.alloc(0);
        })))), { concurrency: "unbounded" });
      const failed = results.find(Result.isFailure);
      if (failed !== undefined) return yield* Effect.fail(failed.failure);
    })));

    return {
      requestPermission,
      readTextFile,
      writeTextFile,
      createTerminal,
      terminalOutput,
      waitForTerminalExit,
      killTerminal,
      releaseTerminal,
      cancelPendingPermissions,
      closeAll: () => closeAll,
    };
  });
}

function openManagedTerminal(
  processes: ProcessHostShape,
  input: Parameters<ProcessHostShape["spawn"]>[0],
  outputByteLimit: number,
): Effect.Effect<ManagedTerminal, ClientOperationIssue, Scope.Scope> {
  return Effect.gen(function*() {
    const scope = yield* Scope.Scope;
    const child = yield* processes.spawn(input).pipe(Effect.mapError(error =>
      issue("terminal/create", "terminal", error.message, error)));
    const terminal: ManagedTerminal = {
      scope: scope as Scope.Closeable,
      child,
      exited: Deferred.makeUnsafe<WaitForTerminalExitResponse, ClientOperationIssue>(),
      output: Buffer.alloc(0),
      outputByteLimit,
      truncated: false,
      terminate: Effect.die("Terminal cleanup was used before initialization."),
      cleanupObserved: false,
      released: false,
    };
    terminal.terminate = yield* Effect.cached(Effect.uninterruptible(
      terminateTerminal(terminal, processes),
    ));
    yield* Effect.forkScoped(Stream.runForEach(child.stdout, chunk =>
      Effect.sync(() => appendTerminalOutput(terminal, chunk))).pipe(Effect.ignore));
    yield* Effect.forkScoped(Stream.runForEach(child.stderr, chunk =>
      Effect.sync(() => appendTerminalOutput(terminal, chunk))).pipe(Effect.ignore));
    yield* Effect.forkScoped(observeTerminalExit(terminal));
    yield* Scope.addFinalizer(scope, terminalFinalizer(terminal));
    return terminal;
  });
}

function observeTerminalExit(terminal: ManagedTerminal): Effect.Effect<void> {
  return terminal.child.closed.pipe(Effect.matchEffect({
    onFailure: error => Effect.sync(() => {
      Deferred.doneUnsafe(
        terminal.exited,
        Effect.fail(issue("terminal/wait_for_exit", "terminal", error.message, error)),
      );
    }),
    onSuccess: exit => Effect.sync(() => {
      const status = { exitCode: exit.exitCode, signal: exit.signal };
      terminal.status = status;
      Deferred.doneUnsafe(terminal.exited, Effect.succeed(status));
    }),
  }));
}

function terminateTerminal(
  terminal: ManagedTerminal,
  processes: ProcessHostShape,
): Effect.Effect<void, ClientOperationIssue> {
  return Effect.gen(function*() {
    if (terminal.status !== undefined) return;
    const initial = yield* processes.liveness(terminal.child.target);
    if (initial === "dead") return;
    yield* terminal.child.signal("SIGTERM").pipe(Effect.mapError(error =>
      issue("terminal/kill", "terminal", error.message, error)));
    yield* settleTerminalExit(terminal, TERMINAL_KILL_GRACE_MS);
    if (terminal.status !== undefined) return;
    if ((yield* processes.liveness(terminal.child.target)) !== "dead") {
      yield* terminal.child.signal("SIGKILL").pipe(Effect.mapError(error =>
        issue("terminal/kill", "terminal", error.message, error)));
      yield* settleTerminalExit(terminal, TERMINAL_KILL_GRACE_MS);
    }
    if (terminal.status === undefined
      && (yield* processes.liveness(terminal.child.target)) !== "dead") {
      return yield* Effect.fail(issue(
        "terminal/kill",
        "terminal",
        "Terminal process did not exit after SIGKILL.",
      ));
    }
  });
}

function settleTerminalExit(
  terminal: ManagedTerminal,
  milliseconds: number,
): Effect.Effect<void, ClientOperationIssue> {
  return Effect.timeoutOption(Deferred.await(terminal.exited), milliseconds).pipe(Effect.asVoid);
}

function closeTerminal(terminal: ManagedTerminal): Effect.Effect<void, ClientOperationIssue> {
  return Effect.uninterruptible(Effect.gen(function*() {
    terminal.cleanupObserved = true;
    const result = yield* Effect.result(terminal.terminate);
    yield* Scope.close(terminal.scope, Exit.void);
    return yield* Effect.fromResult(result);
  }));
}

function terminalFinalizer(terminal: ManagedTerminal): Effect.Effect<void> {
  return Effect.suspend(() => terminal.cleanupObserved
    ? terminal.terminate.pipe(Effect.ignore)
    : terminal.terminate.pipe(Effect.orDie, Effect.asVoid));
}

function appendTerminalOutput(terminal: ManagedTerminal, chunk: Uint8Array): void {
  if (terminal.released) return;
  const merged = Buffer.concat([terminal.output, Buffer.from(chunk)]);
  if (merged.length > terminal.outputByteLimit) terminal.truncated = true;
  terminal.output = trimOutput(merged, terminal.outputByteLimit);
}

function withFileHandle<Resource, Success>(
  operation: ClientOperation,
  acquire: Effect.Effect<Resource, ClientOperationIssue>,
  use: (resource: Resource) => Effect.Effect<Success, ClientOperationIssue>,
  fileOf: (resource: Resource) => FileHandle = resource => resource as FileHandle,
): Effect.Effect<Success, ClientOperationIssue> {
  return Effect.acquireUseRelease(
    acquire,
    use,
    resource => fileOperation(operation, "filesystem", () => fileOf(resource).close()),
  );
}

function withPinnedParent<Success>(
  operation: ClientOperation,
  rootReal: string,
  filePath: string,
  use: (target: string) => Effect.Effect<Success, ClientOperationIssue>,
): Effect.Effect<Success, ClientOperationIssue> {
  const parentPath = dirname(filePath);
  return withFileHandle(
    operation,
    fileOperation(
      operation,
      "filesystem",
      () => open(parentPath, fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0)),
    ),
    parent => Effect.gen(function*() {
      const descriptor = descriptorPath(parent.fd);
      if (descriptor !== undefined) {
        const canonical = yield* fileOperation(operation, "filesystem", () => realpath(descriptor));
        yield* validatePath(operation, () =>
          assertWithin(operation, rootReal, canonical, "Opened parent moved outside the allowed cwd subtree"));
        return yield* use(join(descriptor, basename(filePath)));
      }

      const [opened, currentPath, current] = yield* fileOperation(
        operation,
        "filesystem",
        () => Promise.all([parent.stat(), realpath(parentPath), stat(parentPath)]),
      );
      yield* validatePath(operation, () => {
        assertWithin(operation, rootReal, currentPath, "Opened parent is outside the allowed cwd subtree");
        if (opened.dev !== current.dev || opened.ino !== current.ino) {
          throw issue(operation, "path", `Opened parent changed during validation: ${parentPath}.`);
        }
      });
      return yield* use(filePath);
    }),
  );
}

function fileOperation<Success>(
  operation: ClientOperation,
  reason: ClientOperationIssueReason,
  evaluate: () => PromiseLike<Success>,
): Effect.Effect<Success, ClientOperationIssue> {
  return Effect.tryPromise({
    try: evaluate,
    catch: cause => wrapIssue(operation, reason, cause),
  });
}

function validatePath(
  operation: ClientOperation,
  evaluate: () => void,
): Effect.Effect<void, ClientOperationIssue> {
  return Effect.try({
    try: evaluate,
    catch: cause => wrapIssue(operation, "path", cause),
  });
}

function openNoFollow(path: string, flags: number) {
  return open(path, flags | (fsConstants.O_NOFOLLOW ?? 0), 0o600);
}

async function openWriteTarget(
  path: string,
): Promise<{ file: FileHandle; created: boolean }> {
  try {
    return { file: await openNoFollow(path, fsConstants.O_WRONLY), created: false };
  } catch (error) {
    if (!isMissingPath(error)) throw error;
    return {
      file: await openNoFollow(
        path,
        fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
      ),
      created: true,
    };
  }
}

async function assertOpenFileWithin(
  operation: ClientOperation,
  rootReal: string,
  file: FileHandle,
  filePath: string,
): Promise<void> {
  const descriptor = descriptorPath(file.fd);
  if (descriptor !== undefined) {
    const canonical = await realpath(descriptor);
    assertWithin(operation, rootReal, canonical, "Opened file is outside the allowed cwd subtree");
    return;
  }

  const [opened, currentPath, current] = await Promise.all([
    file.stat(),
    realpath(filePath),
    stat(filePath),
  ]);
  assertWithin(operation, rootReal, currentPath, "Opened file is outside the allowed cwd subtree");
  if (opened.dev !== current.dev || opened.ino !== current.ino) {
    throw issue(operation, "path", `Opened file changed during validation: ${filePath}.`);
  }
}

function descriptorPath(fileDescriptor: number): string | undefined {
  if (globalThis.process.platform === "linux") return `/proc/self/fd/${fileDescriptor}`;
  if (globalThis.process.platform !== "win32") return `/dev/fd/${fileDescriptor}`;
  return undefined;
}

function permissionResponse(
  request: RequestPermissionRequest,
  mode: ReverseRpcPermissionMode,
): RequestPermissionResponse {
  const allow = optionOfKind(request.options, ["allow_once", "allow_always"]);
  const deny = optionOfKind(request.options, ["reject_once", "reject_always"]);
  const toolKind = permissionToolKind(request);
  const readOnly = toolKind === "read" || toolKind === "search";
  const selected = mode === "approve-all" || (mode === "approve-reads" && readOnly)
    ? allow
    : deny;
  return selected === undefined
    ? cancelledPermission()
    : { outcome: { outcome: "selected", optionId: selected.optionId } };
}

function permissionToolKind(request: RequestPermissionRequest): ToolKind | undefined {
  return request.toolCall.kind ?? undefined;
}

function optionOfKind(
  options: PermissionOption[],
  kinds: readonly PermissionOption["kind"][],
): PermissionOption | undefined {
  for (const kind of kinds) {
    const option = options.find(candidate => candidate.kind === kind);
    if (option !== undefined) return option;
  }
  return undefined;
}

function operationDenied(
  operation: ClientOperation,
  mode: ReverseRpcPermissionMode,
): ClientOperationIssue | undefined {
  if (
    operation !== "fs/read_text_file"
    && operation !== "fs/write_text_file"
    && operation !== "terminal/create"
  ) return undefined;
  const allowed = mode === "approve-all"
    || (mode === "approve-reads" && operation === "fs/read_text_file");
  return allowed
    ? undefined
    : issue(operation, "permission", `${operation} is denied by permission mode ${mode}.`);
}

function lexicalPath(operation: ClientOperation, root: string, value: string): string {
  if (!isAbsolute(value)) throw issue(operation, "path", `Path must be absolute: ${value}.`);
  const target = resolve(value);
  assertWithin(operation, root, target, "Path is outside the allowed cwd subtree");
  return target;
}

async function canonicalReadPath(
  operation: ClientOperation,
  rootLexical: string,
  rootReal: string,
  value: string,
): Promise<string> {
  const target = lexicalPath(operation, rootLexical, value);
  const canonical = await realpath(target);
  assertWithin(operation, rootReal, canonical, "Path resolves outside the allowed cwd subtree");
  return canonical;
}

async function canonicalWritePath(
  operation: ClientOperation,
  rootLexical: string,
  rootReal: string,
  value: string,
): Promise<string> {
  const target = lexicalPath(operation, rootLexical, value);
  let parent = rootReal;
  const parentRelative = relative(rootLexical, dirname(target));
  for (const component of parentRelative === "" ? [] : parentRelative.split(sep)) {
    parent = await ensureDirectoryComponent(operation, rootReal, join(parent, component));
  }
  const canonicalTarget = join(parent, basename(target));
  try {
    const existing = await realpath(canonicalTarget);
    assertWithin(operation, rootReal, existing, "Write target resolves outside the allowed cwd subtree");
    return existing;
  } catch (cause) {
    if (isMissingPath(cause) && !(await pathEntryExists(canonicalTarget))) return canonicalTarget;
    if (isMissingPath(cause)) {
      throw issue(operation, "path", `Write target cannot be resolved safely: ${canonicalTarget}.`, cause);
    }
    throw cause;
  }
}

async function ensureDirectoryComponent(
  operation: ClientOperation,
  rootReal: string,
  candidate: string,
): Promise<string> {
  try {
    await mkdir(candidate);
  } catch (cause) {
    if (!isExistingPath(cause)) throw cause;
  }
  const canonical = await realpath(candidate);
  assertWithin(operation, rootReal, canonical, "Write parent resolves outside the allowed cwd subtree");
  if (!(await stat(canonical)).isDirectory()) {
    throw issue(operation, "path", `Write parent is not a directory: ${canonical}.`);
  }
  return canonical;
}

async function canonicalDirectory(
  operation: ClientOperation,
  rootLexical: string,
  rootReal: string,
  value: string,
): Promise<string> {
  const target = lexicalPath(operation, rootLexical, value);
  const canonical = await realpath(target);
  assertWithin(operation, rootReal, canonical, "Terminal cwd resolves outside the allowed cwd subtree");
  return canonical;
}

function assertWithin(
  operation: ClientOperation,
  root: string,
  target: string,
  message: string,
): void {
  const pathFromRoot = relative(root, target);
  if (
    pathFromRoot === ".."
    || pathFromRoot.startsWith(`..${sep}`)
    || isAbsolute(pathFromRoot)
  ) {
    throw issue(operation, "path", `${message}: ${target}.`);
  }
}

function sliceLines(
  content: string,
  line: number | null | undefined,
  limit: number | null | undefined,
): string {
  if (line == null && limit == null) return content;
  const lines = content.split("\n");
  const start = Math.max(1, Math.trunc(line ?? 1)) - 1;
  const count = limit == null ? undefined : Math.max(0, Math.trunc(limit));
  return lines.slice(start, count === undefined ? undefined : start + count).join("\n");
}

function terminalEnvironment(
  inherited: Readonly<NodeJS.ProcessEnv> | undefined,
  entries: CreateTerminalRequest["env"],
): NodeJS.ProcessEnv {
  const environment = Object.assign(Object.create(null) as NodeJS.ProcessEnv, globalThis.process.env);
  for (const [name, value] of Object.entries(inherited ?? {})) {
    if (value === undefined) delete environment[name];
    else environment[name] = value;
  }
  for (const entry of entries ?? []) environment[entry.name] = entry.value;
  return environment;
}

function terminalOutputLimit(requested: number | null | undefined): number {
  return Math.min(
    MAX_TERMINAL_OUTPUT_BYTES,
    Math.max(0, Math.trunc(requested ?? MAX_TERMINAL_OUTPUT_BYTES)),
  );
}

function trimOutput(output: Buffer, limit: number): Buffer {
  if (limit === 0) return Buffer.alloc(0);
  if (output.length <= limit) return output;
  let start = output.length - limit;
  while (start < output.length && (output[start]! & 0b1100_0000) === 0b1000_0000) start += 1;
  return output.subarray(start);
}

function requireTerminal(
  terminals: Map<string, ManagedTerminal>,
  operation: ClientOperation,
  terminalId: string,
): Effect.Effect<ManagedTerminal, ClientOperationIssue> {
  const terminal = terminals.get(terminalId);
  return terminal === undefined
    ? Effect.fail(issue(operation, "terminal", `Unknown terminal: ${terminalId}.`))
    : Effect.succeed(terminal);
}

function issue(
  operation: ClientOperation,
  reason: ClientOperationIssueReason,
  message: string,
  cause?: unknown,
): ClientOperationIssue {
  return new ClientOperationIssue(
    operation,
    reason,
    message,
    cause === undefined ? undefined : { cause },
  );
}

function wrapIssue(
  operation: ClientOperation,
  reason: ClientOperationIssueReason,
  cause: unknown,
): ClientOperationIssue {
  if (cause instanceof ClientOperationIssue) return cause;
  const detail = cause instanceof Error ? cause.message : String(cause);
  return issue(operation, reason, `${operation} failed: ${detail}`, cause);
}

function isMissingPath(cause: unknown): boolean {
  return cause instanceof Error && (cause as NodeJS.ErrnoException).code === "ENOENT";
}

function isExistingPath(cause: unknown): boolean {
  return cause instanceof Error && (cause as NodeJS.ErrnoException).code === "EEXIST";
}

async function pathEntryExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (cause) {
    if (isMissingPath(cause)) return false;
    throw cause;
  }
}
