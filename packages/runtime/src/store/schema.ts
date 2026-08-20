import type { DatabaseSync } from "node:sqlite";
import {
  assertRuntimeDatabaseFormat,
  rollbackDatabaseTransaction,
  RUNTIME_APPLICATION_ID,
  RUNTIME_STORAGE_VERSION,
  runtimeDatabaseFormat,
} from "../storage/database.js";

export function initializeRuntimeDatabase(db: DatabaseSync, path: string): void {
  const format = runtimeDatabaseFormat(db);
  const tables = db.prepare(`
    SELECT COUNT(*) AS count
    FROM sqlite_schema
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
  `).get() as { count: number };
  if (tables.count > 0) {
    assertRuntimeDatabaseFormat(format, path);
    db.exec("PRAGMA journal_mode = WAL;");
    initializeRuntimeSchema(db);
    return;
  }
  if (format.applicationId !== 0 || format.userVersion !== 0) {
    assertRuntimeDatabaseFormat(format, path);
  }
  db.exec("PRAGMA auto_vacuum = INCREMENTAL;");
  db.exec("PRAGMA journal_mode = WAL;");
  let transactionStarted = false;
  try {
    db.exec("BEGIN IMMEDIATE");
    transactionStarted = true;
    initializeRuntimeSchema(db);
    db.exec(`
      PRAGMA application_id = ${RUNTIME_APPLICATION_ID};
      PRAGMA user_version = ${RUNTIME_STORAGE_VERSION};
    `);
    db.exec("COMMIT");
    transactionStarted = false;
    db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
  } catch (error) {
    throw rollbackDatabaseTransaction(db, transactionStarted, error);
  }
}

export function validateRuntimeDatabase(db: DatabaseSync, path: string): void {
  assertRuntimeDatabaseFormat(runtimeDatabaseFormat(db), path);
}

export function initializeRuntimeSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS runtime_authority (
      workspace_realpath TEXT PRIMARY KEY,
      epoch INTEGER NOT NULL,
      owner_id TEXT,
      pid INTEGER,
      process_start_token TEXT,
      heartbeat_at TEXT,
      released_at TEXT,
      idle_since_at TEXT,
      idle_stop_ms INTEGER,
      protocol_version INTEGER,
      package_version TEXT,
      node_version TEXT,
      exec_path TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      status TEXT NOT NULL,
      workflow_entry TEXT NOT NULL,
      source_graph_digest TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      progress_version INTEGER NOT NULL DEFAULT 0,
      progress_updated_at TEXT,
      observation_version INTEGER NOT NULL DEFAULT 0,
      observation_updated_at TEXT
    );

    CREATE TABLE IF NOT EXISTS run_inputs (
      run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
      workflow_ir_path TEXT NOT NULL,
      workflow_ir_digest TEXT NOT NULL,
      input_json TEXT NOT NULL,
      agent_bindings_json TEXT NOT NULL DEFAULT '{}',
      output_json TEXT,
      lock_path TEXT NOT NULL,
      lock_digest TEXT NOT NULL,
      package_lock_digest TEXT,
      source_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS run_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      sequence INTEGER NOT NULL,
      type TEXT NOT NULL,
      node_key TEXT,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE,
      UNIQUE(run_id, sequence)
    );

    CREATE TABLE IF NOT EXISTS scheduler_commits (
      run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      idempotency_key TEXT NOT NULL,
      event_count INTEGER NOT NULL,
      event_digest TEXT NOT NULL,
      intent_digest TEXT,
      PRIMARY KEY (run_id, idempotency_key)
    );

    CREATE TABLE IF NOT EXISTS node_states (
      run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      node_key TEXT NOT NULL,
      node_id TEXT NOT NULL,
      status TEXT NOT NULL,
      output_json TEXT,
      PRIMARY KEY (run_id, node_key)
    );

    CREATE TABLE IF NOT EXISTS run_leases (
      run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
      owner_id TEXT NOT NULL,
      owner_epoch INTEGER NOT NULL,
      lease_expires_at TEXT NOT NULL,
      claimed_at TEXT NOT NULL,
      released_at TEXT
    );

    CREATE TABLE IF NOT EXISTS scheduler_projection_checkpoints (
      run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
      event_sequence INTEGER NOT NULL,
      projection_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS scheduler_frames (
      run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      frame_key TEXT NOT NULL,
      parent_frame_key TEXT,
      node_key TEXT,
      node_id TEXT,
      frame_kind TEXT NOT NULL,
      status TEXT NOT NULL,
      strategy TEXT,
      terminal_reason TEXT,
      instance_path_json TEXT,
      scope_json TEXT NOT NULL,
      loop_json TEXT,
      result_json TEXT,
      error_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (run_id, frame_key)
    );

    CREATE TABLE IF NOT EXISTS node_instances (
      run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      node_key TEXT NOT NULL,
      node_id TEXT NOT NULL,
      parent_frame_key TEXT,
      instance_path_json TEXT NOT NULL,
      status TEXT NOT NULL,
      status_reason TEXT,
      readiness_sequence INTEGER,
      output_json TEXT,
      error_json TEXT,
      accepted_attempt_id TEXT,
      reused_from_run_id TEXT,
      reused_from_node_key TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (run_id, node_key)
    );

    CREATE TABLE IF NOT EXISTS node_attempts (
      run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      attempt_id TEXT PRIMARY KEY,
      node_key TEXT NOT NULL,
      node_id TEXT NOT NULL,
      attempt_no INTEGER NOT NULL,
      owner_epoch INTEGER NOT NULL,
      status TEXT NOT NULL,
      deadline_at TEXT,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      result_json TEXT,
      error_json TEXT,
      terminal_reason TEXT,
      cancel_reason TEXT,
      UNIQUE(run_id, node_key, attempt_no)
    );

    CREATE TABLE IF NOT EXISTS agent_sessions (
      agent_session_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      scope_digest TEXT NOT NULL,
      generation INTEGER NOT NULL CHECK (generation >= 1),
      explicit_shared INTEGER NOT NULL CHECK (explicit_shared IN (0, 1)),
      ready_at TEXT,
      reported_version TEXT CHECK (
        reported_version IS NULL OR length(reported_version) BETWEEN 1 AND 256
      ),
      lifecycle TEXT NOT NULL CHECK (lifecycle IN ('active', 'abandoned')),
      checkpoint TEXT NOT NULL CHECK (checkpoint IN (
        'not_dispatched',
        'dispatch_intent',
        'owned_in_flight',
        'provider_observed',
        'terminal_observed',
        'acceptance_unknown',
        'terminal_unknown'
      )),
      checkpoint_attempt_id TEXT NOT NULL,
      checkpoint_turn_id TEXT,
      checkpoint_session_lease_id TEXT,
      checkpoint_prompt_origin TEXT NOT NULL CHECK (checkpoint_prompt_origin IN (
        'authored', 'steering', 'repair'
      )),
      checkpoint_input_digest TEXT NOT NULL,
      checkpoint_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (run_id, scope_digest, generation),
      CHECK (
        (checkpoint_turn_id IS NULL
          AND checkpoint_session_lease_id IS NULL
          AND checkpoint = 'not_dispatched')
        OR
        (checkpoint_turn_id IS NOT NULL
          AND checkpoint_session_lease_id IS NOT NULL)
      )
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_sessions_active_scope
      ON agent_sessions(run_id, scope_digest)
      WHERE lifecycle = 'active';

    CREATE TABLE IF NOT EXISTS agent_attempt_sessions (
      attempt_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      agent_session_id TEXT NOT NULL
        REFERENCES agent_sessions(agent_session_id) ON DELETE CASCADE,
      operation TEXT NOT NULL CHECK (operation IN (
        'start', 'continue', 'safe_retry'
      )),
      session_open_mode TEXT NOT NULL CHECK (session_open_mode IN (
        'new_or_empty', 'existing_required'
      )),
      predecessor_attempt_id TEXT,
      steer_event_sequence INTEGER
        CHECK (steer_event_sequence IS NULL OR steer_event_sequence >= 1),
      initial_prompt_origin TEXT NOT NULL CHECK (initial_prompt_origin IN (
        'authored', 'steering', 'repair'
      )),
      input_digest TEXT NOT NULL,
      admitted_from_checkpoint TEXT CHECK (
        admitted_from_checkpoint IS NULL OR admitted_from_checkpoint IN (
          'not_dispatched',
          'dispatch_intent',
          'owned_in_flight',
          'provider_observed',
          'terminal_observed',
          'acceptance_unknown',
          'terminal_unknown'
        )
      ),
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_agent_attempt_sessions_session
      ON agent_attempt_sessions(agent_session_id, created_at);

    CREATE INDEX IF NOT EXISTS idx_agent_attempt_sessions_run
      ON agent_attempt_sessions(run_id, created_at);

    CREATE TABLE IF NOT EXISTS group_members (
      run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      group_key TEXT NOT NULL,
      member_key TEXT NOT NULL,
      member_kind TEXT NOT NULL,
      branch_id TEXT,
      item_index INTEGER,
      item_json TEXT,
      child_frame_key TEXT,
      status TEXT NOT NULL,
      readiness_sequence INTEGER NOT NULL,
      completion_sequence INTEGER,
      accepted_rank INTEGER,
      terminal_reason TEXT,
      output_json TEXT,
      error_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (run_id, member_key)
    );

    CREATE TABLE IF NOT EXISTS signal_waits (
      run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      node_key TEXT NOT NULL,
      node_id TEXT NOT NULL,
      status TEXT NOT NULL,
      payload_json TEXT,
      deadline_at TEXT,
      timeout_message TEXT,
      timeout_remaining_ms INTEGER,
      rendered_prompt TEXT,
      consumed_at TEXT,
      terminal_reason TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (run_id, node_key)
    );

    CREATE TABLE IF NOT EXISTS execution_metadata (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      attempt_id TEXT NOT NULL REFERENCES node_attempts(attempt_id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      metadata_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS node_progress (
      run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      node_key TEXT NOT NULL,
      node_id TEXT NOT NULL,
      attempt_id TEXT,
      attempt_no INTEGER,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      message TEXT,
      output_tail TEXT,
      output_total_bytes INTEGER,
      output_truncated INTEGER,
      context_json TEXT,
      token_usage_json TEXT,
      tools_json TEXT,
      intent_json TEXT,
      acp_activity_at TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (run_id, node_key)
    );

    CREATE TABLE IF NOT EXISTS agent_observation_attempts (
      run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      attempt_id TEXT NOT NULL REFERENCES node_attempts(attempt_id) ON DELETE CASCADE,
      latest_observation_version INTEGER NOT NULL DEFAULT 0 CHECK (latest_observation_version >= 0),
      retention_omitted_count INTEGER NOT NULL DEFAULT 0 CHECK (retention_omitted_count >= 0),
      retention_floor_version INTEGER CHECK (retention_floor_version > 0),
      PRIMARY KEY (run_id, attempt_id)
    );

    CREATE TABLE IF NOT EXISTS agent_observation_turns (
      run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      attempt_id TEXT NOT NULL REFERENCES node_attempts(attempt_id) ON DELETE CASCADE,
      node_key TEXT NOT NULL,
      node_id TEXT NOT NULL,
      attempt_no INTEGER NOT NULL,
      turn_no INTEGER NOT NULL CHECK (turn_no > 0),
      prompt_kind TEXT NOT NULL CHECK (prompt_kind IN ('task', 'steer', 'repair')),
      state TEXT NOT NULL CHECK (state IN ('recording', 'settled', 'incomplete')),
      degraded INTEGER NOT NULL DEFAULT 0 CHECK (degraded IN (0, 1)),
      gap_count INTEGER NOT NULL DEFAULT 0 CHECK (gap_count >= 0),
      provider_event_count INTEGER NOT NULL DEFAULT 0 CHECK (provider_event_count >= 0),
      unknown_event_count INTEGER NOT NULL DEFAULT 0 CHECK (unknown_event_count >= 0),
      fence_event_sequence INTEGER,
      fenced_at TEXT,
      fence_reason TEXT,
      provider_status TEXT CHECK (provider_status IN ('completed', 'failed', 'cancelled', 'timed_out')),
      current_json TEXT,
      current_bytes INTEGER NOT NULL DEFAULT 0 CHECK (current_bytes >= 0),
      current_updated_at TEXT,
      current_observation_version INTEGER CHECK (current_observation_version > 0),
      started_at TEXT NOT NULL,
      finished_at TEXT,
      PRIMARY KEY (run_id, attempt_id, turn_no),
      UNIQUE (run_id, fence_event_sequence)
    );

    CREATE TABLE IF NOT EXISTS agent_observation_entries (
      run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      attempt_id TEXT NOT NULL,
      turn_no INTEGER NOT NULL,
      entry_id TEXT NOT NULL,
      observation_version INTEGER NOT NULL CHECK (observation_version > 0),
      source_sequence INTEGER NOT NULL CHECK (source_sequence >= 0),
      observed_at TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('activity', 'gap')),
      payload_json TEXT NOT NULL,
      payload_bytes INTEGER NOT NULL CHECK (payload_bytes > 0),
      PRIMARY KEY (run_id, attempt_id, entry_id),
      FOREIGN KEY (run_id, attempt_id, turn_no)
        REFERENCES agent_observation_turns(run_id, attempt_id, turn_no)
        ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS hook_journal (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      event_sequence INTEGER NOT NULL,
      trigger_order INTEGER NOT NULL,
      event TEXT NOT NULL,
      source TEXT NOT NULL,
      source_path TEXT NOT NULL,
      handler_id TEXT NOT NULL,
      node_key TEXT,
      status TEXT NOT NULL CHECK (status IN ('completed', 'failed', 'timed_out')),
      exit_code INTEGER,
      stdout TEXT,
      stderr TEXT,
      duration_ms INTEGER,
      error TEXT,
      triggered_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS hook_dispatch_cursors (
      run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
      event_sequence INTEGER NOT NULL CHECK (event_sequence >= 0)
    );

    CREATE INDEX IF NOT EXISTS idx_run_leases_expires ON run_leases(lease_expires_at);
    CREATE INDEX IF NOT EXISTS idx_run_events_node_sequence ON run_events(run_id, node_key, sequence DESC);
    CREATE INDEX IF NOT EXISTS idx_scheduler_frames_parent_status ON scheduler_frames(run_id, parent_frame_key, status);
    CREATE INDEX IF NOT EXISTS idx_node_instances_node_status ON node_instances(run_id, node_id, status);
    CREATE INDEX IF NOT EXISTS idx_node_instances_frame_status ON node_instances(run_id, parent_frame_key, status);
    CREATE INDEX IF NOT EXISTS idx_node_attempts_owner_status ON node_attempts(run_id, owner_epoch, status);
    CREATE INDEX IF NOT EXISTS idx_node_attempts_deadline_status ON node_attempts(run_id, deadline_at, status);
    CREATE INDEX IF NOT EXISTS idx_group_members_ready ON group_members(run_id, group_key, readiness_sequence);
    CREATE INDEX IF NOT EXISTS idx_group_members_status ON group_members(run_id, group_key, status);
    CREATE INDEX IF NOT EXISTS idx_signal_waits_status ON signal_waits(run_id, node_key, status);
    CREATE INDEX IF NOT EXISTS idx_signal_waits_deadline_status ON signal_waits(run_id, deadline_at, status);
    CREATE INDEX IF NOT EXISTS idx_node_progress_run_updated ON node_progress(run_id, updated_at);
    CREATE INDEX IF NOT EXISTS idx_agent_observation_turns_node
      ON agent_observation_turns(run_id, node_key, attempt_no, turn_no);
    CREATE INDEX IF NOT EXISTS idx_agent_observation_entries_attempt
      ON agent_observation_entries(run_id, attempt_id, observation_version, source_sequence, entry_id);
    CREATE INDEX IF NOT EXISTS idx_agent_observation_entries_target_time
      ON agent_observation_entries(run_id, attempt_id, observed_at, entry_id);
    CREATE INDEX IF NOT EXISTS idx_hook_journal_run_id ON hook_journal(run_id);
    CREATE INDEX IF NOT EXISTS idx_hook_journal_triggered_at ON hook_journal(triggered_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_hook_journal_event_order
      ON hook_journal(run_id, event_sequence, trigger_order);

    CREATE TABLE IF NOT EXISTS artifacts (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      node_key TEXT,
      attempt INTEGER,
      media_type TEXT,
      digest TEXT NOT NULL,
      size INTEGER NOT NULL,
      relative_path TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_artifacts_run_created
      ON artifacts(run_id, created_at, id);

    CREATE TABLE IF NOT EXISTS fork_replay_session_groups (
      run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      session_group_digest TEXT NOT NULL,
      member_count INTEGER NOT NULL CHECK (member_count > 0),
      replayed_count INTEGER NOT NULL DEFAULT 0 CHECK (replayed_count >= 0 AND replayed_count <= member_count),
      PRIMARY KEY (run_id, session_group_digest)
    );

    CREATE TABLE IF NOT EXISTS fork_replay_facts (
      run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      node_key TEXT NOT NULL,
      source_run_id TEXT NOT NULL,
      source_sequence INTEGER NOT NULL,
      operation_digest TEXT NOT NULL,
      input_digest TEXT NOT NULL,
      session_group_digest TEXT,
      output_json TEXT,
      artifacts_json TEXT NOT NULL,
      PRIMARY KEY (run_id, node_key),
      FOREIGN KEY (run_id, session_group_digest)
        REFERENCES fork_replay_session_groups(run_id, session_group_digest)
    );
    CREATE INDEX IF NOT EXISTS idx_fork_replay_facts_order
      ON fork_replay_facts(run_id, source_sequence, node_key);
  `);
  db.exec(`
    INSERT INTO hook_dispatch_cursors (run_id, event_sequence)
    SELECT runs.id, COALESCE(MAX(run_events.sequence), 0)
    FROM runs
    LEFT JOIN run_events ON run_events.run_id = runs.id
    LEFT JOIN hook_dispatch_cursors ON hook_dispatch_cursors.run_id = runs.id
    WHERE hook_dispatch_cursors.run_id IS NULL
    GROUP BY runs.id;
  `);
}
