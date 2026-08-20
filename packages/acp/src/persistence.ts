import { randomUUID } from "node:crypto";
import {
  constants as fsConstants,
  lstatSync,
  realpathSync,
  renameSync,
  statSync,
  type BigIntStats,
} from "node:fs";
import {
  mkdir,
  open,
  realpath,
  rename,
  rmdir,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type {
  AgentSessionBindingCategory,
  AgentSessionBindingFingerprintV1,
} from "./types.js";

const ACP_SESSION_PROJECTION_SCHEMA = "acpus.acp-session.v2" as const;
export const ACP_SESSION_CONVERSATION_MAX_ENTRIES = 256;
export const ACP_SESSION_CONVERSATION_MAX_BYTES = 256 * 1024;

type AcpProjectedJsonValue =
  | null
  | boolean
  | number
  | string
  | AcpProjectedJsonValue[]
  | { [key: string]: AcpProjectedJsonValue };

type AcpProjectedUsage = Readonly<{
  inputTokens?: number;
  outputTokens?: number;
  cachedReadTokens?: number;
  cachedWriteTokens?: number;
  thoughtTokens?: number;
  totalTokens?: number;
}>;

export type AcpProjectedConversationEntry =
  | Readonly<{
      type: "message";
      role: "user" | "assistant";
      content: string;
    }>
  | Readonly<{
      type: "thought";
      content: string;
    }>
  | Readonly<{
      type: "tool-call";
      toolCallId: string;
      title?: string;
      name?: string;
      kind?: string;
      status?: string;
      input?: AcpProjectedJsonValue;
    }>
  | Readonly<{
      type: "tool-result";
      toolCallId: string;
      content: AcpProjectedJsonValue;
    }>;

export type AcpSessionProjection = Readonly<{
  schema: typeof ACP_SESSION_PROJECTION_SCHEMA;
  agentSessionId: string;
  binding: AgentSessionBindingFingerprintV1;
  backend: Readonly<{
    sessionId: string;
    capabilities: Readonly<{ resume: boolean; load: boolean }>;
  }>;
  conversation: readonly AcpProjectedConversationEntry[];
  lastStop?: Readonly<{
    stopReason: string;
    usage?: AcpProjectedUsage;
  }>;
  createdAt: string;
  updatedAt: string;
}>;

export type PersistenceIssueOperation = "read" | "validate" | "write";

export class PersistenceIssue extends Error {
  readonly operation: PersistenceIssueOperation;
  readonly path: string;

  constructor(
    operation: PersistenceIssueOperation,
    path: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "PersistenceIssue";
    this.operation = operation;
    this.path = path;
  }
}

export class SessionBindingMismatchIssue extends Error {
  readonly categories: readonly [AgentSessionBindingCategory, ...AgentSessionBindingCategory[]];

  constructor(categories: readonly [AgentSessionBindingCategory, ...AgentSessionBindingCategory[]]) {
    super("The ACP session projection binding does not match the requested Agent Session.");
    this.name = "SessionBindingMismatchIssue";
    this.categories = categories;
  }
}

export type LoadAcpSessionProjectionInput = Readonly<{
  stateDirectory: string;
  agentSessionId: string;
  bindingFingerprint: AgentSessionBindingFingerprintV1;
}>;

export function acpSessionProjectionPath(agentSessionId: string): string {
  return `sessions/${encodeURIComponent(agentSessionId)}.json`;
}

export async function loadAcpSessionProjection(
  input: LoadAcpSessionProjectionInput,
): Promise<AcpSessionProjection | undefined> {
  const relativePath = acpSessionProjectionPath(input.agentSessionId);
  let source: string;
  try {
    const directory = await openProjectionDirectory(input.stateDirectory, false);
    if (directory === undefined) return undefined;
    try {
      const loaded = await readProjectionFile(directory, basename(relativePath));
      if (loaded === undefined) return undefined;
      source = loaded;
    } finally {
      await closeProjectionDirectory(directory);
    }
  } catch (error) {
    throw issue("read", relativePath, "Could not read the ACP session projection.", error);
  }

  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch (error) {
    throw issue("validate", relativePath, "The ACP session projection is not valid JSON.", error);
  }

  if (!isAcpSessionProjection(value, true)) {
    throw issue("validate", relativePath, "The ACP session projection has an unsupported shape.");
  }
  if (value.agentSessionId !== input.agentSessionId) {
    throw issue("validate", relativePath, "The ACP session projection Agent Session id does not match.");
  }
  validateBinding(value.binding, input.bindingFingerprint, relativePath);
  return value;
}

export async function saveAcpSessionProjection(
  stateDirectory: string,
  projection: AcpSessionProjection,
  commit?: Readonly<{ beforeRename(): void; afterRename(): void }>,
): Promise<void> {
  const relativePath = acpSessionProjectionPath(projection.agentSessionId);
  let serialized: string;
  try {
    if (!isAcpSessionProjection(projection, false)) {
      throw new TypeError("The projection has an unsupported shape.");
    }
    serialized = `${JSON.stringify(normalizeProjection(projection))}\n`;
  } catch (error) {
    throw issue("validate", relativePath, "The ACP session projection could not be serialized.", error);
  }

  const leaf = basename(relativePath);
  let directory: ProjectionDirectory | undefined;
  let temporary: TemporaryProjection | undefined;
  try {
    try {
      directory = await openProjectionDirectory(stateDirectory, true);
      if (directory === undefined) throw new Error("The projection directory was not created.");
      temporary = {
        path: join(directory.accessPath, `${leaf}.${randomUUID()}.tmp`),
        created: false,
      };
      await writeTemporaryProjection(directory, temporary, serialized);
    } catch (error) {
      throw issue("write", relativePath, "Could not persist the ACP session projection.", error);
    }
    const absolutePath = join(directory.accessPath, leaf);
    if (commit === undefined) {
      try {
        verifyProjectionDirectory(directory);
        await rename(temporary.path, absolutePath);
        verifyProjectionDirectory(directory);
      } catch (error) {
        throw issue("write", relativePath, "Could not persist the ACP session projection.", error);
      }
    } else {
      commit.beforeRename();
      try {
        verifyProjectionDirectory(directory);
        renameSync(temporary.path, absolutePath);
        verifyProjectionDirectory(directory);
      } catch (error) {
        throw issue("write", relativePath, "Could not persist the ACP session projection.", error);
      }
      commit.afterRename();
    }
  } finally {
    if (directory !== undefined && temporary !== undefined) {
      await cleanupTemporaryProjection(directory, temporary).catch(() => undefined);
    }
    if (directory !== undefined) await closeProjectionDirectory(directory);
  }
}

type FilesystemIdentity = Readonly<{
  dev: bigint;
  ino: bigint;
  birthtimeMs: bigint;
}>;

type OpenedDirectory = Readonly<{
  handle: FileHandle;
  path: string;
  realpath: string;
  identity: FilesystemIdentity;
  rejectSymlink: boolean;
}>;

type ProjectionDirectory = Readonly<{
  state: OpenedDirectory;
  sessions: OpenedDirectory;
  accessPath: string;
}>;

type TemporaryProjection = {
  readonly path: string;
  created: boolean;
  identity?: FilesystemIdentity;
};

async function openProjectionDirectory(
  stateDirectory: string,
  create: boolean,
): Promise<ProjectionDirectory | undefined> {
  const statePath = resolve(stateDirectory);
  if (create) await mkdir(statePath, { recursive: true, mode: 0o700 });

  let stateHandle: FileHandle | undefined;
  let sessionsHandle: FileHandle | undefined;
  try {
    try {
      stateHandle = await open(statePath, directoryOpenFlags());
    } catch (error) {
      if (!create && errorCode(error) === "ENOENT") return undefined;
      throw error;
    }
    const state = await openedDirectory(stateHandle, statePath, false);
    const stateDescriptor = descriptorPath(stateHandle.fd);
    const parentAccessPath = stateDescriptor ?? statePath;
    const sessionsPath = join(statePath, "sessions");
    const sessionsAccessPath = join(parentAccessPath, "sessions");

    if (create) {
      verifyOpenedDirectory(state);
      let createdSessions = false;
      try {
        await mkdir(sessionsAccessPath, { mode: 0o700 });
        createdSessions = true;
      } catch (error) {
        if (errorCode(error) !== "EEXIST") throw error;
      }
      try {
        verifyOpenedDirectory(state);
      } catch (error) {
        if (createdSessions) await rmdir(sessionsAccessPath).catch(() => undefined);
        throw error;
      }
    }

    try {
      sessionsHandle = await open(
        sessionsAccessPath,
        directoryOpenFlags() | noFollowFlag(),
      );
    } catch (error) {
      if (!create && errorCode(error) === "ENOENT") {
        try {
          lstatSync(sessionsAccessPath);
        } catch (inspectionError) {
          if (errorCode(inspectionError) !== "ENOENT") throw inspectionError;
          await stateHandle.close();
          stateHandle = undefined;
          return undefined;
        }
        throw new Error(`Projection directory '${sessionsPath}' is not a directory.`);
      }
      throw error;
    }
    const sessions = await openedDirectory(sessionsHandle, sessionsPath, true);
    const sessionsDescriptor = descriptorPath(sessionsHandle.fd);
    if ((stateDescriptor === undefined) !== (sessionsDescriptor === undefined)) {
      throw new Error("The projection directory descriptor is unavailable.");
    }

    if (stateDescriptor === undefined || sessionsDescriptor === undefined) {
      verifyOpenedDirectory(state);
      verifyOpenedDirectory(sessions);
    } else {
      const [currentState, currentSessions] = await Promise.all([
        realpath(stateDescriptor),
        realpath(sessionsDescriptor),
      ]);
      if (dirname(currentSessions) !== currentState || basename(currentSessions) !== "sessions") {
        throw new Error("The projection directory is outside the supplied state directory.");
      }
    }

    return {
      state,
      sessions,
      accessPath: sessionsDescriptor ?? sessionsPath,
    };
  } catch (error) {
    await Promise.allSettled([sessionsHandle?.close(), stateHandle?.close()]);
    throw error;
  }
}

async function openedDirectory(
  handle: FileHandle,
  path: string,
  rejectSymlink: boolean,
): Promise<OpenedDirectory> {
  const info = await handle.stat({ bigint: true });
  if (!info.isDirectory()) throw new Error(`Projection directory '${path}' is not a directory.`);
  const descriptor = descriptorPath(handle.fd);
  const directory = {
    handle,
    path,
    realpath: await realpath(descriptor ?? path),
    identity: filesystemIdentity(info),
    rejectSymlink,
  };
  if (descriptor === undefined) verifyOpenedDirectory(directory);
  return directory;
}

async function readProjectionFile(
  directory: ProjectionDirectory,
  leaf: string,
): Promise<string | undefined> {
  const path = join(directory.accessPath, leaf);
  verifyProjectionDirectory(directory);
  let file: FileHandle;
  try {
    file = await open(path, fsConstants.O_RDONLY | noFollowFlag());
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw error;
  }
  try {
    const info = await file.stat({ bigint: true });
    if (!info.isFile()) throw new Error(`Projection '${leaf}' is not a regular file.`);
    verifyOpenedFile(path, info);
    verifyProjectionDirectory(directory);
    const source = await file.readFile({ encoding: "utf8" });
    verifyOpenedFile(path, info);
    verifyProjectionDirectory(directory);
    return source;
  } finally {
    await file.close();
  }
}

async function writeTemporaryProjection(
  directory: ProjectionDirectory,
  temporary: TemporaryProjection,
  serialized: string,
): Promise<void> {
  verifyProjectionDirectory(directory);
  const file = await open(
    temporary.path,
    fsConstants.O_WRONLY
      | fsConstants.O_CREAT
      | fsConstants.O_EXCL
      | noFollowFlag(),
    0o600,
  );
  temporary.created = true;
  try {
    const info = await file.stat({ bigint: true });
    temporary.identity = filesystemIdentity(info);
    if (!info.isFile()) throw new Error("The temporary projection is not a regular file.");
    verifyOpenedFile(temporary.path, info);
    verifyProjectionDirectory(directory);
    await file.writeFile(serialized, { encoding: "utf8" });
    verifyOpenedFile(temporary.path, info);
    verifyProjectionDirectory(directory);
  } finally {
    await file.close();
  }
}

async function cleanupTemporaryProjection(
  directory: ProjectionDirectory,
  temporary: TemporaryProjection,
): Promise<void> {
  if (!temporary.created) return;
  if (process.platform !== "linux") {
    verifyProjectionDirectory(directory);
    if (temporary.identity === undefined) return;
    let current: BigIntStats;
    try {
      current = lstatSync(temporary.path, { bigint: true });
    } catch (error) {
      if (errorCode(error) === "ENOENT") return;
      throw error;
    }
    if (current.isSymbolicLink()
      || !current.isFile()
      || !sameFilesystemIdentity(temporary.identity, current)) return;
  }
  await unlink(temporary.path).catch(error => {
    if (errorCode(error) !== "ENOENT") throw error;
  });
  if (process.platform !== "linux") verifyProjectionDirectory(directory);
}

function verifyProjectionDirectory(directory: ProjectionDirectory): void {
  verifyOpenedDirectory(directory.state);
  verifyOpenedDirectory(directory.sessions);
  if (dirname(directory.sessions.realpath) !== directory.state.realpath
    || basename(directory.sessions.realpath) !== "sessions") {
    throw new Error("The projection directory is outside the supplied state directory.");
  }
}

function verifyOpenedDirectory(directory: OpenedDirectory): void {
  const info = directory.rejectSymlink
    ? lstatSync(directory.path, { bigint: true })
    : statSync(directory.path, { bigint: true });
  if ((directory.rejectSymlink && info.isSymbolicLink())
    || !info.isDirectory()
    || !sameFilesystemIdentity(directory.identity, info)
    || realpathSync(directory.path) !== directory.realpath) {
    throw new Error(`Projection directory '${directory.path}' no longer matches its opened identity.`);
  }
}

function verifyOpenedFile(path: string, opened: BigIntStats): void {
  const current = lstatSync(path, { bigint: true });
  if (current.isSymbolicLink()
    || !current.isFile()
    || !sameFilesystemIdentity(filesystemIdentity(opened), current)) {
    throw new Error(`Projection file '${path}' no longer matches its opened identity.`);
  }
}

function filesystemIdentity(info: BigIntStats): FilesystemIdentity {
  return { dev: info.dev, ino: info.ino, birthtimeMs: info.birthtimeMs };
}

function sameFilesystemIdentity(expected: FilesystemIdentity, actual: BigIntStats): boolean {
  return expected.dev === actual.dev
    && expected.ino === actual.ino
    && expected.birthtimeMs === actual.birthtimeMs;
}

function directoryOpenFlags(): number {
  return fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0);
}

function noFollowFlag(): number {
  if (process.platform === "win32") return 0;
  if (fsConstants.O_NOFOLLOW === undefined) {
    throw new Error("The platform cannot refuse projection symlinks.");
  }
  return fsConstants.O_NOFOLLOW;
}

function descriptorPath(fileDescriptor: number): string | undefined {
  if (process.platform === "linux") return `/proc/self/fd/${fileDescriptor}`;
  return undefined;
}

async function closeProjectionDirectory(directory: ProjectionDirectory): Promise<void> {
  await Promise.allSettled([
    directory.sessions.handle.close(),
    directory.state.handle.close(),
  ]);
}

/** Retains the newest consecutive suffix that satisfies both persistence limits. */
export function boundConversation(
  conversation: readonly AcpProjectedConversationEntry[],
): AcpProjectedConversationEntry[] {
  const retained: AcpProjectedConversationEntry[] = [];
  let bytes = 2; // JSON array brackets.
  for (let index = conversation.length - 1;
    index >= 0 && retained.length < ACP_SESSION_CONVERSATION_MAX_ENTRIES;
    index -= 1) {
    const entry = conversation[index]!;
    const encoded = JSON.stringify(entry);
    if (encoded === undefined) throw new TypeError("Conversation entries must be JSON values.");
    const addedBytes = Buffer.byteLength(encoded, "utf8") + (retained.length === 0 ? 0 : 1);
    if (bytes + addedBytes > ACP_SESSION_CONVERSATION_MAX_BYTES) break;
    retained.push(entry);
    bytes += addedBytes;
  }
  return retained.reverse();
}

function normalizeProjection(projection: AcpSessionProjection): AcpSessionProjection {
  const normalized: AcpSessionProjection = {
    schema: ACP_SESSION_PROJECTION_SCHEMA,
    agentSessionId: projection.agentSessionId,
    binding: normalizeBinding(projection.binding),
    backend: {
      sessionId: projection.backend.sessionId,
      capabilities: {
        resume: projection.backend.capabilities.resume,
        load: projection.backend.capabilities.load,
      },
    },
    conversation: boundConversation(projection.conversation),
    ...(projection.lastStop === undefined
      ? {}
      : {
          lastStop: {
            stopReason: projection.lastStop.stopReason,
            ...(projection.lastStop.usage === undefined
              ? {}
              : { usage: { ...projection.lastStop.usage } }),
          },
        }),
    createdAt: projection.createdAt,
    updatedAt: projection.updatedAt,
  };
  if (!isAcpSessionProjection(normalized, true)) {
    throw new TypeError("The bounded projection has an unsupported shape.");
  }
  return normalized;
}

function isAcpSessionProjection(value: unknown, enforceBounds: boolean): value is AcpSessionProjection {
  if (!record(value)
    || !exactKeys(value, [
      "schema", "agentSessionId", "binding", "backend",
      "conversation", "createdAt", "updatedAt",
    ], ["lastStop"])
    || value.schema !== ACP_SESSION_PROJECTION_SCHEMA
    || !nonemptyString(value.agentSessionId)
    || !bindingFingerprint(value.binding)
    || !projectedBackend(value.backend)
    || !Array.isArray(value.conversation)
    || !value.conversation.every(projectedConversationEntry)
    || !optionalOwn(value, "lastStop", projectedLastStop)
    || !canonicalUtc(value.createdAt)
    || !canonicalUtc(value.updatedAt)
    || Date.parse(value.createdAt) > Date.parse(value.updatedAt)) return false;
  return !enforceBounds
    || value.conversation.length <= ACP_SESSION_CONVERSATION_MAX_ENTRIES
      && jsonBytes(value.conversation) <= ACP_SESSION_CONVERSATION_MAX_BYTES;
}

function projectedBackend(value: unknown): boolean {
  return record(value)
    && exactKeys(value, ["sessionId", "capabilities"])
    && nonemptyString(value.sessionId)
    && record(value.capabilities)
    && exactKeys(value.capabilities, ["resume", "load"])
    && typeof value.capabilities.resume === "boolean"
    && typeof value.capabilities.load === "boolean";
}

function projectedConversationEntry(value: unknown): value is AcpProjectedConversationEntry {
  if (!record(value)) return false;
  if (value.type === "message") {
    return exactKeys(value, ["type", "role", "content"])
      && (value.role === "user" || value.role === "assistant")
      && typeof value.content === "string";
  }
  if (value.type === "thought") {
    return exactKeys(value, ["type", "content"])
      && typeof value.content === "string";
  }
  if (value.type === "tool-call") {
    return exactKeys(value, ["type", "toolCallId"], ["title", "name", "kind", "status", "input"])
      && nonemptyString(value.toolCallId)
      && optionalOwn(value, "title", string)
      && optionalOwn(value, "name", string)
      && optionalOwn(value, "kind", string)
      && optionalOwn(value, "status", string)
      && optionalOwn(value, "input", jsonValue);
  }
  return value.type === "tool-result"
    && exactKeys(value, ["type", "toolCallId", "content"])
    && nonemptyString(value.toolCallId)
    && jsonValue(value.content);
}

function projectedLastStop(value: unknown): boolean {
  return record(value)
    && exactKeys(value, ["stopReason"], ["usage"])
    && nonemptyString(value.stopReason)
    && optionalOwn(value, "usage", projectedUsage);
}

function projectedUsage(value: unknown): boolean {
  if (!record(value) || !exactKeys(value, [], [
    "inputTokens", "outputTokens", "cachedReadTokens", "cachedWriteTokens",
    "thoughtTokens", "totalTokens",
  ])) return false;
  return Object.values(value).every(nonnegativeInteger);
}

function jsonValue(value: unknown): value is AcpProjectedJsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(jsonValue);
  return record(value) && Object.values(value).every(jsonValue);
}

function bindingFingerprint(value: unknown): value is AgentSessionBindingFingerprintV1 {
  return record(value)
    && exactKeys(value, ["version", "digest", "components"])
    && value.version === 1
    && sha256(value.digest)
    && record(value.components)
    && exactKeys(value.components, ["launch", "cwd", "model", "options"])
    && Object.values(value.components).every(sha256);
}

function normalizeBinding(value: AgentSessionBindingFingerprintV1): AgentSessionBindingFingerprintV1 {
  return {
    version: 1,
    digest: value.digest,
    components: {
      launch: value.components.launch,
      cwd: value.components.cwd,
      model: value.components.model,
      options: value.components.options,
    },
  };
}

function validateBinding(
  actual: AgentSessionBindingFingerprintV1,
  expected: AgentSessionBindingFingerprintV1,
  path: string,
): void {
  if (!bindingFingerprint(expected)) throw issue("validate", path, "The expected Agent Session binding is invalid.");
  const categories = (["launch", "cwd", "model", "options"] as const)
    .filter(category => actual.components[category] !== expected.components[category]);
  const overallEqual = actual.digest === expected.digest;
  const componentsEqual = categories.length === 0;
  if (overallEqual && componentsEqual) return;
  if (overallEqual || componentsEqual) {
    throw issue("validate", path, "The ACP session projection binding fingerprint is internally inconsistent.");
  }
  throw new SessionBindingMismatchIssue(categories as [
    AgentSessionBindingCategory,
    ...AgentSessionBindingCategory[],
  ]);
}

function sha256(value: unknown): value is `sha256:${string}` {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/u.test(value);
}

function record(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const keys = Object.keys(value);
  const allowed = new Set([...required, ...optional]);
  return required.every(key => Object.hasOwn(value, key))
    && keys.every(key => allowed.has(key));
}

function optionalOwn(
  value: Record<string, unknown>,
  key: string,
  predicate: (candidate: unknown) => boolean,
): boolean {
  return !Object.hasOwn(value, key) || predicate(value[key]);
}

function string(value: unknown): value is string {
  return typeof value === "string";
}

function nonemptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function nonnegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function canonicalUtc(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

function issue(
  operation: PersistenceIssueOperation,
  path: string,
  message: string,
  cause?: unknown,
): PersistenceIssue {
  return new PersistenceIssue(operation, path, message,
    cause === undefined ? undefined : { cause });
}
