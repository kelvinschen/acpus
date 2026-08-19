# ACP Spec

## Purpose

`@acpus/acp` owns the stable ACP v1 stdio session interface, supported client
operations, normalized public events and failures, and the resumable Acpus ACP
session projection.

## Requirements

### Public Session Boundary

- The package root MUST expose `openAcpSession` and its package-owned launch,
  session, turn, event, result, usage, and error types. It MUST expose no public
  protocol-version or transport subpath.
- The callable surface MUST consist only of `openAcpSession`,
  `AcpSession.runTurn`, and `AcpSession.close`; each MUST return
  `ResultAsync<..., AcpError>`.
- `openAcpSession` MUST accept a command or structured-argv launch, effective
  cwd and environment, `approve-reads | approve-all | deny-all` permission mode,
  state directory, caller-owned record id, and optional caller-owned
  cancellation signal. Structured argv MUST retain its argument boundaries
  through startup.
- `openAcpSession` MUST impose no package-owned open deadline.
- Aborting the open signal before session readiness MUST cooperatively cancel
  any in-flight ACP request through stable-v1 `$/cancel_request`. It MUST return
  a tagged `cancelled` failure only after every connection owned by that open is
  closed and its spawned Agent process tree is no longer live; inability to
  establish that result after bounded cleanup MUST instead return a tagged
  `cleanup` failure.
- An opened session MUST expose its record id, backend session id, and
  state-directory-relative projection path.
- `runTurn` MUST accept one string prompt, optional desired model and complete
  string-option map, optional cancellation signal, and optional event callback.
- A session MUST admit at most one active turn. Calling `runTurn` after close
  MUST return a tagged session failure, and repeated `close` calls MUST succeed
  without repeating close effects.
- A supplied desired-option map MUST replace the prior complete map; omitted
  configuration MUST retain the prior desired state. Configuration MUST be
  applied in stable order and replayed after session recovery.
- A turn MUST settle as `completed` or `cancelled`, with string stop reason and
  package-owned token usage when supplied by the Agent. Every other recoverable
  boundary failure MUST return `AcpError`.
- Cancellation MUST request stable-v1 session cancellation; the turn MUST then
  settle from its prompt response or a tagged failure.
- Public events MUST use the closed message, tool, usage, plan, session,
  client-activity, and unknown variants. Public event, result, usage, and error
  values MUST be package-owned and JSON-safe rather than protocol-SDK types.
- `AcpError` MUST identify its operation, message, retryability, and optional
  code through the closed invalid-input, persistence, spawn, cancelled,
  cleanup, initialize, protocol, capability, session, configuration,
  provider-exit, and client-operation variants.
- The public interface MUST NOT expose raw protocol envelopes or raw provider
  wire output.

### Stable V1 Behavior

- A session MUST use only stable ACP v1 and MUST advertise only implemented
  client capabilities.
- The stable-v1 prompt response MUST be the turn-completion fence. Update
  notifications received before that response MUST finish current-turn
  handling before `runTurn` settles; notifications received after that fence
  and before the next prompt is written MUST NOT be attributed to a later
  turn.
- A missing projection MUST create a new backend session. An existing valid
  projection MUST resume that session when the Agent currently supports resume,
  otherwise load it when the Agent supports load, and otherwise return a tagged
  capability failure without creating another session.
- `approve-all` MUST select an offered approval, `approve-reads` MUST do so only
  for read or search tool calls, and `deny-all` MUST select an offered rejection.
  If the required option is unavailable, the permission request MUST be
  cancelled.
- Filesystem operations MUST accept only absolute paths whose resolved targets
  remain beneath the effective cwd.
- Terminal operations MUST remain beneath the effective cwd, expose bounded
  output, and enforce create, output, wait, kill, and release lifecycle. Session
  close MUST fence new reverse operations, drain every admitted terminal create,
  cancel pending permission requests, and close every owned terminal.
- Event callback failures MUST NOT change protocol behavior or turn settlement.

### Session Projection

- The projection path MUST be
  `sessions/<encodeURIComponent(recordId)>.json` beneath the supplied state
  directory, and successful persistence MUST atomically replace that file.
- The projection MUST use the closed schema `acpus.acp-session.v1` and contain
  the matching record id and cwd; launch kind, optional name, and SHA-256
  identity; backend session id and resume/load capabilities; desired model and
  string options; bounded semantic conversation; optional latest stop and token
  usage; and canonical UTC creation and update timestamps.
- The semantic conversation MUST retain a bounded newest suffix of User and
  Agent text, thought, tool calls, and compact tool-result content. It MUST omit
  raw tool output.
- Opening an existing projection MUST validate its closed shape, record id,
  cwd, and exact launch identity. A validation failure MUST leave the file
  unchanged and return a tagged persistence failure.
- The projection MUST NOT contain environment values, secrets, raw protocol
  data, protocol-SDK values, or serialized Result objects.

## Verification

- `pnpm --filter @acpus/acp typecheck`: verifies the package-owned stable-v1
  public surface.
- `pnpm test:unit packages/acp`: verifies input validation, event and failure
  normalization, permissions, client-operation fencing, and bounded projection.
- `pnpm test:integration packages/acp`: verifies stdio initialize, session
  recovery, configuration replay, turns, cancellation, client operations, and
  projection behavior.
- `pnpm test:contract packages/acp` and `pnpm test:type packages/acp`: verify
  the root export and closed package-owned type surface.
