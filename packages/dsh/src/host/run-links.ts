import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Semaphore from "effect/Semaphore";
import { AcpusOperationError } from "./errors.js";
import {
  isTerminalProjection,
  preserveActivityStarts,
  type StoredRunProjection,
} from "./run-projection.js";
import type { ResolvedTaskSelector } from "../task.js";

export type RunLink = {
  workspace: string;
  admissionRequestId: string;
  runId?: string;
  workflowName?: string;
  occurrence?: number;
  forkedFromGeneration?: number;
  parentSessionId: string;
  generation: number;
};

export type AdmittedRunLink = RunLink & {
  runId: string;
  workflowName: string;
  occurrence: number;
};

export type StoredSessionProjection = {
  sessionId: string;
  revision: number;
  runs: readonly StoredRunProjection[];
};

export type ControlRejectionReason =
  | "already-terminal"
  | "not-controllable"
  | "temporarily-unavailable";

export type StoredControl = {
  id: string;
  requestId: string;
  actor: "user" | "model";
  parentSessionId: string;
  generation: number;
  workspace: string;
  runId: string;
  status: "pending" | "applied" | "rejected";
  taskStatus?: StoredRunProjection["status"];
  reason?: ControlRejectionReason;
};

export type StoredNotice = {
  id: string;
  parentSessionId: string;
  workspace: string;
  runId: string;
  task: ResolvedTaskSelector;
  kind: "signal" | "completed" | "failed" | "canceled" | "user-control";
  projectionUpdatedAt: string;
  signal?: {
    selector: string;
    prompt?: string;
    expected?: string;
  };
  terminalSummary?: string;
  control?: {
    actor: "user";
    operation: "cancel";
    outcome: "applied" | "rejected";
    taskStatus: StoredRunProjection["status"];
    reason?: ControlRejectionReason;
  };
  deliveredAt?: string;
};

export type ObservationCommit = {
  link: AdmittedRunLink;
  projection: StoredRunProjection;
  notice?: StoredNotice;
};

export type CommitResult = {
  revision: number;
  projectionChanged: boolean;
  noticeInserted: boolean;
  wakeWaiters: boolean;
};

export type AvailabilityCommitResult = {
  revision: number;
  changed: boolean;
};

export interface SupervisorStateStore {
  listLinks(): Effect.Effect<RunLink[], AcpusOperationError>;
  listReconciliationLinks(): Effect.Effect<RunLink[], AcpusOperationError>;
  readSession(sessionId: string): Effect.Effect<StoredSessionProjection, AcpusOperationError>;
  commitObservation(input: ObservationCommit): Effect.Effect<CommitResult, AcpusOperationError>;
  setRunUnavailable(input: {
    link: RunLink;
    unavailable?: NonNullable<StoredRunProjection["unavailable"]>;
  }): Effect.Effect<AvailabilityCommitResult, AcpusOperationError>;
  pendingNotices(): Effect.Effect<StoredNotice[], AcpusOperationError>;
  markNoticeDelivered(noticeId: string): Effect.Effect<void, AcpusOperationError>;
  prepareCancel(input: {
    sessionId: string;
    generation: number;
    actor: "user" | "model";
    requestId?: string;
  }): Effect.Effect<
    | { status: "ready"; control: StoredControl; link: AdmittedRunLink }
    | { status: "rejected"; reason: "task-unavailable" | "already-terminal" },
    AcpusOperationError
  >;
  settleCancel(input: {
    controlId: string;
    outcome: "applied" | "rejected";
    taskStatus: StoredRunProjection["status"];
    reason?: ControlRejectionReason;
  }): Effect.Effect<void, AcpusOperationError>;
  pendingControls(): Effect.Effect<StoredControl[], AcpusOperationError>;
}

type SupervisorStateFile = {
  kind: "acpus_dsh_supervisor_state";
  version: 1;
  links: readonly RunLink[];
  sessions: readonly StoredSessionProjection[];
  notices: readonly StoredNotice[];
  controls: readonly StoredControl[];
};

const EMPTY_STATE: SupervisorStateFile = {
  kind: "acpus_dsh_supervisor_state",
  version: 1,
  links: [],
  sessions: [],
  notices: [],
  controls: [],
};

export class DurableSupervisorStateStore implements SupervisorStateStore {
  private state = EMPTY_STATE;
  private loaded = false;
  private readonly mutation = Semaphore.makeUnsafe(1);

  constructor(private readonly path: string) {}

  listLinks(): Effect.Effect<RunLink[], AcpusOperationError> {
    return this.read(() => structuredClone([...this.state.links]));
  }

  listReconciliationLinks(): Effect.Effect<RunLink[], AcpusOperationError> {
    return this.read(() => structuredClone(this.state.links.filter(link => {
      if (link.runId === undefined) return true;
      const projection = this.state.sessions
        .find(session => session.sessionId === link.parentSessionId)
        ?.runs.find(run => run.runId === link.runId);
      return projection === undefined || !isTerminalProjection(projection);
    })));
  }

  readLink(
    input: Omit<RunLink, "runId" | "workflowName" | "occurrence" | "generation">,
  ): Effect.Effect<RunLink | undefined, AcpusOperationError> {
    return this.read(() => {
      const existing = this.state.links.find(
        link => link.admissionRequestId === input.admissionRequestId,
      );
      assertLinkIdentity(existing, input);
      return existing === undefined ? undefined : structuredClone(existing);
    });
  }

  readSession(sessionId: string): Effect.Effect<StoredSessionProjection, AcpusOperationError> {
    return this.read(() => {
      const session = this.state.sessions.find(
        candidate => candidate.sessionId === sessionId,
      ) ?? { sessionId, revision: 0, runs: [] };
      const links = new Map(this.state.links.flatMap(link =>
        link.parentSessionId === sessionId && link.runId !== undefined
          ? [[link.runId, link] as const]
          : []));
      return structuredClone({
        ...session,
        runs: session.runs.flatMap(run => {
          const link = links.get(run.runId);
          return link === undefined ? [] : [{
            ...run,
            workspace: link.workspace,
            admissionRequestId: link.admissionRequestId,
          }];
        }),
      });
    });
  }

  commitObservation(
    input: ObservationCommit,
  ): Effect.Effect<CommitResult, AcpusOperationError> {
    return this.mutate<CommitResult>(() => {
      const session = this.state.sessions.find(
        candidate => candidate.sessionId === input.link.parentSessionId,
      ) ?? {
        sessionId: input.link.parentSessionId,
        revision: 0,
        runs: [],
      };
      const current = session.runs.find(run => run.runId === input.projection.runId);
      const projection = preserveActivityStarts(input.projection, current);
      const projectionChanged = !sameValue(current, projection);
      const suppressedCanceled = input.notice?.kind === "canceled"
        && this.state.controls.some(control =>
          control.runId === input.link.runId
          && control.status !== "rejected");
      const noticeInserted = input.notice !== undefined
        && !suppressedCanceled
        && !(input.notice.kind !== "signal" && current?.status === input.notice.kind)
        && !this.state.notices.some(notice => notice.id === input.notice?.id);
      if (!projectionChanged && !noticeInserted) {
        return Effect.succeed({
          revision: session.revision,
          projectionChanged: false,
          noticeInserted: false,
          wakeWaiters: false,
        });
      }

      const previous = this.state;
      const sessions = projectionChanged
        ? replaceSession(this.state.sessions, {
            ...session,
            revision: session.revision + 1,
            runs: replaceProjection(session.runs, projection),
          })
        : this.state.sessions;
      this.state = {
        ...this.state,
        sessions,
        notices: noticeInserted
          ? [...this.state.notices, input.notice as StoredNotice]
          : this.state.notices,
      };
      const result = {
        revision: projectionChanged ? session.revision + 1 : session.revision,
        projectionChanged,
        noticeInserted,
        wakeWaiters: projectionChanged,
      };
      return this.flushState(previous).pipe(Effect.as(result));
    });
  }

  setRunUnavailable(input: {
    link: RunLink;
    unavailable?: NonNullable<StoredRunProjection["unavailable"]>;
  }): Effect.Effect<AvailabilityCommitResult, AcpusOperationError> {
    return this.mutate<AvailabilityCommitResult>(() => {
      if (input.link.runId === undefined) {
        return Effect.succeed({ revision: 0, changed: false });
      }
      const session = this.state.sessions.find(
        candidate => candidate.sessionId === input.link.parentSessionId,
      );
      const projection = session?.runs.find(run => run.runId === input.link.runId);
      if (session === undefined || projection === undefined || isTerminalProjection(projection)) {
        return Effect.succeed({ revision: session?.revision ?? 0, changed: false });
      }
      const sameUnavailable = input.unavailable === undefined
        ? projection.unavailable === undefined
        : projection.unavailable?.reason === input.unavailable.reason;
      if (sameUnavailable) {
        return Effect.succeed({ revision: session.revision, changed: false });
      }

      const next = input.unavailable === undefined
        ? withoutUnavailable(projection)
        : { ...projection, unavailable: input.unavailable };
      const previous = this.state;
      const revision = session.revision + 1;
      this.state = {
        ...this.state,
        sessions: replaceSession(this.state.sessions, {
          ...session,
          revision,
          runs: replaceProjection(session.runs, next),
        }),
      };
      return this.flushState(previous).pipe(Effect.as({ revision, changed: true }));
    });
  }

  pendingNotices(): Effect.Effect<StoredNotice[], AcpusOperationError> {
    return this.read(() => structuredClone(
      this.state.notices.filter(notice => notice.deliveredAt === undefined),
    ));
  }

  markNoticeDelivered(noticeId: string): Effect.Effect<void, AcpusOperationError> {
    return this.mutate(() => {
      const notice = this.state.notices.find(candidate => candidate.id === noticeId);
      if (notice === undefined || notice.deliveredAt !== undefined) return Effect.void;
      const previous = this.state;
      return Clock.currentTimeMillis.pipe(
        Effect.tap(milliseconds => Effect.sync(() => {
          this.state = {
            ...this.state,
            notices: this.state.notices.map(candidate => candidate.id === noticeId
              ? { ...candidate, deliveredAt: new Date(milliseconds).toISOString() }
              : candidate),
          };
        })),
        Effect.andThen(Effect.suspend(() => this.flushState(previous))),
      );
    });
  }

  prepareCancel(input: {
    sessionId: string;
    generation: number;
    actor: "user" | "model";
    requestId?: string;
  }): Effect.Effect<
    | { status: "ready"; control: StoredControl; link: AdmittedRunLink }
    | { status: "rejected"; reason: "task-unavailable" | "already-terminal" },
    AcpusOperationError
  > {
    const store = this;
    return this.mutate(() => Effect.gen(function* () {
      const current = store.state.links.find(link =>
        link.parentSessionId === input.sessionId
        && link.generation === input.generation);
      if (!isAdmittedRunLink(current)) {
        return { status: "rejected", reason: "task-unavailable" };
      }
      const projection = store.state.sessions
        .find(session => session.sessionId === input.sessionId)
        ?.runs.find(run => run.runId === current.runId);
      if (projection === undefined) return { status: "rejected", reason: "task-unavailable" };
      if (["completed", "failed", "canceled"].includes(projection.status)) {
        if (input.actor === "user") {
          yield* store.insertControlAttention(current, {
            outcome: "rejected",
            taskStatus: projection.status,
            reason: "already-terminal",
          });
        }
        return { status: "rejected", reason: "already-terminal" };
      }
      const id = controlId(input.sessionId, input.generation, input.actor);
      const existing = store.state.controls.find(control => control.id === id);
      if (existing !== undefined) {
        return {
          status: "ready",
          control: structuredClone(existing),
          link: structuredClone(current),
        };
      }
      const control: StoredControl = {
        id,
        requestId: input.requestId ?? `dsh-cancel:${id.slice("acpus-control:".length)}`,
        actor: input.actor,
        parentSessionId: input.sessionId,
        generation: input.generation,
        workspace: current.workspace,
        runId: current.runId,
        status: "pending",
      };
      const previous = store.state;
      store.state = { ...store.state, controls: [...store.state.controls, control] };
      yield* store.flushState(previous);
      return {
        status: "ready",
        control: structuredClone(control),
        link: structuredClone(current),
      };
    }));
  }

  settleCancel(input: {
    controlId: string;
    outcome: "applied" | "rejected";
    taskStatus: StoredRunProjection["status"];
    reason?: ControlRejectionReason;
  }): Effect.Effect<void, AcpusOperationError> {
    return this.mutate(() => {
      const current = this.state.controls.find(control => control.id === input.controlId);
      if (current === undefined || current.status !== "pending") return Effect.void;
      const settled: StoredControl = {
        ...current,
        status: input.outcome,
        taskStatus: input.taskStatus,
        ...(input.reason === undefined ? {} : { reason: input.reason }),
      };
      const link = this.state.links.find(candidate =>
        candidate.runId === current.runId
        && candidate.parentSessionId === current.parentSessionId);
      const previous = this.state;
      this.state = {
        ...this.state,
        controls: this.state.controls.map(control => control.id === current.id ? settled : control),
      };
      const updateAttention = current.actor === "user" && isAdmittedRunLink(link)
        ? Clock.currentTimeMillis.pipe(Effect.tap(milliseconds => Effect.sync(() => {
            const id = `${controlId(link.parentSessionId, link.generation, "user")}:attention`;
            const notice: StoredNotice = {
              id,
              parentSessionId: link.parentSessionId,
              workspace: link.workspace,
              runId: link.runId,
              task: { name: link.workflowName, occurrence: link.occurrence },
              kind: "user-control",
              projectionUpdatedAt: new Date(milliseconds).toISOString(),
              control: {
                actor: "user",
                operation: "cancel",
                outcome: input.outcome,
                taskStatus: input.taskStatus,
                ...(input.reason === undefined ? {} : { reason: input.reason }),
              },
            };
            this.state = {
              ...this.state,
              notices: [
                ...this.state.notices.filter(candidate =>
                  candidate.id !== id
                  && !(candidate.runId === link.runId
                    && candidate.kind !== "signal"
                    && candidate.deliveredAt === undefined)),
                notice,
              ],
            };
          })))
        : Effect.void;
      return updateAttention.pipe(
        Effect.andThen(Effect.suspend(() => this.flushState(previous))),
      );
    });
  }

  pendingControls(): Effect.Effect<StoredControl[], AcpusOperationError> {
    return this.read(() => structuredClone(
      this.state.controls.filter(control => control.status === "pending"),
    ));
  }

  provisional(
    input: Omit<RunLink, "runId" | "workflowName" | "occurrence" | "generation">,
  ): Effect.Effect<RunLink, AcpusOperationError> {
    return this.mutate(() => {
      const existing = this.state.links.find(
        link => link.admissionRequestId === input.admissionRequestId,
      );
      assertLinkIdentity(existing, input);
      if (existing !== undefined) {
        return Effect.succeed(existing);
      }
      const generation = Math.max(0, ...this.state.links
        .filter(link => link.parentSessionId === input.parentSessionId)
        .map(link => link.generation)) + 1;
      const link = { ...input, generation };
      const previous = this.state;
      this.state = { ...this.state, links: [...this.state.links, link] };
      return this.flushState(previous).pipe(Effect.as(link));
    });
  }

  admitted(
    admissionRequestId: string,
    run: { id: string; name: string },
  ): Effect.Effect<AdmittedRunLink, AcpusOperationError> {
    return this.mutate(() => {
      const current = this.state.links.find(
        link => link.admissionRequestId === admissionRequestId,
      );
      if (current === undefined) {
        throw new Error(`Acpus run link '${admissionRequestId}' was not provisioned.`);
      }
      if (current.runId !== undefined && current.runId !== run.id) {
        throw new Error(`Acpus run link '${admissionRequestId}' already names another run.`);
      }
      if (current.runId === run.id) {
        if (!isAdmittedRunLink(current) || current.workflowName !== run.name) {
          throw new Error(`Acpus run link '${admissionRequestId}' has inconsistent workflow metadata.`);
        }
        return Effect.succeed(current);
      }
      const occurrence = Math.max(0, ...this.state.links
        .filter(link =>
          link.parentSessionId === current.parentSessionId
          && link.workflowName === run.name)
        .map(link => link.occurrence ?? 0)) + 1;
      const link: AdmittedRunLink = {
        ...current,
        runId: run.id,
        workflowName: run.name,
        occurrence,
      };
      const previous = this.state;
      this.state = {
        ...this.state,
        links: this.state.links.map(candidate =>
          candidate.admissionRequestId === admissionRequestId ? link : candidate),
      };
      return this.flushState(previous).pipe(Effect.as(link));
    });
  }

  private load(): Effect.Effect<void, AcpusOperationError> {
    if (this.loaded) return Effect.void;
    const store = this;
    return Effect.tryPromise({
      try: async () => {
        try {
          return { found: true as const, document: JSON.parse(await readFile(store.path, "utf8")) };
        } catch (error) {
          if (isCode(error, "ENOENT")) return { found: false as const };
          throw error;
        }
      },
      catch: error => new AcpusOperationError(
        error instanceof SyntaxError
          ? `Acpus DSH supervisor state '${store.path}' has an unsupported format.`
          : "Acpus could not read the private DSH supervisor state.",
        error instanceof SyntaxError ? "ACPUS_RUN_LINKS_INVALID" : "ACPUS_RUN_LINK_READ_FAILED",
        { cause: error },
      ),
    }).pipe(Effect.flatMap(result => {
      if (!result.found) {
        return Effect.sync(() => {
          store.loaded = true;
        });
      }
      if (!isSupervisorStateFile(result.document)) {
        return Effect.fail(new AcpusOperationError(
          `Acpus DSH supervisor state '${store.path}' has an unsupported format.`,
          "ACPUS_RUN_LINKS_INVALID",
        ));
      }
      return Effect.sync(() => {
        store.state = result.document;
        store.loaded = true;
      });
    }));
  }

  private flush(): Effect.Effect<void, AcpusOperationError> {
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    const document: SupervisorStateFile = {
      ...this.state,
      links: [...this.state.links].sort((left, right) =>
        left.admissionRequestId.localeCompare(right.admissionRequestId)),
      sessions: [...this.state.sessions].sort((left, right) =>
        left.sessionId.localeCompare(right.sessionId)),
      notices: [...this.state.notices].sort((left, right) => left.id.localeCompare(right.id)),
      controls: [...this.state.controls].sort((left, right) => left.id.localeCompare(right.id)),
    };
    const path = this.path;
    return Effect.tryPromise({
      try: async () => {
        await mkdir(dirname(path), { recursive: true });
        try {
          await writeFile(temporary, `${JSON.stringify(document)}\n`, {
            encoding: "utf8",
            flag: "wx",
            mode: 0o600,
          });
          if (process.platform !== "win32") await chmod(temporary, 0o600);
          await rename(temporary, path);
        } finally {
          await rm(temporary, { force: true });
        }
      },
      catch: error => new AcpusOperationError(
        "Acpus could not persist the private DSH supervisor state.",
        "ACPUS_RUN_LINK_WRITE_FAILED",
        { cause: error },
      ),
    });
  }

  private mutate<T>(
    operation: () => Effect.Effect<T, AcpusOperationError>,
  ): Effect.Effect<T, AcpusOperationError> {
    return Effect.uninterruptible(this.mutation.withPermit(
      this.load().pipe(Effect.andThen(Effect.suspend(operation))),
    ));
  }

  private read<T>(operation: () => T): Effect.Effect<T, AcpusOperationError> {
    return this.mutate(() => Effect.sync(operation));
  }

  private insertControlAttention(
    link: AdmittedRunLink,
    result: {
      outcome: "applied" | "rejected";
      taskStatus: StoredRunProjection["status"];
      reason?: ControlRejectionReason;
    },
  ): Effect.Effect<void, AcpusOperationError> {
    const id = `${controlId(link.parentSessionId, link.generation, "user")}:attention`;
    const previous = this.state;
    return Clock.currentTimeMillis.pipe(
      Effect.tap(milliseconds => Effect.sync(() => {
        const notice: StoredNotice = {
          id,
          parentSessionId: link.parentSessionId,
          workspace: link.workspace,
          runId: link.runId,
          task: { name: link.workflowName, occurrence: link.occurrence },
          kind: "user-control",
          projectionUpdatedAt: new Date(milliseconds).toISOString(),
          control: {
            actor: "user",
            operation: "cancel",
            ...result,
          },
        };
        this.state = {
          ...this.state,
          notices: [
            ...this.state.notices.filter(candidate =>
              candidate.id !== id
              && !(candidate.runId === link.runId
                && candidate.kind !== "signal"
                && candidate.deliveredAt === undefined)),
            notice,
          ],
        };
      })),
      Effect.andThen(Effect.suspend(() => this.flushState(previous))),
    );
  }

  private flushState(previous: SupervisorStateFile): Effect.Effect<void, AcpusOperationError> {
    return this.flush().pipe(Effect.onExit(exit => Exit.isFailure(exit)
      ? Effect.sync(() => {
          this.state = previous;
        })
      : Effect.void));
  }
}

export { DurableSupervisorStateStore as RunLinkStore };

function isCode(error: unknown, code: string): boolean {
  return error instanceof Error
    && "code" in error
    && error.code === code;
}

function isRunLink(value: unknown): value is RunLink {
  if (!value || typeof value !== "object") return false;
  const link = value as Record<string, unknown>;
  return typeof link.workspace === "string"
    && typeof link.admissionRequestId === "string"
    && (link.runId === undefined || typeof link.runId === "string")
    && (link.workflowName === undefined || typeof link.workflowName === "string")
    && (link.occurrence === undefined
      || Number.isSafeInteger(link.occurrence) && Number(link.occurrence) > 0)
    && (link.forkedFromGeneration === undefined
      || Number.isSafeInteger(link.forkedFromGeneration)
        && Number(link.forkedFromGeneration) > 0)
    && typeof link.parentSessionId === "string"
    && Number.isSafeInteger(link.generation)
    && Number(link.generation) > 0
    && (link.runId === undefined
      ? link.workflowName === undefined && link.occurrence === undefined
      : typeof link.workflowName === "string" && Number.isSafeInteger(link.occurrence));
}

function isAdmittedRunLink(value: RunLink | undefined): value is AdmittedRunLink {
  return value?.runId !== undefined
    && value.workflowName !== undefined
    && value.occurrence !== undefined;
}

function isStoredRunProjection(value: unknown): value is StoredRunProjection {
  if (!value || typeof value !== "object") return false;
  const projection = value as Record<string, unknown>;
  return typeof projection.runId === "string"
    && typeof projection.workspace === "string"
    && Number.isSafeInteger(projection.generation)
    && Number(projection.generation) > 0
    && Number.isSafeInteger(projection.occurrence)
    && Number(projection.occurrence) > 0
    && (projection.forkedFromGeneration === undefined
      || Number.isSafeInteger(projection.forkedFromGeneration)
        && Number(projection.forkedFromGeneration) > 0)
    && typeof projection.name === "string"
    && typeof projection.status === "string"
    && typeof projection.createdAt === "string"
    && typeof projection.updatedAt === "string"
    && Array.isArray(projection.activity)
    && projection.activity.every(isStoredActivityNode)
    && (projection.unavailable === undefined || isStoredUnavailable(projection.unavailable))
    && !!projection.counts
    && typeof projection.counts === "object";
}

function isStoredUnavailable(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const unavailable = value as Record<string, unknown>;
  return [
    "workspace-unavailable",
    "runtime-authority-busy",
    "runtime-store-unavailable",
    "runtime-store-unsupported",
    "runtime-configuration-invalid",
    "runtime-open-failed",
  ].includes(String(unavailable.reason))
    && typeof unavailable.detail === "string"
    && typeof unavailable.detectedAt === "string";
}

function isStoredActivityNode(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const node = value as Record<string, unknown>;
  return typeof node.key === "string"
    && typeof node.activityId === "string"
    && (node.target === undefined || typeof node.target === "string")
    && typeof node.status === "string"
    && typeof node.label === "string"
    && typeof node.kind === "string"
    && (node.startedAt === undefined || typeof node.startedAt === "string")
    && (node.durationMs === undefined || typeof node.durationMs === "number")
    && (node.agent === undefined || !!node.agent && typeof node.agent === "object")
    && Array.isArray(node.children)
    && node.children.every(isStoredActivityNode);
}

function isSessionProjection(value: unknown): value is StoredSessionProjection {
  if (!value || typeof value !== "object") return false;
  const session = value as Record<string, unknown>;
  return typeof session.sessionId === "string"
    && Number.isSafeInteger(session.revision)
    && Number(session.revision) >= 0
    && Array.isArray(session.runs)
    && session.runs.every(isStoredRunProjection)
    && new Set(session.runs.map(run => run.runId)).size === session.runs.length;
}

function isStoredNotice(value: unknown): value is StoredNotice {
  if (!value || typeof value !== "object") return false;
  const notice = value as Record<string, unknown>;
  return typeof notice.id === "string"
    && typeof notice.parentSessionId === "string"
    && typeof notice.workspace === "string"
    && typeof notice.runId === "string"
    && isTaskSelector(notice.task)
    && ["signal", "completed", "failed", "canceled", "user-control"].includes(String(notice.kind))
    && typeof notice.projectionUpdatedAt === "string"
    && (notice.terminalSummary === undefined || typeof notice.terminalSummary === "string")
    && (notice.deliveredAt === undefined || typeof notice.deliveredAt === "string");
}

function isTaskSelector(value: unknown): value is ResolvedTaskSelector {
  if (!value || typeof value !== "object") return false;
  const task = value as Record<string, unknown>;
  return typeof task.name === "string"
    && Number.isSafeInteger(task.occurrence)
    && Number(task.occurrence) > 0;
}

function assertLinkIdentity(
  existing: RunLink | undefined,
  input: Omit<RunLink, "runId" | "workflowName" | "occurrence" | "generation">,
): void {
  if (existing !== undefined
    && (existing.workspace !== input.workspace
      || existing.parentSessionId !== input.parentSessionId)) {
    throw new AcpusOperationError(
      `Acpus run link '${input.admissionRequestId}' conflicts with another request.`,
      "ACPUS_RUN_LINK_CONFLICT",
    );
  }
}

function isSupervisorStateFile(value: unknown): value is SupervisorStateFile {
  if (!value || typeof value !== "object") return false;
  const document = value as Record<string, unknown>;
  return document.kind === "acpus_dsh_supervisor_state"
    && document.version === 1
    && Array.isArray(document.links)
    && document.links.every(isRunLink)
    && new Set(document.links.map(link => link.admissionRequestId)).size === document.links.length
    && Array.isArray(document.sessions)
    && document.sessions.every(isSessionProjection)
    && new Set(document.sessions.map(session => session.sessionId)).size === document.sessions.length
    && Array.isArray(document.notices)
    && document.notices.every(isStoredNotice)
    && new Set(document.notices.map(notice => notice.id)).size === document.notices.length
    && Array.isArray(document.controls)
    && document.controls.every(isStoredControl)
    && new Set(document.controls.map(control => control.id)).size === document.controls.length;
}

function isStoredControl(value: unknown): value is StoredControl {
  if (!value || typeof value !== "object") return false;
  const control = value as Record<string, unknown>;
  return typeof control.id === "string"
    && typeof control.requestId === "string"
    && (control.actor === "user" || control.actor === "model")
    && typeof control.parentSessionId === "string"
    && Number.isSafeInteger(control.generation)
    && typeof control.workspace === "string"
    && typeof control.runId === "string"
    && ["pending", "applied", "rejected"].includes(String(control.status));
}

function controlId(sessionId: string, generation: number, actor: "user" | "model"): string {
  const digest = createHash("sha256")
    .update(sessionId)
    .update("\0")
    .update(String(generation))
    .update("\0")
    .update(actor)
    .digest("hex");
  return `acpus-control:${digest}`;
}

function replaceSession(
  sessions: readonly StoredSessionProjection[],
  session: StoredSessionProjection,
): StoredSessionProjection[] {
  return sessions.some(candidate => candidate.sessionId === session.sessionId)
    ? sessions.map(candidate => candidate.sessionId === session.sessionId ? session : candidate)
    : [...sessions, session];
}

function replaceProjection(
  projections: readonly StoredRunProjection[],
  projection: StoredRunProjection,
): StoredRunProjection[] {
  return projections.some(candidate => candidate.runId === projection.runId)
    ? projections.map(candidate => candidate.runId === projection.runId ? projection : candidate)
    : [...projections, projection];
}

function withoutUnavailable(projection: StoredRunProjection): StoredRunProjection {
  const { unavailable: _unavailable, ...available } = projection;
  return available;
}

function sameValue(left: unknown, right: unknown): boolean {
  return left !== undefined && JSON.stringify(left) === JSON.stringify(right);
}
