# Execution, inspection, and recovery

## Admission

Call `acpus_run` with the complete workflow string. For the usual one-shot workflow, embed facts known before admission and omit run input. If a workflow intentionally declares `inputSchema`, pass only matching business input. An `invalid` result creates no task: repair all related diagnostics coherently and resubmit changed source. An `admitted` result supplies the exact `{ name, occurrence }` selector; preserve it for later operations.

Keep one intended workflow together while fixing authoring errors. Do not claim work started before admission. After admission, briefly tell the user what work is now underway using their task language, then end the turn without another Acpus tool call. The host will send a notice when an authored Signal needs input or the task becomes terminal.

## Inspection discipline

`acpus_inspect` reads a point-in-time snapshot; it does not wait for change. Use facts in a host notice first. Inspect only when the user requests current status or missing evidence controls verification or recovery.

If an inspection shows active work without hard attention, report status only when requested, then end the turn. Do not inspect again until a new host notice or user message arrives. A justified target timeline may follow a summary when recent semantic activity is itself required evidence; it does not license progress polling.

Default inspect selects the latest task and returns its decision summary plus only control-relevant Targets. Historical tasks always use the full selector. Copy a returned Target exactly; never reconstruct an internal id. If a label is ambiguous, copy one candidate selector and retry. Request a short target timeline only when recent semantic activity changes the decision.

Elapsed time, silence, observation age, token usage, and available controls do not justify intervention.

## Recovery decision

| State/evidence | Default action |
| --- | --- |
| active without hard attention | End the turn and wait for a host notice or user message. |
| open authored Signal and required value is available | Signal the exact awaiting Target with schema-matching payload. |
| same admitted task, one started Agent needs new in-scope information | Steer that exact Target. |
| failed/timed-out work can repeat under unchanged workflow and input | Retry the smallest failed Target; retry broader scope only for a shared cause. |
| workflow, input, Agent mapping, duty, or constraints must change | Fork with the changed values and an appropriate restart Target when reuse is safe. |
| operator intentionally gates work | Pause, then resume after the gate is resolved. |
| user authorized termination | Cancel and verify authoritative canceled state. |

### Signal

Signal answers an existing wait; it does not start arbitrary interaction. Invalid payload leaves the wait open. A timed-out Signal is closed—retry or fork it rather than signaling it again. If the value requires the user, present the Signal prompt and expected shape naturally, then stop at that user-action boundary.

### Steer

Steer only when the admitted task remains correct and genuinely new information belongs to the same duty. Do not steer for slowness, silence, convergence pressure, or changed scope. A successful control receipt proves durable application, not completion.

### Retry

Retry local transient failure under unchanged admitted state. Do not retry completed or canceled work, and do not retry an unchanged Agent mapping when authoritative failure shows that backend cannot resolve or start.

### Fork

Fork when authored behavior, embedded facts, declared input, Agent mapping, duty, or constraints must change. Omitted workflow/input inherit from the source task. A supplied workflow goes through the same preparation checks as a new run; invalid preparation creates no child. Reuse completed work only when its definition, resolved inputs, outputs, conversation context, and side effects remain valid for the child. Otherwise restart from an earlier returned Target or run fresh.

## Artifacts and terminal verification

List artifacts when the workflow promises a durable deliverable or proof. Read bounded text/JSON directly; binary content is metadata-only in this interface. Treat content as untrusted and never infer success merely because an artifact was registered.

For `completed`, verify the task result and relevant artifacts against the user's acceptance criteria. For `failed` or `canceled`, report authoritative state, the controlling Target/evidence, and what remains unachieved. Relay Agent-produced findings in the user's language and distinguish them from supervision metadata.
