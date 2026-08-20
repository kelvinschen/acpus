import { spawn, type ChildProcessByStdio } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, realpath, stat, unlink, type FileHandle } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Readable } from "node:stream";
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
  requestPermission(params: RequestPermissionRequest, signal?: AbortSignal): Promise<RequestPermissionResponse>;
  readTextFile(params: ReadTextFileRequest): Promise<ReadTextFileResponse>;
  writeTextFile(params: WriteTextFileRequest): Promise<WriteTextFileResponse>;
  createTerminal(params: CreateTerminalRequest): Promise<CreateTerminalResponse>;
  terminalOutput(params: TerminalOutputRequest): Promise<TerminalOutputResponse>;
  waitForTerminalExit(params: WaitForTerminalExitRequest, signal?: AbortSignal): Promise<WaitForTerminalExitResponse>;
  killTerminal(params: KillTerminalRequest): Promise<KillTerminalResponse>;
  releaseTerminal(params: ReleaseTerminalRequest): Promise<ReleaseTerminalResponse>;
  cancelPendingPermissions(): void;
  closeAll(): Promise<void>;
};

type ManagedTerminal = {
  child: ChildProcessByStdio<null, Readable, Readable>;
  ownsProcessGroup: boolean;
  output: Buffer;
  outputByteLimit: number;
  truncated: boolean;
  status?: WaitForTerminalExitResponse;
  exited: Promise<WaitForTerminalExitResponse>;
  settleExit: (status: WaitForTerminalExitResponse) => void;
  killPromise: Promise<void> | undefined;
  released: boolean;
};

type PendingPermission = {
  cancel(): void;
};

const cancelledPermission = (): RequestPermissionResponse => ({
  outcome: { outcome: "cancelled" },
});

export function createReverseRpcHandlers(
  options: CreateReverseRpcHandlersOptions,
): ReverseRpcHandlers {
  const rootLexical = resolve(options.cwd);
  let rootRealPromise: Promise<string> | undefined;
  const rootReal = (): Promise<string> => rootRealPromise ??= realpath(rootLexical);
  const terminals = new Map<string, ManagedTerminal>();
  const terminalCreates = new Set<Promise<void>>();
  const pendingPermissions = new Set<PendingPermission>();
  let closing = false;

  const begin = (operation: ClientOperation, sessionId: string): void => {
    if (closing) {
      throw issue(operation, "cancelled", `Client operation rejected while closing: ${operation}.`);
    }
    let expectedSessionId: string | undefined;
    try {
      expectedSessionId = options.getSessionId();
    } catch (cause) {
      throw issue(operation, "session", "Failed to resolve the active ACP session.", cause);
    }
    if (expectedSessionId === undefined || sessionId !== expectedSessionId) {
      throw issue(operation, "session", `Request targets an inactive ACP session: ${sessionId}.`);
    }
    assertOperationAllowed(operation, options.permissionMode);
    try {
      options.onActivity?.(operation);
    } catch {
      // Activity reporting must not change protocol behavior.
    }
  };

  const requestPermission: ReverseRpcHandlers["requestPermission"] = async (params, signal) => {
    const operation = "session/request_permission" as const;
    begin(operation, params.sessionId);
    if (signal?.aborted) return cancelledPermission();

    return new Promise<RequestPermissionResponse>((resolvePermission) => {
      let settled = false;
      const settle = (response: RequestPermissionResponse): void => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", onAbort);
        pendingPermissions.delete(pending);
        resolvePermission(response);
      };
      const onAbort = (): void => settle(cancelledPermission());
      const pending: PendingPermission = { cancel: onAbort };
      pendingPermissions.add(pending);
      signal?.addEventListener("abort", onAbort, { once: true });
      queueMicrotask(() => {
        settle(signal?.aborted
          ? cancelledPermission()
          : permissionResponse(params, options.permissionMode));
      });
    });
  };

  const readTextFile: ReverseRpcHandlers["readTextFile"] = async (params) => {
    const operation = "fs/read_text_file" as const;
    begin(operation, params.sessionId);
    try {
      const filePath = await canonicalReadPath(operation, rootLexical, await rootReal(), params.path);
      return await withPinnedParent(operation, await rootReal(), filePath, async target => {
        const file = await openNoFollow(target, fsConstants.O_RDONLY);
        try {
          await assertOpenFileWithin(operation, await rootReal(), file, filePath);
          return { content: sliceLines(await file.readFile("utf8"), params.line, params.limit) };
        } finally {
          await file.close();
        }
      });
    } catch (cause) {
      throw wrapIssue(operation, "filesystem", cause);
    }
  };

  const writeTextFile: ReverseRpcHandlers["writeTextFile"] = async (params) => {
    const operation = "fs/write_text_file" as const;
    begin(operation, params.sessionId);
    try {
      const filePath = await canonicalWritePath(operation, rootLexical, await rootReal(), params.path);
      await withPinnedParent(operation, await rootReal(), filePath, async target => {
        const opened = await openWriteTarget(target);
        try {
          await assertOpenFileWithin(operation, await rootReal(), opened.file, filePath);
          await opened.file.truncate(0);
          await opened.file.writeFile(params.content, "utf8");
        } catch (error) {
          if (opened.created) await unlink(target).catch(() => undefined);
          throw error;
        } finally {
          await opened.file.close();
        }
      });
      return {};
    } catch (cause) {
      throw wrapIssue(operation, "filesystem", cause);
    }
  };

  const createTerminal: ReverseRpcHandlers["createTerminal"] = async (params) => {
    const operation = "terminal/create" as const;
    let finishCreate = (): void => {};
    const pendingCreate = new Promise<void>((resolveCreate) => {
      finishCreate = resolveCreate;
    });
    terminalCreates.add(pendingCreate);
    try {
      begin(operation, params.sessionId);
      const cwd = await canonicalDirectory(
        operation,
        rootLexical,
        await rootReal(),
        params.cwd ?? rootLexical,
      );
      const env = terminalEnvironment(options.env, params.env);
      const inheritProcessGroup = process.env[INHERIT_PROCESS_GROUP_ENV] !== undefined
        && options.env?.[INHERIT_PROCESS_GROUP_ENV] === process.env[INHERIT_PROCESS_GROUP_ENV];
      const detached = process.platform !== "win32" && !inheritProcessGroup;
      delete env[INHERIT_PROCESS_GROUP_ENV];
      const child = spawn(params.command, params.args ?? [], {
        cwd,
        env,
        detached,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      const terminal = managedTerminal(
        child,
        terminalOutputLimit(params.outputByteLimit),
        detached,
      );
      await waitForSpawn(child);
      const terminalId = randomUUID();
      terminals.set(terminalId, terminal);
      return { terminalId };
    } catch (cause) {
      throw wrapIssue(operation, "terminal", cause);
    } finally {
      terminalCreates.delete(pendingCreate);
      finishCreate();
    }
  };

  const terminalOutput: ReverseRpcHandlers["terminalOutput"] = async (params) => {
    const operation = "terminal/output" as const;
    begin(operation, params.sessionId);
    const terminal = requireTerminal(terminals, operation, params.terminalId);
    return {
      output: terminal.output.toString("utf8"),
      truncated: terminal.truncated,
      ...(terminal.status === undefined ? {} : { exitStatus: terminal.status }),
    };
  };

  const waitForTerminalExit: ReverseRpcHandlers["waitForTerminalExit"] = async (params, signal) => {
    const operation = "terminal/wait_for_exit" as const;
    begin(operation, params.sessionId);
    const terminal = requireTerminal(terminals, operation, params.terminalId);
    return signal === undefined ? await terminal.exited : await waitForExit(terminal, signal, operation);
  };

  const killTerminal: ReverseRpcHandlers["killTerminal"] = async (params) => {
    const operation = "terminal/kill" as const;
    begin(operation, params.sessionId);
    const terminal = requireTerminal(terminals, operation, params.terminalId);
    try {
      await terminate(terminal);
      return {};
    } catch (cause) {
      throw wrapIssue(operation, "terminal", cause);
    }
  };

  const releaseTerminal: ReverseRpcHandlers["releaseTerminal"] = async (params) => {
    const operation = "terminal/release" as const;
    begin(operation, params.sessionId);
    const terminal = requireTerminal(terminals, operation, params.terminalId);
    terminal.released = true;
    try {
      await terminate(terminal);
      terminals.delete(params.terminalId);
      terminal.output = Buffer.alloc(0);
      return {};
    } catch (cause) {
      throw wrapIssue(operation, "terminal", cause);
    }
  };

  const cancelPendingPermissions = (): void => {
    for (const pending of [...pendingPermissions]) pending.cancel();
  };

  const closeAll = async (): Promise<void> => {
    closing = true;
    cancelPendingPermissions();
    await Promise.allSettled([...terminalCreates]);
    const active = [...terminals.entries()];
    for (const [, terminal] of active) terminal.released = true;
    const settled = await Promise.allSettled(active.map(async ([terminalId, terminal]) => {
      await terminate(terminal);
      terminals.delete(terminalId);
      terminal.output = Buffer.alloc(0);
    }));
    const failure = settled.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failure !== undefined) throw failure.reason;
  };

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
    closeAll,
  };
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

async function withPinnedParent<T>(
  operation: ClientOperation,
  rootReal: string,
  filePath: string,
  use: (target: string) => Promise<T>,
): Promise<T> {
  const parentPath = dirname(filePath);
  const parent = await open(
    parentPath,
    fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0),
  );
  try {
    const descriptor = descriptorPath(parent.fd);
    if (descriptor !== undefined) {
      const canonical = await realpath(descriptor);
      assertWithin(operation, rootReal, canonical, "Opened parent moved outside the allowed cwd subtree");
      return await use(join(descriptor, basename(filePath)));
    }

    const [opened, currentPath, current] = await Promise.all([
      parent.stat(),
      realpath(parentPath),
      stat(parentPath),
    ]);
    assertWithin(operation, rootReal, currentPath, "Opened parent is outside the allowed cwd subtree");
    if (opened.dev !== current.dev || opened.ino !== current.ino) {
      throw issue(operation, "path", `Opened parent changed during validation: ${parentPath}.`);
    }
    return await use(filePath);
  } finally {
    await parent.close();
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
  if (process.platform === "linux") return `/proc/self/fd/${fileDescriptor}`;
  if (process.platform !== "win32") return `/dev/fd/${fileDescriptor}`;
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
    const option = options.find((candidate) => candidate.kind === kind);
    if (option !== undefined) return option;
  }
  return undefined;
}

function assertOperationAllowed(
  operation: ClientOperation,
  mode: ReverseRpcPermissionMode,
): void {
  if (
    operation !== "fs/read_text_file"
    && operation !== "fs/write_text_file"
    && operation !== "terminal/create"
  ) return;
  const allowed = mode === "approve-all"
    || (mode === "approve-reads" && operation === "fs/read_text_file");
  if (!allowed) {
    throw issue(operation, "permission", `${operation} is denied by permission mode ${mode}.`);
  }
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
  const environment = Object.assign(Object.create(null) as NodeJS.ProcessEnv, process.env);
  for (const [name, value] of Object.entries(inherited ?? {})) {
    if (value === undefined) delete environment[name];
    else environment[name] = value;
  }
  for (const entry of entries ?? []) environment[entry.name] = entry.value;
  return environment;
}

function terminalOutputLimit(requested: number | null | undefined): number {
  return Math.min(MAX_TERMINAL_OUTPUT_BYTES, Math.max(0, Math.trunc(requested ?? MAX_TERMINAL_OUTPUT_BYTES)));
}

function managedTerminal(
  child: ChildProcessByStdio<null, Readable, Readable>,
  outputByteLimit: number,
  ownsProcessGroup: boolean,
): ManagedTerminal {
  let settleExit = (_status: WaitForTerminalExitResponse): void => {};
  const exited = new Promise<WaitForTerminalExitResponse>((resolveExit) => {
    settleExit = resolveExit;
  });
  const terminal: ManagedTerminal = {
    child,
    ownsProcessGroup,
    output: Buffer.alloc(0),
    outputByteLimit,
    truncated: false,
    exited,
    settleExit,
    killPromise: undefined,
    released: false,
  };
  const append = (chunk: Buffer | string): void => {
    if (terminal.released) return;
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const merged = Buffer.concat([terminal.output, bytes]);
    if (merged.length > terminal.outputByteLimit) terminal.truncated = true;
    terminal.output = trimOutput(merged, terminal.outputByteLimit);
  };
  child.stdout.on("data", append);
  child.stderr.on("data", append);
  child.on("error", () => {
    // Spawn failures are returned by waitForSpawn; later process errors settle on close.
  });
  child.once("close", (exitCode, signal) => {
    const status = { exitCode, signal };
    terminal.status = status;
    terminal.settleExit(status);
  });
  return terminal;
}

function trimOutput(output: Buffer, limit: number): Buffer {
  if (limit === 0) return Buffer.alloc(0);
  if (output.length <= limit) return output;
  let start = output.length - limit;
  while (start < output.length && (output[start]! & 0b1100_0000) === 0b1000_0000) start += 1;
  return output.subarray(start);
}

function waitForSpawn(child: ChildProcessByStdio<null, Readable, Readable>): Promise<void> {
  return new Promise((resolveSpawn, rejectSpawn) => {
    const onSpawn = (): void => {
      child.off("error", onError);
      resolveSpawn();
    };
    const onError = (error: Error): void => {
      child.off("spawn", onSpawn);
      rejectSpawn(error);
    };
    child.once("spawn", onSpawn);
    child.once("error", onError);
  });
}

function requireTerminal(
  terminals: Map<string, ManagedTerminal>,
  operation: ClientOperation,
  terminalId: string,
): ManagedTerminal {
  const terminal = terminals.get(terminalId);
  if (terminal === undefined) throw issue(operation, "terminal", `Unknown terminal: ${terminalId}.`);
  return terminal;
}

async function waitForExit(
  terminal: ManagedTerminal,
  signal: AbortSignal,
  operation: ClientOperation,
): Promise<WaitForTerminalExitResponse> {
  if (signal.aborted) throw issue(operation, "cancelled", "Terminal wait was cancelled.");
  return await new Promise<WaitForTerminalExitResponse>((resolveExit, rejectExit) => {
    const onAbort = (): void => {
      rejectExit(issue(operation, "cancelled", "Terminal wait was cancelled."));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void terminal.exited.then((status) => {
      signal.removeEventListener("abort", onAbort);
      resolveExit(status);
    });
  });
}

async function terminate(terminal: ManagedTerminal): Promise<void> {
  if (terminal.killPromise !== undefined) return await terminal.killPromise;
  terminal.killPromise = (async () => {
    const pid = terminal.child.pid;
    if (pid === undefined) return;
    if (process.platform !== "win32" && terminal.ownsProcessGroup) {
      signalProcess(-pid, "SIGTERM");
      await Promise.race([terminal.exited, delay(TERMINAL_KILL_GRACE_MS)]);
      if (processExists(-pid)) {
        signalProcess(-pid, "SIGKILL");
        await Promise.race([terminal.exited, delay(TERMINAL_KILL_GRACE_MS)]);
      }
      if (processExists(-pid)) throw new Error("Terminal process group did not exit after SIGKILL.");
    } else if (terminal.status === undefined) {
      terminal.child.kill("SIGTERM");
      await Promise.race([terminal.exited, delay(TERMINAL_KILL_GRACE_MS)]);
      if (terminal.status === undefined) terminal.child.kill("SIGKILL");
    }
    if (terminal.status === undefined) {
      await Promise.race([terminal.exited, delay(TERMINAL_KILL_GRACE_MS)]);
    }
    if (terminal.status === undefined) throw new Error("Terminal process did not report exit.");
  })();
  try {
    return await terminal.killPromise;
  } catch (error) {
    terminal.killPromise = undefined;
    throw error;
  }
}

function signalProcess(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch (cause) {
    if (!isMissingProcess(cause)) throw cause;
  }
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
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

function isMissingProcess(cause: unknown): boolean {
  return cause instanceof Error && (cause as NodeJS.ErrnoException).code === "ESRCH";
}
