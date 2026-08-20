import { openAcpSession, type AcpSession, type AcpSessionConfiguration } from "@acpus/acp";
import type { ProcessCapsuleError } from "./types.js";
import {
  ACP_WORKER_PROTOCOL_VERSION,
  isAcpWorkerParentMessage,
  type AcpWorkerChildMessage,
  type AcpWorkerParentMessage,
  type ProcessCapsuleTerminal,
} from "./worker-protocol.js";

const INHERIT_PROCESS_GROUP_ENV = "ACPUS_INTERNAL_ACP_INHERIT_PROCESS_GROUP";

type WorkerIdentity = { hostId: string; sessionLeaseId: string };
type InitializedWorker = WorkerIdentity & {
  configuration: Readonly<{ model?: string; options: Readonly<Record<string, string>> }>;
  session: AcpSession;
};
type ActiveTurn = { turnId: string; controller: AbortController };

let identity: WorkerIdentity | undefined;
let initialized: InitializedWorker | undefined;
let openingController: AbortController | undefined;
let opening: Promise<void> | undefined;
let active: ActiveTurn | undefined;
let closing = false;
let closingPromise: Promise<void> | undefined;

process.on("message", raw => {
  if (!isAcpWorkerParentMessage(raw)) return;
  void receive(raw).catch(error => fail(capsuleFailure("worker_exception", error)));
});

process.once("disconnect", () => { void closeWorker("parent disconnected"); });

async function receive(message: AcpWorkerParentMessage): Promise<void> {
  if (message.type === "open") {
    if (identity) throw new Error("ACP worker received duplicate initialization.");
    identity = identityOfMessage(message.input);
    openingController = new AbortController();
    opening = openWorker(message, openingController.signal);
    await opening;
    opening = undefined;
    openingController = undefined;
    if (!initialized && !closing) await failAndClose();
    return;
  }
  if (message.type === "close") {
    await closeWorker(message.reason);
    return;
  }
  const state = requireInitialized(message);
  if (message.type === "run") {
    if (active) throw new Error("ACP worker received a second active Turn.");
    await runTurn(state, message.turnId, message.prompt);
    return;
  }
  if (active?.turnId === message.turnId) active.controller.abort(message.reason);
}

async function openWorker(message: Extract<AcpWorkerParentMessage, { type: "open" }>, signal: AbortSignal): Promise<void> {
  const input = message.input;
  const opened = await openAcpSession({
    agentSessionId: input.agentSessionId,
    bindingFingerprint: input.bindingFingerprint,
    sessionOpenMode: input.sessionOpenMode,
    stateDirectory: input.sessionStateDirectory,
    launch: input.resolvedLaunch,
    cwd: input.cwd,
    env: {
      ...input.env,
      ...(process.env[INHERIT_PROCESS_GROUP_ENV] === undefined ? {} : { [INHERIT_PROCESS_GROUP_ENV]: process.env[INHERIT_PROCESS_GROUP_ENV] }),
    },
    permissionMode: input.permissionMode,
    configuration: {
      model: input.configuration.model ?? null,
      options: input.configuration.options,
    },
    signal,
  });
  if (opened.isErr()) {
    if (!closing) send({ type: "open_failed", protocolVersion: ACP_WORKER_PROTOCOL_VERSION, ...identityOfMessage(input), error: opened.error });
    return;
  }
  initialized = { ...identityOfMessage(input), configuration: input.configuration, session: opened.value };
  if (!closing) send({
    type: "ready",
    protocolVersion: ACP_WORKER_PROTOCOL_VERSION,
    ...identityOfMessage(input),
    projectionRef: opened.value.projectionPath,
    bindingFingerprint: input.bindingFingerprint,
    ...(opened.value.reportedVersion === undefined ? {} : { reportedVersion: opened.value.reportedVersion }),
  });
}

async function runTurn(state: InitializedWorker, turnId: string, prompt: string): Promise<void> {
  const controller = new AbortController();
  active = { turnId, controller };
  try {
    const configuration = turnConfiguration(state);
    const result = await state.session.runTurn({
      prompt,
      ...(configuration === undefined ? {} : { configuration }),
      signal: controller.signal,
      onEvent: event => send({
        type: "event",
        protocolVersion: ACP_WORKER_PROTOCOL_VERSION,
        ...identityOf(state),
        turnId,
        event,
      }),
    });
    const terminal: ProcessCapsuleTerminal = result.isOk()
      ? { type: "provider_result", result: result.value }
      : result.error.providerEvidence === "terminal_response"
        ? { type: "provider_error_response", error: result.error }
        : { type: "local_error", error: result.error };
    send({ type: "terminal", protocolVersion: ACP_WORKER_PROTOCOL_VERSION, ...identityOf(state), turnId, terminal });
  } catch (error) {
    fail(capsuleFailure("worker_exception", error));
  } finally {
    if (active?.turnId === turnId) active = undefined;
  }
}

function turnConfiguration(state: InitializedWorker): AcpSessionConfiguration | undefined {
  if (state.configuration.model === undefined && Object.keys(state.configuration.options).length === 0) return undefined;
  return {
    ...(state.configuration.model === undefined ? {} : { model: state.configuration.model }),
    ...(Object.keys(state.configuration.options).length === 0 ? {} : { options: state.configuration.options }),
  };
}

async function closeWorker(reason: string): Promise<void> {
  if (closingPromise) return closingPromise;
  closing = true;
  closingPromise = (async () => {
    openingController?.abort();
    active?.controller.abort("lease_lost");
    await opening?.catch(() => undefined);
    if (initialized) await initialized.session.close(reason).then(() => undefined);
    if (identity) send({ type: "closed", protocolVersion: ACP_WORKER_PROTOCOL_VERSION, ...identity });
    process.disconnect?.();
    process.exit(process.exitCode ?? 0);
  })();
  return closingPromise;
}

function fail(error: ProcessCapsuleError): void {
  if (identity) send({ type: "failed", protocolVersion: ACP_WORKER_PROTOCOL_VERSION, ...identity, error });
  process.exitCode = 1;
  void closeWorker("worker failure");
}

async function failAndClose(): Promise<void> {
  process.exitCode = 1;
  await closeWorker("worker failure");
}

function send(message: AcpWorkerChildMessage): void {
  if (process.connected) process.send?.(message);
}

function requireInitialized(
  message: Exclude<AcpWorkerParentMessage, { type: "open" | "close" }>,
): InitializedWorker {
  if (!initialized || initialized.hostId !== message.hostId || initialized.sessionLeaseId !== message.sessionLeaseId) {
    throw new Error("ACP worker received a message before initialization.");
  }
  return initialized;
}

function identityOf(state: InitializedWorker): WorkerIdentity { return { hostId: state.hostId, sessionLeaseId: state.sessionLeaseId }; }
function identityOfMessage(message: WorkerIdentity): WorkerIdentity { return { hostId: message.hostId, sessionLeaseId: message.sessionLeaseId }; }

function capsuleFailure(code: ProcessCapsuleError["code"], error: unknown): ProcessCapsuleError {
  return {
    type: "process_capsule",
    phase: initialized ? active ? "running" : "ready" : identity ? "opening" : "bootstrap",
    code,
    message: error instanceof Error ? error.message : String(error),
  };
}
