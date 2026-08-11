import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { JsonValue } from "@acpus/expression/ir";
import { sha256Digest } from "../content-digest.js";
import { tryCreateDeadline } from "../deadline.js";
import { stableJson, stableJsonLine } from "../stable-json.js";
import { planCancelControl, planRetryControl, settleRetryControlSnapshot, validateRetryControlRun } from "../scheduler/control-plan.js";
import { signalTimeoutEvents } from "../scheduler/deadline-events.js";
import { decodeSchedulerPayload, isSchedulerEventType } from "../scheduler/event-codec.js";
import type { SchedulerEvent } from "../scheduler/events.js";
import { ancestorGroupMembersForNode } from "../scheduler/membership.js";
import { resolveOccurrenceRef } from "../scheduler/occurrence-ref.js";
import { settleFrozenProjection, type FrozenSchedulerRun } from "../scheduler/settle.js";
import { planSteerControl } from "../scheduler/steer-plan.js";
import {
  SchedulerStoreException,
  schedulerStoreResult,
  throwSchedulerStoreResult,
  type AttemptCommitInput,
  type AttemptStartInput,
  type AttemptStartResult,
  type ReplayCandidate,
  type ReplayCommitInput,
  type ReplayCommitResult,
  type RunOwnerClaim,
  type SchedulerCancelInput,
  type SchedulerCommit,
  type SchedulerPauseInput,
  type SchedulerRecoveryInput,
  type SchedulerResumeInput,
  type SchedulerRetryInput,
  type SchedulerRunRetryInput,
  type SchedulerSnapshot,
  type SchedulerSteerInput,
  type SchedulerSteerResult,
  type SchedulerStoreError,
  type SchedulerStorePort,
  type SchedulerStoreResult,
  type SignalConsumeInput,
} from "../scheduler/store-port.js";
import { applySchedulerEvents, createSchedulerProjection, type SchedulerProjectionTimings } from "../scheduler/transitions.js";
import type { SchedulerProjection, SchedulerRunStatus } from "../scheduler/types.js";
import { readContainedFileSync } from "./contained-path.js";
import { isContainedPath } from "../path-containment.js";
import type { ForkReplayArtifact } from "./replay-model.js";

type CountRow = { count: number };
export class SqliteSchedulerStorePort implements SchedulerStorePort {
  private readonly snapshotCache = new Map<string, SchedulerSnapshot>();

  constructor(
    private readonly db: DatabaseSync,
    private readonly resolveRunDirectory: (runId: string) => string,
    private readonly readFrozenRun: (runId: string) => FrozenSchedulerRun,
  ) {}

  claimRun(runId: string, ownerId: string, leaseMs: number): RunOwnerClaim | undefined {
    const now = new Date().toISOString();
    const leaseExpiresAt = new Date(Date.now() + leaseMs).toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const run = this.db.prepare("SELECT id FROM runs WHERE id = ?").get(runId);
      if (!run) throw new Error(`Run '${runId}' was not found.`);
      const current = this.db.prepare("SELECT owner_epoch, lease_expires_at, released_at FROM run_leases WHERE run_id = ?").get(runId) as { owner_epoch: number; lease_expires_at: string; released_at: string | null } | undefined;
      if (current && current.released_at === null && current.lease_expires_at > now) {
        this.db.exec("ROLLBACK");
        return undefined;
      }
      const ownerEpoch = (current?.owner_epoch ?? 0) + 1;
      this.db.prepare(`
        INSERT INTO run_leases (run_id, owner_id, owner_epoch, lease_expires_at, claimed_at, released_at)
        VALUES (?, ?, ?, ?, ?, NULL)
        ON CONFLICT(run_id) DO UPDATE SET
          owner_id = excluded.owner_id,
          owner_epoch = excluded.owner_epoch,
          lease_expires_at = excluded.lease_expires_at,
          claimed_at = excluded.claimed_at,
          released_at = NULL
      `).run(runId, ownerId, ownerEpoch, leaseExpiresAt, now);
      this.db.exec("COMMIT");
      return { runId, ownerId, ownerEpoch, leaseExpiresAt };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  heartbeatRun(claim: RunOwnerClaim, leaseMs: number): boolean {
    const now = new Date().toISOString();
    const leaseExpiresAt = new Date(Date.now() + leaseMs).toISOString();
    const result = this.db.prepare(`
      UPDATE run_leases
      SET lease_expires_at = ?
      WHERE run_id = ? AND owner_id = ? AND owner_epoch = ? AND released_at IS NULL AND lease_expires_at > ?
    `).run(leaseExpiresAt, claim.runId, claim.ownerId, claim.ownerEpoch, now);
    return result.changes === 1;
  }

  releaseRun(claim: RunOwnerClaim): boolean {
    const now = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = this.db.prepare(`
        UPDATE run_leases
        SET released_at = ?
        WHERE run_id = ? AND owner_id = ? AND owner_epoch = ? AND released_at IS NULL
      `).run(now, claim.runId, claim.ownerId, claim.ownerEpoch);
      if (result.changes === 1) {
        const snapshot = this.loadRunSnapshot(claim.runId);
        this.maybePersistSchedulerCheckpoint(claim.runId, snapshot.version, snapshot.projection, now, true);
      }
      this.db.exec("COMMIT");
      return result.changes === 1;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  tryLoadRunSnapshot(runId: string): SchedulerStoreResult<SchedulerSnapshot> {
    return schedulerStoreResult(() => this.loadRunSnapshot(runId));
  }

  private loadRunSnapshot(runId: string): SchedulerSnapshot {
    const row = this.db.prepare("SELECT id FROM runs WHERE id = ?").get(runId);
    if (!row) throwSchedulerStoreError({ type: "run-not-found", runId, message: `Run '${runId}' was not found.` });
    const version = this.currentVersion(runId);
    const cached = this.snapshotCache.get(runId);
    if (cached?.version === version) return cached;
    const checkpoint = schedulerProjectionCheckpoint(this.db, runId);
    if (checkpoint && checkpoint.event_sequence > version) {
      throw new Error(`Run '${runId}' scheduler projection checkpoint sequence ${checkpoint.event_sequence} exceeds event sequence ${version}.`);
    }
    let projection: SchedulerProjection;
    let afterSequence: number;
    if (checkpoint) {
      projection = parseSchedulerProjection(checkpoint.projection_json, runId);
      afterSequence = checkpoint.event_sequence;
    } else {
      projection = createSchedulerProjection(runId);
      afterSequence = 0;
    }
    projection = applySchedulerEvents(projection, this.schedulerEventsAfter(runId, afterSequence));
    const snapshot = {
      runId,
      version,
      projection,
    };
    this.snapshotCache.set(runId, snapshot);
    return snapshot;
  }

  tryAppendSchedulerEvents(commit: SchedulerCommit): SchedulerStoreResult<SchedulerSnapshot> {
    return schedulerStoreResult(() => this.appendSchedulerEvents(commit));
  }

  private appendSchedulerEvents(
    commit: SchedulerCommit,
    eventsInTransaction?: (current: SchedulerSnapshot) => SchedulerEvent[],
  ): SchedulerSnapshot {
    const hasEvents = commit.events.length > 0;
    if (!hasEvents && commit.intentDigest === undefined) return this.loadRunSnapshot(commit.runId);
    const duplicate = this.duplicateAppendIdempotency(commit);
    if (duplicate) return duplicate;
    const now = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const currentVersion = this.currentVersion(commit.runId);
      if (currentVersion !== commit.expectedVersion) {
        throwSchedulerStoreError({
          type: "version-mismatch",
          runId: commit.runId,
          expectedVersion: commit.expectedVersion,
          actualVersion: currentVersion,
          message: `Run '${commit.runId}' scheduler version mismatch.`,
        });
      }
      this.requireOwnerEpoch(commit.runId, commit.ownerEpoch);
      const current = this.loadRunSnapshot(commit.runId);
      const events = eventsInTransaction?.(current) ?? commit.events;
      this.db.prepare(`
        INSERT INTO scheduler_commits (run_id, idempotency_key, event_count, event_digest, intent_digest)
        VALUES (?, ?, ?, ?, ?)
      `).run(commit.runId, commit.idempotencyKey, events.length, schedulerEventDigest(events), commit.intentDigest ?? null);
      const snapshot = this.commitProjectionEventsInTransaction({
        runId: commit.runId,
        current,
        events,
        now,
        idempotencyKeys: events.map((_, index) => schedulerEventIdempotencyKey(commit.runId, commit.idempotencyKey, index)),
      });
      this.db.exec("COMMIT");
      this.snapshotCache.set(commit.runId, snapshot);
      return snapshot;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  tryStartAttempt(input: AttemptStartInput): SchedulerStoreResult<AttemptStartResult> {
    return schedulerStoreResult(() => this.startAttempt(input));
  }

  listReplayCandidates(runId: string): ReplayCandidate[] {
    return (this.db.prepare(`
      SELECT node_key, source_sequence, session_group_digest
      FROM fork_replay_facts
      WHERE run_id = ?
      ORDER BY source_sequence, node_key
    `).all(runId) as Array<Record<string, string | null>>).map(row => ({
      nodeKey: String(row.node_key),
      sourceSequence: Number(row.source_sequence),
      ...(row.session_group_digest === null ? {} : { sessionGroupDigest: String(row.session_group_digest) }),
    }));
  }

  tryCommitReplay(input: ReplayCommitInput): SchedulerStoreResult<ReplayCommitResult> {
    return schedulerStoreResult(() => this.commitReplay(input));
  }

  private commitReplay(input: ReplayCommitInput): ReplayCommitResult {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const currentVersion = this.currentVersion(input.runId);
      if (currentVersion !== input.expectedVersion) {
        throwSchedulerStoreError({
          type: "version-mismatch",
          runId: input.runId,
          expectedVersion: input.expectedVersion,
          actualVersion: currentVersion,
          message: `Run '${input.runId}' scheduler version mismatch.`,
        });
      }
      this.requireOwnerEpoch(input.runId, input.ownerEpoch);
      const current = this.loadRunSnapshot(input.runId);
      if (current.projection.run.status === "paused") {
        throwSchedulerStoreError({ type: "run-paused", runId: input.runId, message: `Run '${input.runId}' is paused.` });
      }
      const instance = current.projection.instances[input.nodeKey];
      if (!instance || instance.status !== "ready") {
        throwSchedulerStoreError({
          type: "instance-not-ready",
          runId: input.runId,
          nodeKey: input.nodeKey,
          status: instance?.status ?? "missing",
          message: `Node instance '${input.nodeKey}' is not ready.`,
        });
      }
      const fact = this.db.prepare(`
        SELECT source_run_id, operation_digest, input_digest, session_group_digest, output_json, artifacts_json
        FROM fork_replay_facts
        WHERE run_id = ? AND node_key = ?
      `).get(input.runId, input.nodeKey) as Record<string, string | null> | undefined;
      const factGroupDigest = fact?.session_group_digest === null || fact?.session_group_digest === undefined
        ? undefined
        : String(fact.session_group_digest);
      const identity = input.replayIdentity;
      if (!fact
        || !identity
        || fact.operation_digest !== identity.operationDigest
        || fact.input_digest !== identity.inputDigest
        || factGroupDigest !== identity.sessionGroupDigest
        || (input.expectedSessionGroupDigest !== undefined && input.expectedSessionGroupDigest !== factGroupDigest)) {
        const invalidated = this.invalidateUnstartedReplaySessionGroups(
          input.runId,
          [factGroupDigest, input.expectedSessionGroupDigest, identity?.sessionGroupDigest],
          `mismatched at member '${input.nodeKey}'`,
        );
        if (factGroupDigest !== undefined && !invalidated.groupDigests.includes(factGroupDigest)) {
          throw new Error(`Fork replay fact '${input.nodeKey}' references missing session group '${factGroupDigest}'.`);
        }
        this.db.prepare("DELETE FROM fork_replay_facts WHERE run_id = ? AND node_key = ?").run(input.runId, input.nodeKey);
        const invalidatedNodeKeys = [...new Set([...invalidated.nodeKeys, input.nodeKey])];
        this.db.exec("COMMIT");
        return { disposition: "mismatch", snapshot: current, invalidatedNodeKeys };
      }
      if (factGroupDigest !== undefined) {
        const next = this.db.prepare(`
          SELECT node_key
          FROM fork_replay_facts
          WHERE run_id = ? AND session_group_digest = ?
          ORDER BY source_sequence, node_key
          LIMIT 1
        `).get(input.runId, factGroupDigest) as { node_key: string } | undefined;
        if (!next) throw new Error(`Fork replay session group '${factGroupDigest}' has no remaining member.`);
        if (String(next.node_key) !== input.nodeKey) {
          const invalidated = this.invalidateUnstartedReplaySessionGroups(
            input.runId,
            [factGroupDigest],
            `replayed member '${input.nodeKey}' out of source order`,
          );
          if (!invalidated.groupDigests.includes(factGroupDigest)) {
            throw new Error(`Fork replay fact '${input.nodeKey}' references missing session group '${factGroupDigest}'.`);
          }
          this.db.exec("COMMIT");
          return { disposition: "mismatch", snapshot: current, invalidatedNodeKeys: invalidated.nodeKeys };
        }
      }
      const output = fact.output_json === null ? undefined : JSON.parse(String(fact.output_json)) as JsonValue;
      const artifacts = JSON.parse(String(fact.artifacts_json)) as ForkReplayArtifact[];
      this.activateReplayArtifacts(input.runId, artifacts);
      if (factGroupDigest !== undefined) {
        const incremented = this.db.prepare(`
          UPDATE fork_replay_session_groups
          SET replayed_count = replayed_count + 1
          WHERE run_id = ? AND session_group_digest = ? AND replayed_count < member_count
        `).run(input.runId, factGroupDigest);
        if (incremented.changes !== 1) {
          throw new Error(`Fork replay session group '${factGroupDigest}' cannot accept member '${input.nodeKey}'.`);
        }
      }
      const events: SchedulerEvent[] = [{
        type: "instance.completed",
        payload: {
          nodeKey: input.nodeKey,
          ...(output === undefined ? {} : { output }),
          replayIdentity: identity,
          reusedFrom: { runId: String(fact.source_run_id), nodeKey: input.nodeKey },
        },
      }];
      const member = current.projection.groupMembers[input.nodeKey];
      if (member?.status === "ready" || member?.status === "running") {
        events.push({
          type: "group.member_completed",
          payload: {
            memberKey: member.memberKey,
            completionSequence: current.version + events.length + 1,
            ...(output === undefined ? {} : { output }),
          },
        });
      }
      const commitKey = `fork-replay:${input.runId}:${input.nodeKey}`;
      const snapshot = this.commitProjectionEventsInTransaction({
        runId: input.runId,
        current,
        events,
        now: new Date().toISOString(),
        idempotencyKeys: events.map((_, index) => schedulerEventIdempotencyKey(input.runId, commitKey, index)),
        nodeKeys: events.map(() => input.nodeKey),
      });
      this.db.prepare("DELETE FROM fork_replay_facts WHERE run_id = ? AND node_key = ?").run(input.runId, input.nodeKey);
      this.db.exec("COMMIT");
      this.snapshotCache.set(input.runId, snapshot);
      return { disposition: "replayed", snapshot };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private activateReplayArtifacts(runId: string, artifacts: ForkReplayArtifact[]): void {
    const runDir = this.resolveRunDirectory(runId);
    const artifactRoot = resolve(runDir, "artifacts");
    for (const artifact of artifacts) {
      const path = resolve(runDir, artifact.relativePath);
      if (path === artifactRoot || !isContainedPath(artifactRoot, path)) {
        throw new Error(`Fork replay artifact '${artifact.id}' has invalid relative path.`);
      }
      const bytes = readContainedFileSync(runDir, artifact.relativePath);
      if (bytes.byteLength !== artifact.size || sha256Digest(bytes) !== artifact.digest) {
        throw new Error(`Fork replay artifact '${artifact.id}' failed activation verification.`);
      }
      this.db.prepare(`
        INSERT OR IGNORE INTO artifacts (id, run_id, node_key, attempt, media_type, digest, size, relative_path, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        artifact.id,
        runId,
        artifact.nodeKey ?? null,
        artifact.attempt,
        artifact.mediaType ?? null,
        artifact.digest,
        artifact.size,
        artifact.relativePath,
        new Date().toISOString(),
      );
    }
  }

  private invalidateUnstartedReplaySessionGroups(
    runId: string,
    digests: readonly (string | undefined)[],
    reason: string,
  ): { nodeKeys: string[]; groupDigests: string[] } {
    const groupDigests: string[] = [];
    for (const sessionGroupDigest of new Set(digests.filter((value): value is string => value !== undefined))) {
      const group = this.db.prepare(`
        SELECT replayed_count
        FROM fork_replay_session_groups
        WHERE run_id = ? AND session_group_digest = ?
      `).get(runId, sessionGroupDigest) as { replayed_count: number } | undefined;
      if (!group) continue;
      if (Number(group.replayed_count) > 0) {
        throw new Error(
          `Fork replay session group '${sessionGroupDigest}' ${reason} after ${Number(group.replayed_count)} member(s) were reused.`,
        );
      }
      groupDigests.push(sessionGroupDigest);
    }
    const nodeKeys = groupDigests.flatMap(sessionGroupDigest => (this.db.prepare(`
      SELECT node_key
      FROM fork_replay_facts
      WHERE run_id = ? AND session_group_digest = ?
      ORDER BY source_sequence, node_key
    `).all(runId, sessionGroupDigest) as Array<{ node_key: string }>).map(row => String(row.node_key)));
    for (const sessionGroupDigest of groupDigests) {
      this.db.prepare("DELETE FROM fork_replay_facts WHERE run_id = ? AND session_group_digest = ?").run(runId, sessionGroupDigest);
      this.db.prepare("DELETE FROM fork_replay_session_groups WHERE run_id = ? AND session_group_digest = ?").run(runId, sessionGroupDigest);
    }
    return { nodeKeys: [...new Set(nodeKeys)], groupDigests };
  }

  private startAttempt(input: AttemptStartInput): AttemptStartResult {
    const now = new Date().toISOString();
    const attemptId = `attempt_${randomUUID()}`;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.eventByIdempotencyKey(input.idempotencyKey);
      if (existing && existing.type === "attempt.started") {
        const payload = existing.payload as { attemptId?: unknown; attemptNo?: unknown; steerId?: unknown };
        if (existing.run_id !== input.runId) throwSchedulerStoreError({ type: "idempotency-conflict", idempotencyKey: input.idempotencyKey, runId: input.runId, message: `Attempt start idempotency key '${input.idempotencyKey}' conflicts with another run.` });
        if (!matchesAttemptStartInput(input, payload)) throwSchedulerStoreError({ type: "idempotency-conflict", idempotencyKey: input.idempotencyKey, runId: input.runId, message: `Attempt start idempotency key '${input.idempotencyKey}' conflicts with different input.` });
        this.requireOwnerEpoch(input.runId, input.ownerEpoch);
        if (typeof payload.attemptId !== "string" || typeof payload.attemptNo !== "number") {
          throw new Error(`Attempt start idempotency key '${input.idempotencyKey}' has invalid payload.`);
        }
        if (payload.steerId !== undefined && typeof payload.steerId !== "string") {
          throw new Error(`Attempt start idempotency key '${input.idempotencyKey}' has invalid steer metadata.`);
        }
        const steer = payload.steerId === undefined
          ? undefined
          : this.requireSteerDirective(input.runId, payload.steerId, input.nodeKey);
        const replay = {
          attemptId: payload.attemptId,
          attemptNo: payload.attemptNo,
          snapshot: this.loadRunSnapshot(input.runId),
          disposition: "existing" as const,
          ...(steer === undefined ? {} : { steer: { steerId: steer.steerId, instruction: steer.instruction } }),
        };
        this.db.exec("COMMIT");
        return replay;
      }
      if (existing) throwSchedulerStoreError({ type: "idempotency-conflict", idempotencyKey: input.idempotencyKey, runId: input.runId, message: `Attempt start idempotency key '${input.idempotencyKey}' conflicts with ${existing.type}.` });
      const currentVersion = this.currentVersion(input.runId);
      if (currentVersion !== input.expectedVersion) {
        throwSchedulerStoreError({
          type: "version-mismatch",
          runId: input.runId,
          expectedVersion: input.expectedVersion,
          actualVersion: currentVersion,
          message: `Run '${input.runId}' scheduler version mismatch.`,
        });
      }
      this.requireOwnerEpoch(input.runId, input.ownerEpoch);
      const current = this.loadRunSnapshot(input.runId);
      if (current.projection.run.status === "paused") throwSchedulerStoreError({ type: "run-paused", runId: input.runId, message: `Run '${input.runId}' is paused.` });
      const instance = current.projection.instances[input.nodeKey];
      if (!instance || instance.status !== "ready" || instance.nodeId !== input.nodeId) {
        throwSchedulerStoreError({
          type: "instance-not-ready",
          runId: input.runId,
          nodeKey: input.nodeKey,
          status: instance?.status ?? "missing",
          message: `Node instance '${input.nodeKey}' is not ready.`,
        });
      }
      const blockedMember = ancestorGroupMembersForNode(current.projection, input.nodeKey)
        .find(member => member.status !== "ready" && member.status !== "running");
      if (blockedMember) {
        throwSchedulerStoreError({
          type: "instance-not-ready",
          runId: input.runId,
          nodeKey: input.nodeKey,
          status: `member_${blockedMember.status}`,
          message: `Node instance '${input.nodeKey}' has ${blockedMember.status} ancestor member '${blockedMember.memberKey}'.`,
        });
      }
      if (input.sessionGroupDigest !== undefined
        && input.replayIdentity?.sessionGroupDigest !== undefined
        && input.sessionGroupDigest !== input.replayIdentity.sessionGroupDigest) {
        throw new Error(`Node instance '${input.nodeKey}' resolved inconsistent fork replay session groups.`);
      }
      const sessionGroupDigest = input.sessionGroupDigest ?? input.replayIdentity?.sessionGroupDigest;
      const invalidatedSessionGroupDigest = sessionGroupDigest === undefined
        ? undefined
        : this.invalidateUnstartedReplaySessionGroups(
          input.runId,
          [sessionGroupDigest],
          `attempted to execute member '${input.nodeKey}'`,
        ).groupDigests[0];
      const row = this.db.prepare("SELECT COALESCE(MAX(attempt_no), 0) + 1 AS count FROM node_attempts WHERE run_id = ? AND node_key = ?").get(input.runId, input.nodeKey) as CountRow | undefined;
      const attemptNo = row?.count ?? 1;
      const steer = instance.pendingSteerId === undefined
        ? undefined
        : this.requireSteerDirective(input.runId, instance.pendingSteerId, input.nodeKey);
      const payload = {
        runId: input.runId,
        attemptId,
        nodeKey: input.nodeKey,
        nodeId: input.nodeId,
        attemptNo,
        ownerEpoch: input.ownerEpoch,
        admissionVersion: input.expectedVersion,
        ...(steer === undefined ? {} : { steerId: steer.steerId }),
        ...(input.deadlineAt === undefined ? {} : { deadlineAt: input.deadlineAt }),
        ...(input.replayIdentity === undefined ? {} : { replayIdentity: input.replayIdentity }),
      };
      const instanceStartedEvent: SchedulerEvent = { type: "instance.started", payload: { nodeKey: input.nodeKey, attemptId, ...(input.replayIdentity === undefined ? {} : { replayIdentity: input.replayIdentity }) } };
      const attemptStartedEvent: SchedulerEvent = { type: "attempt.started", payload };
      const memberStartedEvents = this.groupMemberStartedEventsForNode(input.runId, input.nodeKey, current.projection);
      const events = [instanceStartedEvent, ...memberStartedEvents, attemptStartedEvent];
      const clearedProgress = this.db.prepare("DELETE FROM node_progress WHERE run_id = ? AND node_key = ?").run(input.runId, input.nodeKey);
      if (clearedProgress.changes > 0) {
        this.db.prepare(`
          UPDATE runs
          SET progress_version = progress_version + 1, progress_updated_at = ?
          WHERE id = ?
        `).run(now, input.runId);
      }
      const snapshot = this.commitProjectionEventsInTransaction({
        runId: input.runId,
        current,
        events,
        now,
        idempotencyKeys: [
          derivedIdempotencyKey(input.idempotencyKey, "instance"),
          ...memberStartedEvents.map((_, index) => derivedIdempotencyKey(input.idempotencyKey, index === 0 ? "member" : `member:${index}`)),
          input.idempotencyKey,
        ],
        nodeKeys: events.map(() => input.nodeKey),
      });
      this.db.exec("COMMIT");
      this.snapshotCache.set(input.runId, snapshot);
      return {
        attemptId,
        attemptNo,
        snapshot,
        disposition: "started",
        ...(invalidatedSessionGroupDigest === undefined ? {} : { invalidatedSessionGroupDigest }),
        ...(steer === undefined ? {} : { steer: { steerId: steer.steerId, instruction: steer.instruction } }),
      };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  tryCommitAttemptResult(input: AttemptCommitInput): SchedulerStoreResult<SchedulerSnapshot> {
    return schedulerStoreResult(() => this.commitAttemptResult(input));
  }

  private commitAttemptResult(input: AttemptCommitInput): SchedulerSnapshot {
    const now = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.eventByIdempotencyKey(input.idempotencyKey);
      if (existing) {
        if (existing.run_id !== input.runId) throwSchedulerStoreError({ type: "idempotency-conflict", idempotencyKey: input.idempotencyKey, runId: input.runId, message: `Attempt commit idempotency key '${input.idempotencyKey}' conflicts with another run.` });
        const attempt = this.db.prepare("SELECT node_key, owner_epoch FROM node_attempts WHERE run_id = ? AND attempt_id = ?").get(input.runId, input.attemptId) as { node_key: string; owner_epoch: number } | undefined;
        if (!attempt) throwSchedulerStoreError({ type: "attempt-not-found", attemptId: input.attemptId, message: `Attempt '${input.attemptId}' was not found.` });
        if (attempt.owner_epoch !== input.ownerEpoch) throwSchedulerStoreError({ type: "owner-epoch-stale", runId: input.runId, attemptId: input.attemptId, ownerEpoch: input.ownerEpoch, message: `Attempt '${input.attemptId}' owner epoch is stale.` });
        this.requireOwnerEpoch(input.runId, input.ownerEpoch);
        const event = attemptResultEvent(input, attempt.node_key);
        if (existing.type !== event.type || stableJsonLine(existing.payload) !== stableJsonLine(event.payload)) {
          throwSchedulerStoreError({ type: "idempotency-conflict", idempotencyKey: input.idempotencyKey, runId: input.runId, message: `Attempt commit idempotency key '${input.idempotencyKey}' conflicts with different input.` });
        }
        const replay = this.loadRunSnapshot(input.runId);
        this.db.exec("COMMIT");
        return replay;
      }
      const attempt = this.db.prepare("SELECT run_id, node_key, owner_epoch, status FROM node_attempts WHERE attempt_id = ?").get(input.attemptId) as { run_id: string; node_key: string; owner_epoch: number; status: string } | undefined;
      if (!attempt || attempt.run_id !== input.runId) throwSchedulerStoreError({ type: "attempt-not-found", attemptId: input.attemptId, message: `Attempt '${input.attemptId}' was not found.` });
      if (attempt.owner_epoch !== input.ownerEpoch) throwSchedulerStoreError({ type: "owner-epoch-stale", runId: input.runId, attemptId: input.attemptId, ownerEpoch: input.ownerEpoch, message: `Attempt '${input.attemptId}' owner epoch is stale.` });
      this.requireOwnerEpoch(input.runId, input.ownerEpoch);
      if (attempt.status !== "started") throwSchedulerStoreError({ type: "terminal-attempt", attemptId: input.attemptId, status: attempt.status, message: `Attempt '${input.attemptId}' is already ${attempt.status}.` });
      const current = this.loadRunSnapshot(input.runId);
      const event = attemptResultEvent(input, String(attempt.node_key));
      const nodeKey = String(attempt.node_key);
      const instanceEvent = instanceResultEvent(input, nodeKey, event, current.projection.instances[nodeKey]?.replayIdentity);
      const memberEvent = this.groupMemberResultEventForNode(input.runId, nodeKey, input.result, current.projection);
      const events = [event, instanceEvent, ...(memberEvent ? [memberEvent] : [])];
      const snapshot = this.commitProjectionEventsInTransaction({
        runId: input.runId,
        current,
        events,
        now,
        idempotencyKeys: [input.idempotencyKey, derivedIdempotencyKey(input.idempotencyKey, "instance"), ...(memberEvent ? [derivedIdempotencyKey(input.idempotencyKey, "member")] : [])],
        nodeKeys: events.map(() => nodeKey),
      });
      this.db.exec("COMMIT");
      this.snapshotCache.set(input.runId, snapshot);
      return snapshot;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  tryConsumeSignal(input: SignalConsumeInput): SchedulerStoreResult<SchedulerSnapshot> {
    return schedulerStoreResult(() => this.consumeSignal(input));
  }

  private consumeSignal(input: SignalConsumeInput): SchedulerSnapshot {
    const intentDigest = schedulerIntentDigest({
      type: "signal",
      requestedTarget: input.requestedTarget ?? input.nodeKey,
      nodeKey: input.nodeKey,
      payload: input.payload,
      commandIdempotencyKey: input.commandIdempotencyKey,
    });
    const duplicate = this.duplicateIntentIdempotency(input.runId, input.idempotencyKey, intentDigest);
    if (duplicate) return duplicate;
    const now = input.now ?? new Date();
    let snapshot = this.loadRunSnapshot(input.runId);
    const validateOccurrenceTarget = (current: SchedulerSnapshot): void => {
      if (!input.requestedTarget?.startsWith("@")) return;
      const occurrence = resolveOccurrenceRef(
        current.projection,
        input.requestedTarget,
        { attempt: "reject" },
      );
      const resolvedNodeKey = occurrence?.ok && occurrence.value.kind === "node"
        ? occurrence.value.nodeKey
        : undefined;
      if (resolvedNodeKey !== input.nodeKey) {
        const detail = occurrence && !occurrence.ok
          && occurrence.error.type === "occurrence-ref-collision"
          ? ` Candidate keys: ${occurrence.error.candidateKeys.join(", ")}.`
          : "";
        throwSchedulerStoreError({
          type: "signal-wait-not-found",
          runId: input.runId,
          nodeKey: input.nodeKey,
          message: `Signal occurrence target '${input.requestedTarget}' no longer resolves to wait '${input.nodeKey}'.${detail}`,
        });
      }
    };
    validateOccurrenceTarget(snapshot);
    let wait = snapshot.projection.signalWaits[input.nodeKey];
    if (!wait) throwSchedulerStoreError({ type: "signal-wait-not-found", runId: input.runId, nodeKey: input.nodeKey, message: `Signal wait '${input.nodeKey}' was not found.` });
    if (wait.status === "consumed" && wait.payload !== undefined && stableJsonLine(wait.payload) === stableJsonLine(input.payload)) {
      if (wait.commandIdempotencyKey !== input.commandIdempotencyKey) {
        throwSchedulerStoreError({ type: "signal-wait-terminal", runId: input.runId, nodeKey: input.nodeKey, status: wait.status, message: `Signal wait '${input.nodeKey}' was already consumed by a different command.` });
      }
      return this.appendSchedulerEvents(
        {
          runId: input.runId,
          expectedVersion: snapshot.version,
          ownerEpoch: input.ownerEpoch,
          idempotencyKey: input.idempotencyKey,
          intentDigest,
          events: [],
        },
        input.requestedTarget?.startsWith("@")
          ? current => {
              validateOccurrenceTarget(current);
              return [];
            }
          : undefined,
      );
    }
    if (wait.status === "consumed") {
      throwSchedulerStoreError({ type: "signal-wait-terminal", runId: input.runId, nodeKey: input.nodeKey, status: wait.status, message: `Signal wait '${input.nodeKey}' has already consumed a different payload.` });
    }
    if (wait.status !== "awaiting") {
      throwSchedulerStoreError({ type: "signal-wait-terminal", runId: input.runId, nodeKey: input.nodeKey, status: wait.status, message: `Signal wait '${input.nodeKey}' is already ${wait.status}.` });
    }
    snapshot = this.drainDueSignalTimeouts(input.runId, input.ownerEpoch, now);
    wait = snapshot.projection.signalWaits[input.nodeKey];
    if (!wait) throwSchedulerStoreError({ type: "signal-wait-not-found", runId: input.runId, nodeKey: input.nodeKey, message: `Signal wait '${input.nodeKey}' was not found.` });
    if (wait.status !== "awaiting") {
      throwSchedulerStoreError({ type: "signal-wait-terminal", runId: input.runId, nodeKey: input.nodeKey, status: wait.status, message: `Signal wait '${input.nodeKey}' is already ${wait.status}.` });
    }
    if (snapshot.projection.run.status === "paused") throwSchedulerStoreError({ type: "run-paused", runId: input.runId, message: `Run '${input.runId}' is paused.` });
    const events: SchedulerEvent[] = [
      {
        type: "signal.consumed",
        payload: {
          nodeKey: input.nodeKey,
          payload: input.payload,
          commandIdempotencyKey: input.commandIdempotencyKey,
        },
      },
      {
        type: "instance.completed",
        payload: {
          nodeKey: input.nodeKey,
          output: input.payload,
          ...(snapshot.projection.instances[input.nodeKey]?.replayIdentity === undefined
            ? {}
            : { replayIdentity: snapshot.projection.instances[input.nodeKey]!.replayIdentity }),
        },
      },
    ];
    const member = snapshot.projection.groupMembers[input.nodeKey];
    if (member?.status === "ready" || member?.status === "running") {
      events.push({
        type: "group.member_completed",
        payload: {
          memberKey: member.memberKey,
          completionSequence: snapshot.version + events.length + 1,
          output: input.payload,
        },
      });
    }
    return this.appendSchedulerEvents(
      {
        runId: input.runId,
        expectedVersion: snapshot.version,
        ownerEpoch: input.ownerEpoch,
        idempotencyKey: input.idempotencyKey,
        intentDigest,
        events,
      },
      input.requestedTarget?.startsWith("@")
        ? current => {
            validateOccurrenceTarget(current);
            return events;
          }
        : undefined,
    );
  }

  tryPauseRun(input: SchedulerPauseInput): SchedulerStoreResult<SchedulerSnapshot> {
    return schedulerStoreResult(() => this.pauseRun(input));
  }

  private pauseRun(input: SchedulerPauseInput): SchedulerSnapshot {
    const intentDigest = schedulerIntentDigest({ type: "pause" });
    const duplicate = this.duplicateIntentIdempotency(input.runId, input.idempotencyKey, intentDigest);
    if (duplicate) return duplicate;
    const now = input.now ?? new Date();
    const snapshot = this.drainDueSignalTimeouts(input.runId, input.ownerEpoch, now);
    if (snapshot.projection.run.status === "paused") {
      return this.appendSchedulerEvents({
        runId: input.runId,
        expectedVersion: snapshot.version,
        ownerEpoch: input.ownerEpoch,
        idempotencyKey: input.idempotencyKey,
        intentDigest,
        events: [],
      });
    }
    const events: SchedulerEvent[] = [
      { type: "control.paused", payload: {} },
    ];
    for (const wait of Object.values(snapshot.projection.signalWaits)) {
      const deadlineAt = wait.deadlineAt;
      if (wait.status !== "awaiting" || deadlineAt === undefined) continue;
      events.push({
        type: "signal.timeout_paused",
        payload: {
          nodeKey: wait.nodeKey,
          remainingMs: Math.max(0, new Date(deadlineAt).getTime() - now.getTime()),
        },
      });
    }
    for (const attempt of Object.values(snapshot.projection.attempts).filter(attempt => attempt.status === "started")) {
      const instance = snapshot.projection.instances[attempt.nodeKey];
      events.push({ type: "attempt.cancelled", payload: { attemptId: attempt.attemptId, cancelReason: "paused" } });
      if (instance?.status === "running" || instance?.status === "awaiting") {
        events.push({
          type: "instance.requeued",
          payload: {
            nodeKey: instance.nodeKey,
            reason: attempt.steerId === undefined ? "paused" : "steered",
            ...(attempt.steerId === undefined ? {} : { steerId: attempt.steerId }),
            ...(instance.readinessSequence === undefined ? {} : { readinessSequence: instance.readinessSequence }),
          },
        });
      }
    }
    return this.appendSchedulerEvents({
      runId: input.runId,
      expectedVersion: snapshot.version,
      ownerEpoch: input.ownerEpoch,
      idempotencyKey: input.idempotencyKey,
      intentDigest,
      events,
    });
  }

  tryResumeRun(input: SchedulerResumeInput): SchedulerStoreResult<SchedulerSnapshot> {
    return schedulerStoreResult(() => this.resumeRun(input));
  }

  private resumeRun(input: SchedulerResumeInput): SchedulerSnapshot {
    const intentDigest = schedulerIntentDigest({ type: "resume" });
    const duplicate = this.duplicateIntentIdempotency(input.runId, input.idempotencyKey, intentDigest);
    if (duplicate) return duplicate;
    const now = input.now ?? new Date();
    const snapshot = this.loadRunSnapshot(input.runId);
    if (snapshot.projection.run.status !== "paused") {
      return this.appendSchedulerEvents({
        runId: input.runId,
        expectedVersion: snapshot.version,
        ownerEpoch: input.ownerEpoch,
        idempotencyKey: input.idempotencyKey,
        intentDigest,
        events: [],
      });
    }
    const events: SchedulerEvent[] = [{ type: "control.resumed", payload: {} }];
    for (const wait of Object.values(snapshot.projection.signalWaits)) {
      const timeoutRemainingMs = wait.timeoutRemainingMs;
      if (wait.status !== "awaiting" || timeoutRemainingMs === undefined) continue;
      const deadline = tryCreateDeadline(now, timeoutRemainingMs);
      if (deadline.isErr()) {
        throwSchedulerStoreError({
          type: "deadline-out-of-range",
          runId: input.runId,
          nodeKey: wait.nodeKey,
          message: `Signal wait '${wait.nodeKey}' remaining timeout cannot be represented as a persisted deadline.`,
        });
      }
      events.push({
        type: "signal.timeout_resumed",
        payload: {
          nodeKey: wait.nodeKey,
          deadlineAt: deadline.value.toISOString(),
        },
      });
    }
    return this.appendSchedulerEvents({
      runId: input.runId,
      expectedVersion: snapshot.version,
      ownerEpoch: input.ownerEpoch,
      idempotencyKey: input.idempotencyKey,
      intentDigest,
      events,
    });
  }

  tryRetryRun(input: SchedulerRunRetryInput): SchedulerStoreResult<SchedulerSnapshot> {
    return schedulerStoreResult(() => this.retryRun(input));
  }

  private retryRun(input: SchedulerRunRetryInput): SchedulerSnapshot {
    const intentDigest = schedulerIntentDigest({ type: "run_retry" });
    const duplicate = this.duplicateIntentIdempotency(input.runId, input.idempotencyKey, intentDigest);
    if (duplicate) return duplicate;
    const snapshot = this.loadRunSnapshot(input.runId);
    if (snapshot.projection.run.status !== "failed") {
      throwSchedulerStoreError({ type: "invalid-retry-target", runId: input.runId, status: snapshot.projection.run.status, message: `Cannot retry run from ${snapshot.projection.run.status}.` });
    }
    return this.appendSchedulerEvents({
      runId: input.runId,
      expectedVersion: snapshot.version,
      ownerEpoch: input.ownerEpoch,
      idempotencyKey: input.idempotencyKey,
      intentDigest,
      events: [{ type: "control.run_retry_requested", payload: {} }],
    });
  }

  tryRetry(input: SchedulerRetryInput): SchedulerStoreResult<SchedulerSnapshot> {
    return schedulerStoreResult(() => this.retry(input));
  }

  private retry(input: SchedulerRetryInput): SchedulerSnapshot {
    const idempotencyKey = input.idempotencyKey;
    const intentDigest = schedulerIntentDigest({ type: "retry", target: input.target });
    const duplicate = this.duplicateIntentIdempotency(input.runId, idempotencyKey, intentDigest);
    if (duplicate) return duplicate;
    const frozen = this.loadFrozenRun(input.runId);
    const now = new Date();
    const retryEvents = (snapshot: SchedulerSnapshot): SchedulerEvent[] => {
      validateRetryControlRun(snapshot, input.target).match(
        () => undefined,
        failure => throwSchedulerStoreError(failure),
      );
      const settled = settleRetryControlSnapshot({
        frozen,
        snapshot,
        now,
      });
      const plan = planRetryControl(settled.snapshot, input.target).match(
        value => value,
        failure => throwSchedulerStoreError(failure),
      );
      return [...settled.events, ...plan.events];
    };
    const current = this.loadRunSnapshot(input.runId);
    const events = retryEvents(current);
    return this.appendSchedulerEvents(
      {
        runId: input.runId,
        expectedVersion: current.version,
        ownerEpoch: input.ownerEpoch,
        idempotencyKey,
        intentDigest,
        events,
      },
      input.target.startsWith("@") ? retryEvents : undefined,
    );
  }

  tryCancel(input: SchedulerCancelInput): SchedulerStoreResult<SchedulerSnapshot> {
    return schedulerStoreResult(() => this.cancel(input));
  }

  private cancel(input: SchedulerCancelInput): SchedulerSnapshot {
    const intentDigest = schedulerIntentDigest({ type: "cancel", target: input.target ?? null });
    const duplicate = this.duplicateIntentIdempotency(input.runId, input.idempotencyKey, intentDigest);
    if (duplicate) return duplicate;
    const cancelEvents = (snapshot: SchedulerSnapshot): SchedulerEvent[] => planCancelControl(snapshot, input.target).match(
      value => value.events,
      failure => throwSchedulerStoreError(failure),
    );
    const snapshot = this.loadRunSnapshot(input.runId);
    const events = cancelEvents(snapshot);
    return this.appendSchedulerEvents(
      {
        runId: input.runId,
        expectedVersion: snapshot.version,
        ownerEpoch: input.ownerEpoch,
        idempotencyKey: input.idempotencyKey,
        intentDigest,
        events,
      },
      input.target?.startsWith("@") ? cancelEvents : undefined,
    );
  }

  trySteerAgent(input: SchedulerSteerInput): SchedulerStoreResult<SchedulerSteerResult> {
    return schedulerStoreResult(() => this.steerAgent(input));
  }

  private steerAgent(input: SchedulerSteerInput): SchedulerSteerResult {
    if (input.instruction.trim().length === 0) {
      throwSchedulerStoreError({
        type: "invalid-steer-instruction",
        runId: input.runId,
        message: "Agent steer instruction must contain non-whitespace text.",
      });
    }
    const intentDigest = schedulerIntentDigest({
      type: "steer",
      steerId: input.steerId,
      target: input.target,
      instruction: input.instruction,
    });
    const now = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const duplicate = this.duplicateIntentIdempotency(input.runId, input.idempotencyKey, intentDigest);
      if (duplicate) {
        const directive = this.requireSteerDirective(input.runId, input.steerId);
        const result = {
          snapshot: duplicate,
          steerId: directive.steerId,
          requestedTarget: directive.requestedTarget,
          target: directive.nodeKey,
          fencedAttemptId: directive.fencedAttemptId,
          fenceEventSequence: directive.eventSequence,
          fencedAt: directive.createdAt,
        };
        this.db.exec("COMMIT");
        return result;
      }

      this.requireOwnerEpoch(input.runId, input.ownerEpoch);
      const current = this.loadRunSnapshot(input.runId);
      const frozen = this.loadFrozenRun(input.runId);
      const attempt = throwSchedulerStoreResult(planSteerControl(frozen, current, input.target)).target;

      const events: SchedulerEvent[] = [
        {
          type: "control.agent_steer_requested",
          payload: {
            steerId: input.steerId,
            requestedTarget: input.target,
            nodeKey: attempt.nodeKey,
            fencedAttemptId: attempt.attemptId,
            instruction: input.instruction,
          },
        },
        {
          type: "attempt.superseded",
          payload: {
            attemptId: attempt.attemptId,
            cancelReason: "operator_steered",
          },
        },
        {
          type: "instance.requeued",
          payload: {
            nodeKey: attempt.nodeKey,
            reason: "steered",
            steerId: input.steerId,
            ...(current.projection.instances[attempt.nodeKey]?.readinessSequence === undefined
              ? {}
              : { readinessSequence: current.projection.instances[attempt.nodeKey]!.readinessSequence }),
          },
        },
      ];
      this.db.prepare(`
        INSERT INTO scheduler_commits (run_id, idempotency_key, event_count, event_digest, intent_digest)
        VALUES (?, ?, ?, ?, ?)
      `).run(input.runId, input.idempotencyKey, events.length, schedulerEventDigest(events), intentDigest);
      const snapshot = this.commitProjectionEventsInTransaction({
        runId: input.runId,
        current,
        events,
        now,
        idempotencyKeys: events.map((_, index) => schedulerEventIdempotencyKey(input.runId, input.idempotencyKey, index)),
        nodeKeys: events.map(() => attempt.nodeKey),
      });
      this.db.exec("COMMIT");
      this.snapshotCache.set(input.runId, snapshot);
      return {
        snapshot,
        steerId: input.steerId,
        requestedTarget: input.target,
        target: attempt.nodeKey,
        fencedAttemptId: attempt.attemptId,
        fenceEventSequence: current.version + 1,
        fencedAt: now,
      };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  tryMarkExpiredOwnerAttemptsSuperseded(input: SchedulerRecoveryInput): SchedulerStoreResult<SchedulerSnapshot> {
    return schedulerStoreResult(() => this.markExpiredOwnerAttemptsSuperseded(input));
  }

  private markExpiredOwnerAttemptsSuperseded(input: SchedulerRecoveryInput): SchedulerSnapshot {
    const now = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const currentVersion = this.currentVersion(input.runId);
      if (currentVersion !== input.expectedVersion) {
        throwSchedulerStoreError({
          type: "version-mismatch",
          runId: input.runId,
          expectedVersion: input.expectedVersion,
          actualVersion: currentVersion,
          message: `Run '${input.runId}' scheduler version mismatch.`,
        });
      }
      this.requireOwnerEpoch(input.runId, input.currentOwnerEpoch);
      this.assertOwnerEpochExpired(input.runId, input.expiredOwnerEpoch);
      const attempts = this.db.prepare("SELECT attempt_id, node_key FROM node_attempts WHERE run_id = ? AND owner_epoch = ? AND status = 'started'").all(input.runId, input.expiredOwnerEpoch) as Array<{ attempt_id: string; node_key: string }>;
      const current = this.loadRunSnapshot(input.runId);
      let projection = current.projection;
      const recoveryEvents: SchedulerEvent[] = [];
      const idempotencyKeys: string[] = [];
      const nodeKeys: string[] = [];
      for (const attempt of attempts) {
        const instance = projection.instances[attempt.node_key];
        const projectedAttempt = projection.attempts[attempt.attempt_id];
        const steerId = projectedAttempt?.steerId;
        const events: SchedulerEvent[] = [
          { type: "attempt.superseded", payload: { attemptId: attempt.attempt_id, cancelReason: "superseded" } },
          ...(instance && (instance.status === "running" || instance.status === "awaiting")
            ? [{
              type: "instance.requeued",
              payload: {
                nodeKey: instance.nodeKey,
                reason: steerId === undefined ? "superseded" : "steered",
                ...(steerId === undefined ? {} : { steerId }),
                ...(instance.readinessSequence === undefined ? {} : { readinessSequence: instance.readinessSequence }),
              },
            } satisfies SchedulerEvent]
            : []),
        ];
        projection = applySchedulerEvents(projection, events);
        for (const [index, event] of events.entries()) {
          recoveryEvents.push(event);
          idempotencyKeys.push(`supersede:${input.runId}:${attempt.attempt_id}:${index}`);
          nodeKeys.push(eventNodeKey(event) ?? attempt.node_key);
        }
      }
      const snapshot = this.commitProjectionEventsInTransaction({ runId: input.runId, current, events: recoveryEvents, now, idempotencyKeys, nodeKeys });
      this.db.exec("COMMIT");
      this.snapshotCache.set(input.runId, snapshot);
      return snapshot;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private schedulerEventsAfter(runId: string, sequence: number): SchedulerEvent[] {
    return schedulerEventsAfter(this.db, runId, sequence);
  }

  private commitProjectionEventsInTransaction(input: {
    runId: string;
    current: SchedulerSnapshot;
    events: SchedulerEvent[];
    now: string;
    idempotencyKeys: string[];
    nodeKeys?: Array<string | null>;
  }): SchedulerSnapshot {
    if (input.events.length !== input.idempotencyKeys.length || (input.nodeKeys && input.events.length !== input.nodeKeys.length)) {
      throw new Error(`Run '${input.runId}' scheduler projection commit metadata does not match its event count.`);
    }
    const projection = applySchedulerEvents(input.current.projection, input.events);
    if (projection.run.status === "completed") {
      const partial = this.db.prepare(`
        SELECT session_group_digest, replayed_count, member_count
        FROM fork_replay_session_groups
        WHERE run_id = ? AND replayed_count > 0 AND replayed_count < member_count
        ORDER BY session_group_digest
        LIMIT 1
      `).get(input.runId) as { session_group_digest: string; replayed_count: number; member_count: number } | undefined;
      if (partial) {
        throw new Error(
          `Run '${input.runId}' cannot complete after reusing ${Number(partial.replayed_count)} of `
          + `${Number(partial.member_count)} members in fork replay session group '${String(partial.session_group_digest)}'.`,
        );
      }
    }
    let sequence = input.current.version + 1;
    const insert = this.db.prepare(`
      INSERT INTO run_events (run_id, sequence, type, node_key, payload_json, created_at, idempotency_key)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    for (const [index, event] of input.events.entries()) {
      insert.run(
        input.runId,
        sequence,
        event.type,
        input.nodeKeys?.[index] ?? eventNodeKey(event) ?? projectionEventNodeKey(projection, event),
        encodeSchedulerPayload(event.payload),
        input.now,
        input.idempotencyKeys[index]!,
      );
      sequence += 1;
    }
    if (input.events.length > 0) {
      this.syncSchedulerProjectionTables(input.runId, input.now, input.current.projection, projection);
      this.syncPublicRunProjection(input.runId, input.now, input.current.projection, projection);
      if (projection.run.status === "completed" || projection.run.status === "canceled") {
        this.db.prepare("DELETE FROM fork_replay_facts WHERE run_id = ?").run(input.runId);
        this.db.prepare("DELETE FROM fork_replay_session_groups WHERE run_id = ?").run(input.runId);
      }
    }
    const version = this.currentVersion(input.runId);
    this.maybePersistSchedulerCheckpoint(input.runId, version, projection, input.now);
    return { runId: input.runId, version, projection };
  }

  private currentVersion(runId: string): number {
    return this.nextSequence(runId) - 1;
  }

  private nextSequence(runId: string): number {
    const row = this.db.prepare("SELECT COALESCE(MAX(sequence), 0) + 1 AS count FROM run_events WHERE run_id = ?").get(runId) as CountRow | undefined;
    return row?.count ?? 1;
  }

  private requireOwnerEpoch(runId: string, ownerEpoch: number): void {
    requireActiveOwnerEpoch(this.db, runId, ownerEpoch);
  }

  private drainDueSignalTimeouts(runId: string, ownerEpoch: number, now: Date): SchedulerSnapshot {
    const snapshot = throwSchedulerStoreResult(this.tryLoadRunSnapshot(runId));
    const events = signalTimeoutEvents(snapshot.projection, now);
    if (events.length === 0) return snapshot;
    const frozen = this.loadFrozenRun(runId);
    const settled = settleFrozenProjection({ frozen, projection: snapshot.projection, initialEvents: events, now });
    return throwSchedulerStoreResult(this.tryAppendSchedulerEvents({
      runId,
      ownerEpoch,
      expectedVersion: snapshot.version,
      idempotencyKey: `scheduler:signal-timeouts:${runId}:${snapshot.version}`,
      events: settled.events,
    }));
  }

  private loadFrozenRun(runId: string): FrozenSchedulerRun {
    return this.readFrozenRun(runId);
  }

  private assertOwnerEpochExpired(runId: string, ownerEpoch: number): void {
    const row = this.db.prepare("SELECT owner_epoch, lease_expires_at, released_at FROM run_leases WHERE run_id = ?").get(runId) as { owner_epoch: number; lease_expires_at: string; released_at: string | null } | undefined;
    const now = new Date().toISOString();
    if (row && row.owner_epoch === ownerEpoch && row.released_at === null && row.lease_expires_at > now) {
      throwSchedulerStoreError({ type: "owner-epoch-still-active", runId, ownerEpoch, message: `Run '${runId}' scheduler owner epoch ${ownerEpoch} is still active.` });
    }
  }

  private eventByIdempotencyKey(idempotencyKey: string): { run_id: string; type: string; payload: Record<string, unknown> } | undefined {
    const row = this.db.prepare("SELECT run_id, type, payload_json FROM run_events WHERE idempotency_key = ?").get(idempotencyKey) as { run_id: string; type: string; payload_json: string } | undefined;
    if (!row) return undefined;
    if (!isSchedulerEventType(row.type)) {
      throwSchedulerStoreError({ type: "idempotency-conflict", idempotencyKey, runId: row.run_id, message: `Scheduler idempotency key '${idempotencyKey}' conflicts with non-scheduler event.` });
    }
    return { run_id: row.run_id, type: row.type, payload: decodeSchedulerPayload(row.payload_json, row.type) };
  }

  private requireSteerDirective(runId: string, steerId: string, nodeKey?: string): SteerDirective {
    const rows = this.db.prepare(`
      SELECT sequence, payload_json, created_at
      FROM run_events
      WHERE run_id = ? AND type = 'control.agent_steer_requested'
      ORDER BY sequence
    `).all(runId) as Array<{ sequence: number; payload_json: string; created_at: string }>;
    const matches = rows
      .map(row => ({
        ...decodeSteerDirective(row.payload_json),
        eventSequence: row.sequence,
        createdAt: row.created_at,
      }))
      .filter(directive => directive.steerId === steerId);
    if (matches.length !== 1) {
      throw new Error(`Run '${runId}' steer directive '${steerId}' does not resolve to exactly one durable control event.`);
    }
    const directive = matches[0]!;
    if (nodeKey !== undefined && directive.nodeKey !== nodeKey) {
      throw new Error(`Run '${runId}' steer directive '${steerId}' targets '${directive.nodeKey}', not '${nodeKey}'.`);
    }
    return directive;
  }

  private groupMemberStartedEventsForNode(_runId: string, nodeKey: string, projection: SchedulerProjection): Array<Extract<SchedulerEvent, { type: "group.member_started" }>> {
    return ancestorGroupMembersForNode(projection, nodeKey)
      .filter(member => member.status === "ready")
      .map(member => ({ type: "group.member_started", payload: { memberKey: member.memberKey } }));
  }

  private groupMemberResultEventForNode(runId: string, nodeKey: string, result: AttemptCommitInput["result"], projection: SchedulerProjection): Extract<SchedulerEvent, { type: "group.member_completed" | "group.member_failed" | "group.member_cancelled" }> | undefined {
    const member = projection.groupMembers[nodeKey];
    if (!member || member.status !== "running") return undefined;
    if (result.status === "completed") {
      return { type: "group.member_completed", payload: { memberKey: member.memberKey, completionSequence: this.nextSequence(runId), ...(result.output === undefined ? {} : { output: result.output }) } };
    }
    if (result.status === "cancelled") return { type: "group.member_cancelled", payload: { memberKey: member.memberKey, cancelReason: result.reason } };
    return { type: "group.member_failed", payload: { memberKey: member.memberKey, error: result.error ?? { reason: result.reason }, terminalReason: result.status === "timed_out" ? "timed_out" : result.reason } };
  }

  private duplicateAppendIdempotency(commit: SchedulerCommit): SchedulerSnapshot | undefined {
    const row = this.db.prepare(`
      SELECT event_count, event_digest, intent_digest
      FROM scheduler_commits
      WHERE run_id = ? AND idempotency_key = ?
    `).get(commit.runId, commit.idempotencyKey) as { event_count: number; event_digest: string; intent_digest: string | null } | undefined;
    if (!row) return undefined;
    if (row.event_count !== commit.events.length
      || row.event_digest !== schedulerEventDigest(commit.events)
      || (row.intent_digest ?? undefined) !== commit.intentDigest) {
      throwSchedulerStoreError({ type: "idempotency-conflict", idempotencyKey: commit.idempotencyKey, runId: commit.runId, message: `Scheduler commit idempotency key '${commit.idempotencyKey}' conflicts with different events.` });
    }
    return this.loadRunSnapshot(commit.runId);
  }

  private duplicateIntentIdempotency(runId: string, idempotencyKey: string, intentDigest: string): SchedulerSnapshot | undefined {
    const row = this.db.prepare(`
      SELECT intent_digest
      FROM scheduler_commits
      WHERE run_id = ? AND idempotency_key = ?
    `).get(runId, idempotencyKey) as { intent_digest: string | null } | undefined;
    if (!row) return undefined;
    if (row.intent_digest !== intentDigest) {
      throwSchedulerStoreError({ type: "idempotency-conflict", idempotencyKey, runId, message: `Scheduler intent idempotency key '${idempotencyKey}' conflicts with a different control.` });
    }
    return this.loadRunSnapshot(runId);
  }

  private syncSchedulerProjectionTables(runId: string, now: string, before: SchedulerProjection, projection: SchedulerProjection): void {
    const delta = schedulerProjectionDelta(before, projection);
    const timings = incrementalProjectionTimings(this.db, runId, now, before, projection, delta);
    const frameKeys = delta.frame.upserts;
    const instanceKeys = delta.instance.upserts;
    const attemptKeys = delta.attempt.upserts;
    const memberKeys = delta.member.upserts;
    const signalKeys = delta.signal.upserts;
    const existingSignalWaits = new Map((this.db.prepare("SELECT node_key, consumed_at, created_at FROM signal_waits WHERE run_id = ?").all(runId) as Array<{ node_key: string; consumed_at: string | null; created_at: string }>)
      .map(row => [row.node_key, row]));
    deleteProjectionRows(this.db, "scheduler_frames", "frame_key", runId, delta.frame.deletes);
    deleteProjectionRows(this.db, "node_instances", "node_key", runId, delta.instance.deletes);
    deleteProjectionRows(this.db, "node_attempts", "attempt_id", runId, delta.attempt.deletes);
    deleteProjectionRows(this.db, "group_members", "member_key", runId, delta.member.deletes);
    deleteProjectionRows(this.db, "signal_waits", "node_key", runId, delta.signal.deletes);

    for (const frameKey of frameKeys) {
      const frame = projection.frames[frameKey]!;
      const timing = timings.frame.get(frame.frameKey);
      this.db.prepare(`
        INSERT INTO scheduler_frames (
          run_id, frame_key, parent_frame_key, node_key, node_id, frame_kind, status, strategy,
          terminal_reason, instance_path_json, scope_json, loop_json, result_json, error_json, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(run_id, frame_key) DO UPDATE SET
          parent_frame_key = excluded.parent_frame_key,
          node_key = excluded.node_key,
          node_id = excluded.node_id,
          frame_kind = excluded.frame_kind,
          status = excluded.status,
          strategy = excluded.strategy,
          terminal_reason = excluded.terminal_reason,
          instance_path_json = excluded.instance_path_json,
          scope_json = excluded.scope_json,
          loop_json = excluded.loop_json,
          result_json = excluded.result_json,
          error_json = excluded.error_json,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at
      `).run(
        frame.runId,
        frame.frameKey,
        frame.parentFrameKey ?? null,
        frame.nodeKey ?? null,
        frame.nodeId ?? null,
        frame.frameKind,
        frame.status,
        frame.strategy ?? null,
        frame.terminalReason ?? null,
        frame.instancePath === undefined ? null : stableJsonLine(frame.instancePath as unknown as JsonValue),
        stableJsonLine(frame.scope),
        frame.loop === undefined ? null : stableJsonLine(frame.loop),
        frame.result === undefined ? null : stableJsonLine(frame.result),
        frame.error === undefined ? null : stableJsonLine(frame.error),
        timing?.createdAt ?? now,
        timing?.updatedAt ?? now,
      );
    }

    for (const instanceKey of instanceKeys) {
      const instance = projection.instances[instanceKey]!;
      const timing = timings.instance.get(instance.nodeKey);
      this.db.prepare(`
        INSERT INTO node_instances (
          run_id, node_key, node_id, parent_frame_key, instance_path_json, status, status_reason,
          readiness_sequence, output_json, error_json, accepted_attempt_id,
          reused_from_run_id, reused_from_node_key,
          created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(run_id, node_key) DO UPDATE SET
          node_id = excluded.node_id,
          parent_frame_key = excluded.parent_frame_key,
          instance_path_json = excluded.instance_path_json,
          status = excluded.status,
          status_reason = excluded.status_reason,
          readiness_sequence = excluded.readiness_sequence,
          output_json = excluded.output_json,
          error_json = excluded.error_json,
          accepted_attempt_id = excluded.accepted_attempt_id,
          reused_from_run_id = excluded.reused_from_run_id,
          reused_from_node_key = excluded.reused_from_node_key,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at
      `).run(
        instance.runId,
        instance.nodeKey,
        instance.nodeId,
        instance.parentFrameKey ?? null,
        stableJsonLine(instance.instancePath as unknown as JsonValue),
        instance.status,
        instance.statusReason ?? null,
        instance.readinessSequence ?? null,
        instance.output === undefined ? null : stableJsonLine(instance.output),
        instance.error === undefined ? null : stableJsonLine(instance.error),
        instance.acceptedAttemptId ?? null,
        instance.reusedFrom?.runId ?? null,
        instance.reusedFrom?.nodeKey ?? null,
        timing?.createdAt ?? now,
        timing?.updatedAt ?? now,
      );
    }

    for (const attemptKey of attemptKeys) {
      const attempt = projection.attempts[attemptKey]!;
      const timing = timings.attempt.get(attempt.attemptId);
      this.db.prepare(`
        INSERT INTO node_attempts (
          run_id, attempt_id, node_key, node_id, attempt_no, owner_epoch, status, deadline_at,
          started_at, finished_at, result_json, error_json, terminal_reason, cancel_reason
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(attempt_id) DO UPDATE SET
          run_id = excluded.run_id,
          node_key = excluded.node_key,
          node_id = excluded.node_id,
          attempt_no = excluded.attempt_no,
          owner_epoch = excluded.owner_epoch,
          status = excluded.status,
          deadline_at = excluded.deadline_at,
          started_at = excluded.started_at,
          finished_at = excluded.finished_at,
          result_json = excluded.result_json,
          error_json = excluded.error_json,
          terminal_reason = excluded.terminal_reason,
          cancel_reason = excluded.cancel_reason
      `).run(
        attempt.runId,
        attempt.attemptId,
        attempt.nodeKey,
        attempt.nodeId,
        attempt.attemptNo,
        attempt.ownerEpoch,
        attempt.status,
        attempt.deadlineAt ?? null,
        timing?.createdAt ?? now,
        attempt.status === "started" ? null : timing?.updatedAt ?? now,
        attempt.result === undefined ? null : stableJsonLine(attempt.result),
        attempt.error === undefined ? null : stableJsonLine(attempt.error),
        attempt.terminalReason ?? null,
        attempt.cancelReason ?? null,
      );
    }

    for (const memberKey of memberKeys) {
      const member = projection.groupMembers[memberKey]!;
      const timing = timings.member.get(member.memberKey);
      const branchId = member.memberKind === "branch" ? member.branchId : null;
      const itemIndex = member.memberKind === "fanout_item" ? member.itemIndex : null;
      const itemJson = member.memberKind === "fanout_item" ? stableJsonLine(member.item) : null;
      this.db.prepare(`
        INSERT INTO group_members (
          run_id, group_key, member_key, member_kind, branch_id, item_index, item_json, child_frame_key,
          status, readiness_sequence, completion_sequence, accepted_rank, terminal_reason, output_json, error_json, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(run_id, member_key) DO UPDATE SET
          group_key = excluded.group_key,
          member_kind = excluded.member_kind,
          branch_id = excluded.branch_id,
          item_index = excluded.item_index,
          item_json = excluded.item_json,
          child_frame_key = excluded.child_frame_key,
          status = excluded.status,
          readiness_sequence = excluded.readiness_sequence,
          completion_sequence = excluded.completion_sequence,
          accepted_rank = excluded.accepted_rank,
          terminal_reason = excluded.terminal_reason,
          output_json = excluded.output_json,
          error_json = excluded.error_json,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at
      `).run(
        member.runId,
        member.groupKey,
        member.memberKey,
        member.memberKind,
        branchId,
        itemIndex,
        itemJson,
        member.childFrameKey ?? null,
        member.status,
        member.readinessSequence,
        member.completionSequence ?? null,
        member.acceptedRank ?? null,
        member.terminalReason ?? null,
        member.output === undefined ? null : stableJsonLine(member.output),
        member.error === undefined ? null : stableJsonLine(member.error),
        timing?.createdAt ?? now,
        timing?.updatedAt ?? now,
      );
    }

    for (const signalKey of signalKeys) {
      const wait = projection.signalWaits[signalKey]!;
      const existing = existingSignalWaits.get(wait.nodeKey);
      const timing = timings.signal.get(wait.nodeKey);
      this.db.prepare(`
        INSERT INTO signal_waits (
          run_id, node_key, node_id, status, payload_json,
          deadline_at, timeout_message, timeout_remaining_ms, rendered_prompt, consumed_at, terminal_reason, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(run_id, node_key) DO UPDATE SET
          node_id = excluded.node_id,
          status = excluded.status,
          payload_json = excluded.payload_json,
          deadline_at = excluded.deadline_at,
          timeout_message = excluded.timeout_message,
          timeout_remaining_ms = excluded.timeout_remaining_ms,
          rendered_prompt = excluded.rendered_prompt,
          consumed_at = excluded.consumed_at,
          terminal_reason = excluded.terminal_reason,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at
      `).run(
        wait.runId,
        wait.nodeKey,
        wait.nodeId,
        wait.status,
        wait.payload === undefined ? null : stableJsonLine(wait.payload),
        wait.deadlineAt ?? null,
        wait.timeoutMessage ?? null,
        wait.timeoutRemainingMs ?? null,
        wait.renderedPrompt ?? null,
        wait.status === "consumed" ? timing?.updatedAt ?? existing?.consumed_at ?? now : null,
        wait.terminalReason ?? null,
        timing?.createdAt ?? existing?.created_at ?? now,
        timing?.updatedAt ?? now,
      );
    }
  }

  private syncPublicRunProjection(runId: string, now: string, before: SchedulerProjection, projection: SchedulerProjection): void {
    const current = this.db.prepare("SELECT status FROM runs WHERE id = ?").get(runId) as { status: SchedulerRunStatus } | undefined;
    const hasTargetedRetry = Boolean(this.db.prepare("SELECT 1 FROM run_events WHERE run_id = ? AND type IN ('instance.retry_requested', 'frame.retry_requested') LIMIT 1").get(runId));
    if (current?.status === "failed" && projection.run.status === "pending" && Object.keys(projection.frames).length === 0) {
      this.db.prepare("UPDATE runs SET status = 'pending', updated_at = ? WHERE id = ?").run(now, runId);
      this.db.prepare("UPDATE run_inputs SET output_json = NULL WHERE run_id = ?").run(runId);
      this.db.prepare("DELETE FROM node_states WHERE run_id = ?").run(runId);
      return;
    }
    if (!current || current.status === "completed" || current.status === "canceled" || (current.status === "failed" && !hasTargetedRetry)) return;
    this.syncPublicNodeStates(before, projection);
    const root = projection.frames.root;
    if (projection.run.status === "completed") {
      const output = root?.result ?? {};
      this.db.prepare("UPDATE runs SET status = 'completed', updated_at = ? WHERE id = ?").run(now, runId);
      this.db.prepare("UPDATE run_inputs SET output_json = ? WHERE run_id = ?").run(stableJsonLine(output), runId);
      this.insertPublicRunEvent(runId, "run.completed", { output }, now, `scheduler-public:completed:${runId}:${this.rootTerminalEventCount(runId, "frame.completed")}`);
      return;
    }
    if (projection.run.status === "failed") {
      const error = root?.error ?? { reason: root?.terminalReason ?? "scheduler_failed" };
      this.db.prepare("UPDATE runs SET status = 'failed', updated_at = ? WHERE id = ?").run(now, runId);
      this.db.prepare("UPDATE run_inputs SET output_json = NULL WHERE run_id = ?").run(runId);
      this.insertPublicRunEvent(runId, "run.failed", error, now, `scheduler-public:failed:${runId}:${this.rootTerminalEventCount(runId, "frame.failed")}`);
      return;
    }
    if (projection.run.status === "canceled") {
      this.db.prepare("UPDATE runs SET status = 'canceled', updated_at = ? WHERE id = ?").run(now, runId);
      this.db.prepare("UPDATE run_inputs SET output_json = NULL WHERE run_id = ?").run(runId);
      this.insertPublicRunEvent(runId, "run.canceled", { reason: root?.terminalReason ?? "operator_cancelled" }, now, `scheduler-public:canceled:${runId}:${this.rootTerminalEventCount(runId, "frame.cancelled")}`);
      return;
    }
    if (projection.run.status === "paused") {
      this.db.prepare("UPDATE runs SET status = 'paused', updated_at = ? WHERE id = ? AND status NOT IN ('completed', 'failed', 'canceled')").run(now, runId);
      return;
    }
    const status = publicRunStatus(projection);
    if (current.status === "failed") {
      this.db.prepare("UPDATE runs SET status = ?, updated_at = ? WHERE id = ?").run(status, now, runId);
      this.db.prepare("UPDATE run_inputs SET output_json = NULL WHERE run_id = ?").run(runId);
      return;
    }
    this.db.prepare("UPDATE runs SET status = ?, updated_at = ? WHERE id = ? AND status NOT IN ('completed', 'failed', 'canceled')").run(status, now, runId);
  }

  private syncPublicNodeStates(before: SchedulerProjection, projection: SchedulerProjection): void {
    const delta = recordDelta(before.instances, projection.instances);
    const changedInstances = delta.upserts.map(nodeKey => projection.instances[nodeKey]!);
    const dynamicNodeIds = [...new Set(changedInstances
      .filter(instance => instance.nodeKey !== instance.nodeId)
      .map(instance => instance.nodeId))];
    if (dynamicNodeIds.length > 0) {
      const placeholders = dynamicNodeIds.map(() => "?").join(", ");
      this.db.prepare(`DELETE FROM node_states WHERE run_id = ? AND node_key = node_id AND node_id IN (${placeholders})`).run(projection.run.runId, ...dynamicNodeIds);
    }
    if (delta.deletes.length > 0) {
      const placeholders = delta.deletes.map(() => "?").join(", ");
      this.db.prepare(`DELETE FROM node_states WHERE run_id = ? AND node_key IN (${placeholders})`).run(projection.run.runId, ...delta.deletes);
    }
    for (const instance of changedInstances) {
      this.db.prepare(`
        INSERT INTO node_states (run_id, node_key, node_id, status, output_json)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(run_id, node_key) DO UPDATE SET
          node_id = excluded.node_id,
          status = excluded.status,
          output_json = excluded.output_json
      `).run(
        instance.runId,
        instance.nodeKey,
        instance.nodeId,
        instance.status,
        instance.output === undefined ? null : stableJsonLine(instance.output),
      );
    }
  }

  private insertPublicRunEvent(runId: string, type: "run.completed" | "run.failed" | "run.canceled", payload: JsonValue, now: string, idempotencyKey: string): void {
    const existing = this.db.prepare("SELECT id FROM run_events WHERE idempotency_key = ?").get(idempotencyKey);
    if (existing) return;
    this.db.prepare(`
      INSERT INTO run_events (run_id, sequence, type, node_key, payload_json, created_at, idempotency_key)
      VALUES (?, ?, ?, NULL, ?, ?, ?)
    `).run(runId, this.nextSequence(runId), type, stableJsonLine(payload), now, idempotencyKey);
  }

  private rootTerminalEventCount(runId: string, type: "frame.completed" | "frame.failed" | "frame.cancelled"): number {
    const rows = this.db.prepare("SELECT payload_json FROM run_events WHERE run_id = ? AND type = ?").all(runId, type) as Array<{ payload_json: string }>;
    return rows.filter(row => decodeSchedulerPayload(row.payload_json, type).frameKey === "root").length;
  }

  private maybePersistSchedulerCheckpoint(runId: string, eventSequence: number, projection: SchedulerProjection, now: string, release = false): void {
    if (projection.run.status === "completed") {
      this.db.prepare("DELETE FROM scheduler_projection_checkpoints WHERE run_id = ?").run(runId);
      return;
    }
    const existing = this.db.prepare("SELECT event_sequence FROM scheduler_projection_checkpoints WHERE run_id = ?").get(runId) as { event_sequence: number } | undefined;
    if (existing?.event_sequence === eventSequence) return;
    const force = release || projection.run.status === "failed" || projection.run.status === "canceled" || projection.run.status === "paused";
    if (existing && !force && eventSequence - existing.event_sequence < 256) return;
    this.db.prepare(`
      INSERT INTO scheduler_projection_checkpoints (run_id, event_sequence, projection_json, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(run_id) DO UPDATE SET
        event_sequence = excluded.event_sequence,
        projection_json = excluded.projection_json,
        updated_at = excluded.updated_at
    `).run(runId, eventSequence, stableJsonLine(projection as unknown as JsonValue), now);
  }
}

function schedulerEventsAfter(db: DatabaseSync, runId: string, sequence: number): SchedulerEvent[] {
  const rows = db.prepare("SELECT type, payload_json FROM run_events WHERE run_id = ? AND sequence > ? ORDER BY sequence").all(runId, sequence) as Array<{ type: string; payload_json: string }>;
  return rows.flatMap(row => {
    if (!isSchedulerEventType(row.type)) return [];
    return [{ type: row.type, payload: decodeSchedulerPayload(row.payload_json, row.type) } as SchedulerEvent];
  });
}

function parseSchedulerProjection(json: string, runId: string): SchedulerProjection {
  let projection: Partial<SchedulerProjection>;
  try {
    projection = JSON.parse(json) as Partial<SchedulerProjection>;
  } catch (cause) {
    throw new Error(`Run '${runId}' scheduler projection checkpoint JSON is malformed.`, { cause });
  }
  if (projection.run?.runId !== runId
    || !projection.frames
    || !projection.instances
    || !projection.attempts
    || !projection.groups
    || !projection.groupMembers
    || !projection.signalWaits
    || !projection.branchDecisions) {
    throw new Error(`Run '${runId}' scheduler projection checkpoint is malformed.`);
  }
  return projection as SchedulerProjection;
}

function schedulerProjectionCheckpoint(db: DatabaseSync, runId: string): { event_sequence: number; projection_json: string } | undefined {
  return db.prepare(`
    SELECT event_sequence, projection_json
    FROM scheduler_projection_checkpoints
    WHERE run_id = ?
  `).get(runId) as { event_sequence: number; projection_json: string } | undefined;
}

type ProjectionEntityDelta = { upserts: string[]; deletes: string[] };
type SchedulerProjectionDelta = {
  frame: ProjectionEntityDelta;
  instance: ProjectionEntityDelta;
  attempt: ProjectionEntityDelta;
  member: ProjectionEntityDelta;
  signal: ProjectionEntityDelta;
};

function schedulerProjectionDelta(before: SchedulerProjection, after: SchedulerProjection): SchedulerProjectionDelta {
  return {
    frame: recordDelta(before.frames, after.frames),
    instance: recordDelta(before.instances, after.instances),
    attempt: recordDelta(before.attempts, after.attempts),
    member: recordDelta(before.groupMembers, after.groupMembers),
    signal: recordDelta(before.signalWaits, after.signalWaits),
  };
}

function recordDelta<T>(before: Record<string, T>, after: Record<string, T>): ProjectionEntityDelta {
  return {
    upserts: Object.keys(after).filter(key => before[key] !== after[key]),
    deletes: Object.keys(before).filter(key => !(key in after)),
  };
}

function incrementalProjectionTimings(
  db: DatabaseSync,
  runId: string,
  now: string,
  before: SchedulerProjection,
  after: SchedulerProjection,
  delta: SchedulerProjectionDelta,
): SchedulerProjectionTimings {
  const timings: SchedulerProjectionTimings = {
    frame: new Map(),
    instance: new Map(),
    attempt: new Map(),
    member: new Map(),
    signal: new Map(),
  };
  for (const key of delta.frame.upserts) timings.frame.set(key, changedTiming(db, "scheduler_frames", "frame_key", runId, key, now, before.frames[key]?.status, after.frames[key]!.status));
  for (const key of delta.instance.upserts) timings.instance.set(key, changedTiming(db, "node_instances", "node_key", runId, key, now, before.instances[key]?.status, after.instances[key]!.status));
  for (const key of delta.attempt.upserts) timings.attempt.set(key, changedAttemptTiming(db, runId, key, now, before.attempts[key]?.status, after.attempts[key]!.status));
  for (const key of delta.member.upserts) timings.member.set(key, changedTiming(db, "group_members", "member_key", runId, key, now, before.groupMembers[key]?.status, after.groupMembers[key]!.status));
  for (const key of delta.signal.upserts) timings.signal.set(key, changedTiming(db, "signal_waits", "node_key", runId, key, now, before.signalWaits[key]?.status, after.signalWaits[key]!.status));
  return timings;
}

function changedTiming(
  db: DatabaseSync,
  table: "scheduler_frames" | "node_instances" | "group_members" | "signal_waits",
  keyColumn: "frame_key" | "node_key" | "member_key",
  runId: string,
  key: string,
  now: string,
  beforeStatus: string | undefined,
  afterStatus: string,
): { createdAt: string; updatedAt: string } {
  const row = db.prepare(`SELECT created_at FROM ${table} WHERE run_id = ? AND ${keyColumn} = ?`).get(runId, key) as { created_at: string } | undefined;
  return {
    createdAt: row && !resetsProjectionLifecycle(beforeStatus, afterStatus) ? row.created_at : now,
    updatedAt: now,
  };
}

function changedAttemptTiming(
  db: DatabaseSync,
  runId: string,
  attemptId: string,
  now: string,
  beforeStatus: string | undefined,
  afterStatus: string,
): { createdAt: string; updatedAt: string } {
  const row = db.prepare("SELECT started_at FROM node_attempts WHERE run_id = ? AND attempt_id = ?").get(runId, attemptId) as { started_at: string } | undefined;
  return {
    createdAt: row && !resetsProjectionLifecycle(beforeStatus, afterStatus) ? row.started_at : now,
    updatedAt: now,
  };
}

function resetsProjectionLifecycle(before: string | undefined, after: string): boolean {
  return before !== undefined && terminalProjectionStatus(before) && !terminalProjectionStatus(after);
}

function terminalProjectionStatus(status: string): boolean {
  return status === "completed" || status === "failed" || status === "cancelled" || status === "canceled" || status === "timed_out" || status === "consumed" || status === "superseded";
}

function deleteProjectionRows(
  db: DatabaseSync,
  table: "scheduler_frames" | "node_instances" | "node_attempts" | "group_members" | "signal_waits",
  keyColumn: "frame_key" | "node_key" | "attempt_id" | "member_key",
  runId: string,
  keys: readonly string[],
): void {
  const statement = db.prepare(`DELETE FROM ${table} WHERE run_id = ? AND ${keyColumn} = ?`);
  for (const key of keys) statement.run(runId, key);
}

function publicRunStatus(projection: ReturnType<typeof createSchedulerProjection>): SchedulerRunStatus {
  if (projection.run.status === "awaiting" || hasAwaitingWork(projection)) return "awaiting";
  if (hasRunningWork(projection)) return "running";
  return "pending";
}

function hasAwaitingWork(projection: ReturnType<typeof createSchedulerProjection>): boolean {
  return Object.values(projection.instances).some(instance => instance.status === "awaiting")
    || Object.values(projection.frames).some(frame => frame.status === "awaiting")
    || Object.values(projection.signalWaits).some(wait => wait.status === "awaiting");
}

function hasRunningWork(projection: ReturnType<typeof createSchedulerProjection>): boolean {
  if (projection.frames.root !== undefined) return true;
  return Object.values(projection.frames).some(frame => frame.status === "ready" || frame.status === "running")
    || Object.values(projection.instances).some(instance => instance.status === "ready" || instance.status === "running")
    || Object.values(projection.groupMembers).some(member => member.status === "ready" || member.status === "running")
    || Object.values(projection.groups).some(group => group.status === "running")
    || Object.values(projection.attempts).some(attempt => attempt.status === "started");
}

function eventNodeKey(event: SchedulerEvent): string | null {
  const payload = event.payload as Record<string, unknown>;
  return typeof payload.nodeKey === "string" ? payload.nodeKey : null;
}

function projectionEventNodeKey(projection: SchedulerProjection, event: SchedulerEvent): string | null {
  const payload = event.payload as Record<string, unknown>;
  if (typeof payload.attemptId === "string") return projection.attempts[payload.attemptId]?.nodeKey ?? null;
  if (typeof payload.frameKey === "string") return projection.frames[payload.frameKey]?.nodeKey ?? null;
  if (typeof payload.groupKey === "string") return projection.groups[payload.groupKey]?.nodeKey ?? null;
  if (typeof payload.memberKey !== "string") return null;
  const member = projection.groupMembers[payload.memberKey];
  return member ? projection.groups[member.groupKey]?.nodeKey ?? null : null;
}

function attemptResultEvent(input: AttemptCommitInput, nodeKey: string): Extract<SchedulerEvent, { type: "attempt.completed" | "attempt.failed" | "attempt.timed_out" | "attempt.cancelled" }> {
  if (input.result.status === "completed") {
    return {
      type: "attempt.completed",
      payload: {
        attemptId: input.attemptId,
        ...(input.result.output === undefined ? {} : { result: input.result.output }),
      },
    };
  }
  if (input.result.status === "timed_out") {
    return { type: "attempt.timed_out", payload: { attemptId: input.attemptId, error: input.result.error ?? { reason: input.result.reason, nodeKey } } };
  }
  if (input.result.status === "cancelled") {
    return { type: "attempt.cancelled", payload: { attemptId: input.attemptId, cancelReason: input.result.reason } };
  }
  return { type: "attempt.failed", payload: { attemptId: input.attemptId, error: input.result.error ?? { reason: input.result.reason, nodeKey }, terminalReason: input.result.reason } };
}

function instanceResultEvent(
  input: AttemptCommitInput,
  nodeKey: string,
  attemptEvent: Extract<SchedulerEvent, { type: "attempt.completed" | "attempt.failed" | "attempt.timed_out" | "attempt.cancelled" }>,
  replayIdentity: SchedulerProjection["instances"][string]["replayIdentity"],
): Extract<SchedulerEvent, { type: "instance.completed" | "instance.failed" | "instance.cancelled" }> {
  if (attemptEvent.type === "attempt.completed") {
    return {
      type: "instance.completed",
      payload: {
        nodeKey,
        attemptId: input.attemptId,
        acceptedAttemptId: input.attemptId,
        ...(input.result.status === "completed" && input.result.output !== undefined ? { output: input.result.output } : {}),
        ...(replayIdentity === undefined ? {} : { replayIdentity }),
      },
    };
  }
  if (attemptEvent.type === "attempt.cancelled") {
    return { type: "instance.cancelled", payload: { nodeKey, cancelReason: attemptEvent.payload.cancelReason } };
  }
  const statusReason = attemptEvent.type === "attempt.timed_out" ? "timed_out" : attemptEvent.payload.terminalReason;
  return {
    type: "instance.failed",
    payload: {
      nodeKey,
      attemptId: input.attemptId,
      error: attemptEvent.payload.error ?? { reason: input.result.status === "failed" || input.result.status === "timed_out" ? input.result.reason : "attempt_failed" },
      ...(statusReason === undefined ? {} : { statusReason }),
    },
  };
}

function matchesAttemptStartInput(input: AttemptStartInput, payload: Record<string, unknown>): boolean {
  return payload.runId === input.runId
    && payload.nodeKey === input.nodeKey
    && payload.nodeId === input.nodeId
    && payload.ownerEpoch === input.ownerEpoch
    && payload.admissionVersion === input.expectedVersion
    && (payload.deadlineAt ?? undefined) === input.deadlineAt
    && stableJsonLine(payload.replayIdentity ?? null) === stableJsonLine(input.replayIdentity ?? null);
}

function encodeSchedulerPayload(payload: object): string {
  return stableJsonLine({ schedulerEventVersion: 1, payload });
}

function schedulerEventDigest(events: SchedulerEvent[]): string {
  return createHash("sha256").update(stableJsonLine(events as unknown as JsonValue)).digest("hex");
}

function schedulerIntentDigest(intent: JsonValue): string {
  return createHash("sha256").update(stableJson(intent)).digest("hex");
}

type SteerDirective = {
  steerId: string;
  requestedTarget: string;
  nodeKey: string;
  fencedAttemptId: string;
  instruction: string;
  eventSequence: number;
  createdAt: string;
};

function decodeSteerDirective(payloadJson: string): Omit<SteerDirective, "eventSequence" | "createdAt"> {
  const payload = decodeSchedulerPayload(payloadJson, "control.agent_steer_requested");
  if (typeof payload.steerId !== "string"
    || typeof payload.requestedTarget !== "string"
    || typeof payload.nodeKey !== "string"
    || typeof payload.fencedAttemptId !== "string"
    || typeof payload.instruction !== "string") {
    throw new Error("Scheduler steer control event has an invalid payload.");
  }
  return {
    steerId: payload.steerId,
    requestedTarget: payload.requestedTarget,
    nodeKey: payload.nodeKey,
    fencedAttemptId: payload.fencedAttemptId,
    instruction: payload.instruction,
  };
}

function schedulerEventIdempotencyKey(runId: string, commitKey: string, index: number): string {
  const digest = createHash("sha256").update(commitKey).digest("hex");
  return `scheduler-event:${runId}:${digest}:${index}`;
}

function derivedIdempotencyKey(idempotencyKey: string, suffix: string): string {
  return `${idempotencyKey}:${suffix}`;
}

export function throwSchedulerStoreError(error: SchedulerStoreError): never {
  throw new SchedulerStoreException(error);
}

export function requireActiveOwnerEpoch(db: DatabaseSync, runId: string, ownerEpoch: number): void {
  const row = db.prepare("SELECT owner_epoch, lease_expires_at, released_at FROM run_leases WHERE run_id = ?").get(runId) as { owner_epoch: number; lease_expires_at: string; released_at: string | null } | undefined;
  const now = new Date().toISOString();
  if (!row || row.owner_epoch !== ownerEpoch || row.released_at !== null || row.lease_expires_at <= now) {
    throwSchedulerStoreError({ type: "owner-epoch-inactive", runId, ownerEpoch, message: `Run '${runId}' scheduler owner epoch is not active.` });
  }
}
