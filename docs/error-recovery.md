# Error Recovery Reference

This document indexes current user-visible error identities and the next safe
action at each product boundary. Owner Specs and exported types remain
authoritative. A code alone never authorizes a retry: operation semantics and
the durable outcome are part of the decision.

## Recovery classes

| Class | Meaning |
| --- | --- |
| Automatic | The same identity can be replayed or reconciled without duplicating effects or changing user intent. |
| Degraded | Preserve durable facts, isolate the unavailable boundary, and continue serving retained state. |
| Action required | Stop and present one corrective command or user action. |
| Fatal/bug | Preserve evidence and state; do not reset, delete, quarantine, or guess a repair. |

## Runtime and daemon

| Operation and durable outcome | Public code or typed tag | Class | Safe handling / next action |
| --- | --- | --- | --- |
| Authority probe finds a replaced daemon before mutation | `AUTHORITY_MISMATCH` | Automatic | Re-probe authority and resend only the request whose stable identity is unchanged. |
| Request or admitted payload is invalid | `INVALID_REQUEST` | Action required | Correct the authored request; do not retry unchanged input. |
| Exact run is absent | `RUN_NOT_FOUND` | Action required | Re-list or inspect runs and select an existing run. |
| Run or target cannot accept the control | `RUN_NOT_CONTROLLABLE` | Action required | Re-inspect state and choose a currently offered control. |
| A request identity names different content | `CONTROL_CONFLICT` | Action required | Preserve the original request; use a new identity only for a genuinely new intent. |
| Submission is confirmed not admitted | `EXECUTION_UNAVAILABLE` | Action required | Restore Runtime availability, then retry the intended submission. |
| Submission is admitted but execution startup is unavailable | `EXECUTION_UNAVAILABLE` with `outcome: admitted` | Degraded | Inspect/follow the durable run; do not submit a replacement. |
| Internal read/tick/hook cursor meets transient SQLite contention | `STORE_BUSY` | Automatic | Retain the cursor or scheduled work and retry on the next owned tick. |
| Admission/control meets `STORE_BUSY` with a stable request identity | `STORE_BUSY` | Action required | Reconcile the receipt first; replay only the identical request identity and payload. |
| Storage operation fails outside the recognized busy boundary | `STORE_ERROR` | Fatal/bug | Preserve the store and run `acpus doctor`; report the evidence if health cannot explain it. |
| Runtime reaches an unexpected invariant | `INTERNAL_ERROR` | Fatal/bug | Preserve state and report the bounded failure evidence. |
| Workspace Runtime open cannot find the path | `workspace-unavailable` | Degraded | Restore the exact original path; the next related operation or Host restart rechecks it. |
| Another live Runtime owns the workspace | `runtime-authority-busy` | Degraded | Wait for or stop the competing owner, then repeat the same operation. |
| Runtime store cannot be opened | `runtime-store-unavailable` | Action required | Inspect health and filesystem access; retry only after correcting the cause. |
| Runtime store version is unsupported | `runtime-store-unsupported` | Fatal/bug | Preserve the store, run `acpus doctor`, and use a compatible Acpus version; do not rewrite it. |
| Runtime configuration is invalid | `runtime-configuration-invalid` | Action required | Correct the named configuration value and restart the Runtime. |
| Runtime startup fails after typed preparation | `runtime-open-failed` | Fatal/bug | Preserve the detailed message and investigate startup evidence. |
| Read path requires an explicit layout repair | `runtime-store-repair-required` | Action required | Run `acpus doctor --fix`; ordinary reads and controls remain non-mutating. |
| Read path has no Runtime store | `runtime-store-not-found` | Action required | Confirm the workspace or admit its first run; do not invent archived state. |

The daemon protocol's closed public code set is:
`INVALID_REQUEST`, `AUTHORITY_MISMATCH`, `RUN_NOT_FOUND`,
`RUN_NOT_CONTROLLABLE`, `CONTROL_CONFLICT`, `EXECUTION_UNAVAILABLE`,
`STORE_BUSY`, `STORE_ERROR`, and `INTERNAL_ERROR`.

## DSH Host and Client

| Codes | Class | Safe handling / next action |
| --- | --- | --- |
| `ACPUS_WORKSPACE_UNAVAILABLE` | Degraded | Retain the task and last projection, show the original path in Tray, and retry only that path on the next related operation or restart. |
| `ACPUS_RUNTIME_BUSY` | Degraded | Retain task status; wait for the competing Runtime owner before retrying. |
| `ACPUS_RUNTIME_UNAVAILABLE` | Degraded | Retain task status and show the typed Runtime detail; correct it before retrying. |
| `ACPUS_ADMISSION_OUTCOME_UNKNOWN` | Degraded | Keep the provisional link; do not submit a replacement task. Restart or retry after Runtime recovery so the same admission identity can reconcile. |
| `ACPUS_RUNTIME_CLOSED` | Fatal/bug | Treat as a Host lifecycle invariant and report it. |
| `ACPUS_WORKSPACE_REQUIRED`, `ACPUS_SESSION_REQUIRED` | Action required | Open/select a workspace-backed DSH session and repeat the operation. |
| `ACPUS_TASK_NOT_FOUND` | Action required | Read `acpus_tasks` and use an exact current `{name, occurrence}` selector. |
| `ACPUS_INPUT_INVALID`, `ACPUS_INSPECT_INVALID`, `ACPUS_ARTIFACT_INVALID` | Action required | Correct the supplied input or selector before repeating. |
| `ACPUS_ARTIFACT_NOT_FOUND` | Action required | List artifacts for the exact task and choose an existing id. |
| `ACPUS_INSPECT_FAILED`, `ACPUS_ARTIFACT_READ_FAILED`, `ACPUS_READ_FAILED` | Action required | Re-inspect retained task state; retry only if the failed operation was read-only. |
| `ACPUS_ADMISSION_INCONSISTENT`, `ACPUS_RUN_LINK_CONFLICT` | Fatal/bug | Preserve the private link state and report the identity conflict. |
| `ACPUS_RUN_LINKS_INVALID`, `ACPUS_AGENT_PROFILES_INVALID` | Fatal/bug | Preserve the file; do not reset or migrate it implicitly. |
| `ACPUS_RUN_LINK_READ_FAILED`, `ACPUS_RUN_LINK_WRITE_FAILED`, `ACPUS_AGENT_PROFILES_READ_FAILED`, `ACPUS_AGENT_PROFILES_WRITE_FAILED` | Fatal/bug | Correct filesystem access while preserving the existing file. |
| `ACPUS_PRESET_COLLISION` | Action required | Remove or rename the unowned conflicting preset explicitly. |
| `ACPUS_HOST_UNAVAILABLE` | Action required | Restore the DSH Host service, then repeat the read or mutation. |
| `ACPUS_INVALID_REQUEST`, `ACPUS_CONTROL_CONFLICT` | Action required | Correct the request or retain the request identity's original content. |
| `ACPUS_EXECUTION_UNAVAILABLE` with confirmed `not-admitted` | Action required | Restore execution availability, then repeat the intended submission. |
| `ACPUS_EXECUTION_UNAVAILABLE` with `admitted` or `unknown` | Degraded | Reconcile the original admission identity; never submit a replacement. |
| `ACPUS_STORE_BUSY` with a readable absent receipt | Automatic | Replay once with the exact admission/control request identity and payload, then query the receipt again. |
| `ACPUS_STORE_BUSY` with an unreadable or still-unknown receipt | Degraded | Preserve the provisional link or pending control and wait for Runtime recovery. |
| `ACPUS_STORE_ERROR`, `ACPUS_INTERNAL_ERROR` | Fatal/bug | Preserve durable state and report bounded evidence. |

Expected Runtime-open failures update Client availability and do not emit a
Supervisor notice or startup stack. Unknown exceptions still use Host error
reporting. Terminal history is served without reopening its workspace.

## CLI

| Codes | Class | Safe handling / next action |
| --- | --- | --- |
| `RUNTIME_STORE_REPAIR_REQUIRED` | Action required | Run `acpus doctor --fix`. |
| `RUNTIME_STORE_UNSUPPORTED`, `RUNTIME_STORE_UNREADABLE` | Action required | Run `acpus doctor`; use a compatible version or repair filesystem access without rewriting state. |
| `RUNTIME_STORE_REPAIR_FAILED`, `RUNTIME_STORE_UNAVAILABLE` | Fatal/bug | Preserve the store and use the doctor output to investigate the failed repair/read. |
| `RUNTIME_STORE_NOT_FOUND` | Action required | Confirm the workspace or admit its first run. |
| `RUNTIME_UPDATE_BLOCKED` | Action required | Leave the current daemon and runs untouched, wait for current work to settle, then retry. |
| `RUNTIME_AUTHORITY_LOST` | Degraded | The admitted run remains durable; run `acpus runs inspect <run-id> --follow`. |
| `ADMISSION_OUTCOME_UNKNOWN` | Degraded | Inspect recent runs before submitting again. |
| `ARCHIVED_RUN_DETAIL_UNAVAILABLE`, `ARCHIVED_RUN_LOOKUP_UNAVAILABLE` | Action required | Use the command named by the error or restore the archived index; do not infer missing detail. |
| `RUN_ACTIVE` | Action required | Stop/cancel the run explicitly before deletion. |
| `RUN_NOT_FOUND`, `TARGET_NOT_FOUND` | Action required | Re-list or re-inspect and select an existing run/target. |
| `TARGET_AMBIGUOUS`, `TARGET_REF_COLLISION` | Action required | Copy one exact candidate `@ref`. |
| `READ_FAILED` | Fatal/bug | Preserve the run and inspect Runtime health. |
| `ARTIFACT_NOT_FOUND`, `ARTIFACT_PATH_INVALID` | Action required | List registered artifacts and use their verified reference; do not guess paths. |
| `RUNTIME_CONFIGURATION_INVALID` | Action required | Correct the named environment configuration. |
| `AUTHORITY_WAIT_ABORTED` | Action required | Respect the cancellation; repeat only when the caller still wants the operation. |
| `DAEMON_STATUS_FAILED`, `DAEMON_SPAWN_FAILED`, `DAEMON_EXITED_BEFORE_READY`, `DAEMON_START_TIMEOUT` | Action required | Correct the reported process/runtime cause, then restart the command. |
| `DAEMON_STREAM_PROTOCOL_FAILED` | Fatal/bug | Preserve protocol evidence; if admission may have occurred, inspect recent runs before retrying. |
| `LISTEN_FAILED` | Action required | Choose an available bind address/port and restart Web. |

CLI submission and control also surface the nine daemon codes using the
Runtime rules above.

### Workflow catalog

| Codes | Class | Safe handling / next action |
| --- | --- | --- |
| `CATALOG_ENTRY_MISSING`, `CATALOG_ENTRY_READ_FAILED` | Action required | Restore/read the selected catalog entry. |
| `CATALOG_METADATA_FAILED`, `CATALOG_SOURCE_INVALID` | Action required | Correct the entry's TypeScript source. |
| `CATALOG_DEFAULT_EXPORT_MISSING`, `CATALOG_WORKFLOW_NOT_STATIC`, `CATALOG_NAME_NOT_STATIC` | Action required | Export one statically analyzable named workflow. |
| `CATALOG_NAME_INVALID`, `CATALOG_NAME_MISMATCH` | Action required | Correct the declared and requested workflow name. |

### Workflow import

| Codes | Class | Safe handling / next action |
| --- | --- | --- |
| `IMPORT_SOURCE_INVALID`, `IMPORT_SOURCE_UNAVAILABLE`, `IMPORT_DOWNLOAD_FAILED` | Action required | Correct or restore the named source and retry staging. |
| `IMPORT_ARCHIVE_INVALID`, `IMPORT_PACKAGE_INVALID`, `IMPORT_METADATA_INVALID`, `IMPORT_NAME_INVALID`, `IMPORT_CHECK_NAME_MISMATCH` | Action required | Correct the package/archive; no catalog mutation has been committed. |
| `IMPORT_COLLISION` | Action required | Choose a non-conflicting name or remove the explicit conflicting entry. |
| `IMPORT_COMMIT_FAILED`, `IMPORT_CLEANUP_FAILED`, `IMPORT_FAILED` | Fatal/bug | Preserve staging/backup evidence and inspect the reported filesystem failure. |

## Web

| Codes | Class | Safe handling / next action |
| --- | --- | --- |
| `unauthorized` | Action required | Supply the explicitly configured access token. |
| `not_found`, `workspace_not_found`, `run_not_found`, `target_not_found`, `artifact_not_found` | Action required | Return to the catalog/run view and choose an existing resource. |
| `target_ambiguous`, `target_ref_collision` | Action required | Select one exact Runtime-provided candidate. |
| `invalid_workflow_path`, `invalid_json`, `invalid_visualization_source`, `invalid_command`, `invalid_inspection_query` | Action required | Correct the request before resubmitting. |
| `workspace_read_only` | Action required | Use a writable workspace or a read-only operation. |
| `runtime_update_blocked` | Action required | Wait for current Runtime work to finish, then retry. |
| `runtime_store_fix_required` | Action required | Use the explicit **Fix** action; no read/control request performs the repair implicitly. |
| `runtime_store_unavailable`, `runtime_unavailable` | Degraded | Retain the last successful view and retry only read requests after correcting Runtime health. |
| `runtime_store_fix_failed`, `internal_error` | Fatal/bug | Preserve the server log evidence and state; do not repeat a mutation blindly. |
| normalized `invalid_request`, `run_not_controllable`, `control_conflict`, `store_busy` | Action required | Re-inspect control applicability; resend only an identical stable request when its outcome is known safe. |
| normalized `authority_mismatch` | Automatic | Re-establish authority before a mutation is sent. |
| normalized `execution_unavailable` with a confirmed non-admission | Action required | Restore execution availability before intentionally submitting again. |
| normalized `execution_unavailable` with an admitted or unknown outcome | Degraded | Retain the last view and reconcile the original request identity. |
| normalized `store_error` | Fatal/bug | Preserve server/store evidence; do not retry a mutation. |
| `network-failed`, `response-invalid-json`, `response-invalid-envelope` | Degraded | Retain the last view; retry only idempotent reads after transport recovery. |
| `request-failed` for an idempotent read | Degraded | Retain the last view and retry after transport recovery. |
| `request-failed` for a mutation with unknown outcome | Degraded | Reconcile the original request identity; do not create a replacement mutation. |

## Compiler diagnostics

The current authored-diagnostic inventory is:

- `A001`–`A003`
- `AL001`–`AL007`
- `E000`–`E004`
- `EX001`–`EX003`, `EX006`
- `F001`–`F004`
- `G002`–`G003`
- `ID001`–`ID002`
- `IR001`–`IR003`
- `N001`
- `P001`–`P002`
- `S001`–`S002`
- `SC001`–`SC002`
- `T006`–`T007`
- `TB001`–`TB004`
- `W002`
- `WF001`–`WF002`
- upstream `TS####`

All compiler diagnostics are **Action required**: correct the source, input,
or package mismatch and prepare again. DSH may repair authored source before
admission; Runtime never retries a rejected compilation.

## Agent executor

| Failure kind | Class | Safe handling / next action |
| --- | --- | --- |
| `config` | Action required | Correct the named Agent/Profile configuration, then fork or retry as appropriate. |
| `spawn` | Action required | Restore the executable/worker environment before retrying. |
| `provider_exit` | Action required | Inspect upstream evidence; retry only when unchanged admitted work is safe to repeat. |
| `timeout` | Action required | Inspect the exact failed attempt and explicitly retry or fork. |
| `worker_lost`, `inactivity_stale` | Action required | Runtime may recover ownership, but repeating Agent work remains an explicit retry/fork decision. |

`retryable: true` is evidence, not permission to replay an Agent attempt: the
provider may already have produced external effects or cost.

## Non-public evidence

Filesystem errno values, exception class names, process exits, SQLite details,
and internal invariant messages remain causal evidence. Boundaries map them to
the typed/public identities above and retain the cause for diagnostics; they
must not become undocumented public recovery promises.
