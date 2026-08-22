# ACP Spec

## Purpose

`@acpus/acp` owns the stable ACP v1 stdio session interface, supported client
operations, normalized public events and failures, and the resumable Acpus ACP
session projection.

## Requirements

### Public Session Boundary

- The package root MUST expose `openAcpSession` and its package-owned launch,
  session, turn, event, result, usage, and error types. It MUST expose no public
  protocol-version or protocol-SDK types, and it MUST NOT re-export the SDK
  transport adapter.
- The callable Session surface MUST consist only of `openAcpSession`,
  `AcpSession.runTurn`, and `AcpSession.close`; each MUST return
  `Effect.Effect<..., AcpError>`. Opening MUST retain the explicit
  `AcpTransport | ProcessHost | Scope.Scope` requirements for the executable
  composition root to provide; the returned Session methods MUST retain no
  ambient service requirement.
- `openAcpSession` MUST accept a command or structured-argv launch, effective
  cwd and environment, `approve-reads | approve-all | deny-all` permission mode,
  state directory, caller-owned Agent Session id, `new_or_empty | existing_required`
  open mode, immutable effective model/options, and optional
  caller-owned cancellation signal. Structured argv MUST retain its argument
  boundaries through startup.
- `openAcpSession` MUST impose no package-owned open deadline.
- Aborting the open signal before session readiness MUST cooperatively cancel
  any in-flight ACP request through stable-v1 `$/cancel_request`. It MUST return
  a tagged `cancelled` failure only after every connection owned by that open is
  closed and its spawned Agent process tree is no longer live; inability to
  establish that result after bounded cleanup MUST instead return a tagged
  `cleanup` failure.
- An opened session MUST expose its Agent Session id, backend session id,
  state-directory-relative projection path, and the optional non-empty
  Provider-reported version from `initialize.agentInfo.version`. The version is
  bounded to 256 characters and is observational only.
- `runTurn` MUST accept one string prompt, optional desired model and complete
  string-option map, optional cancellation signal, and optional event callback.
- A session MUST admit at most one active turn. Calling `runTurn` after close
  MUST return a tagged session failure, and repeated `close` calls MUST succeed
  without repeating close effects.
- Model and options MUST be immutable for an Agent Session. Effective
  configuration MUST be applied in stable order during open and replayed after
  session recovery; a Turn-supplied configuration that is not exactly the
  opened effective configuration MUST fail before Provider dispatch.
- A turn MUST settle as `completed` or `cancelled`, with string stop reason and
  package-owned token usage when supplied by the Agent. Every other recoverable
  boundary failure MUST return `AcpError`.
- Cancellation MUST request stable-v1 session cancellation; the turn MUST then
  settle from its prompt response or a tagged failure.
- Public events MUST use the closed message, tool, usage, plan, session,
  client-activity, and unknown variants. Public event, result, usage, and error
  values MUST be package-owned and JSON-safe rather than protocol-SDK types.
- `AcpError` MUST identify its operation, originating boundary, Provider
  evidence (`none | inbound_activity | terminal_response`), message,
  retryability, and optional code through the closed invalid-input,
  persistence, spawn, cancelled,
  cleanup, initialize, protocol, capability, session, configuration,
  provider-exit, client-operation, and Session-binding variants. A binding
  mismatch MUST expose only a non-empty fixed-order subset of
  `launch | cwd | model | options`.
- The public interface MUST NOT expose raw protocol envelopes or raw provider
  wire output.

### SDK Transport Boundary

- The package MUST expose `@acpus/acp/transport` as the explicit low-level ACP
  SDK adapter. This subpath MAY expose the pinned SDK request, response, and
  update types needed by Session lifecycle code; the package root MUST remain
  package-owned.
- The package MUST expose `@acpus/acp/cancellation` as the single
  listener-cleanup bridge from an external `AbortSignal` to Effect
  interruption. ACP transport and Agent Session supervision MUST consume this
  bridge rather than owning separate listener lifecycles.
- The adapter MUST provide an `AcpTransport` service with Context key
  `acpus/acp/AcpTransport`. Connecting MUST require `ProcessHost` and a
  `Scope`, and MUST return Effect operations for initialize, new/resume/load,
  configuration, prompt, cancellation, Session close, process signalling,
  liveness, and connection close plus an ordered update Stream. Each decoded
  update MUST carry only the SDK update and the optional package-owned prompt
  epoch/sequence needed by Session fencing; `prompt` MUST return the matching
  epoch and exact pre-response update fence with its SDK response.
- Provider creation, stdio conversion, SDK connection ownership, request
  Promise adaptation, SDK callback adaptation, and the bounded provider-exit
  priority race MUST be confined to the transport adapter. It MUST use
  `@acpus/owned-process` rather than importing Node child-process APIs.
- Fiber interruption of an outbound SDK request MUST supply the SDK
  cancellation signal and MUST stop waiting even if the SDK Promise settles
  later. An inbound SDK cancellation signal MUST interrupt the corresponding
  handler Effect and remove its listener.
- SDK callbacks MUST enqueue handler Effects into concurrent Fibers owned by
  the connection Scope. They MUST NOT start an Effect Runtime internally.
  Closing the Scope MUST interrupt and settle every pending callback, close the
  SDK connection, end the update Stream, and release the provider process.
- A request-side transport failure observed within the 100 ms provider-exit
  priority window MUST become a typed provider-exit failure when process exit
  is observed in that window.

### Stable V1 Behavior

- A session MUST use only stable ACP v1 and MUST advertise only implemented
  client capabilities.
- The stable-v1 prompt response MUST be the turn-completion fence. Update
  notifications received before that response MUST finish current-turn
  handling before `runTurn` settles; notifications received after that fence
  and before the next prompt is written MUST NOT be attributed to a later
  turn.
- `new_or_empty` MUST accept only an absent projection or a projection with no
  conversation and no last stop. `existing_required` MUST require a projection.
  An existing valid
  projection MUST resume that session when the Agent currently supports resume,
  otherwise load it when the Agent supports load. An empty `new_or_empty`
  projection MAY create a new backend session when neither recovery capability
  exists; `existing_required` MUST instead return a tagged capability failure.
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
- Every validated reverse RPC, including permission, filesystem, and terminal
  operations, MUST emit client activity. UI filtering MUST NOT suppress this
  Provider evidence.
- Event callback failures MUST NOT change protocol behavior or turn settlement.

### Session Projection

- The projection path MUST be
  `sessions/<encodeURIComponent(agentSessionId)>.json` beneath the supplied state
  directory, and successful persistence MUST atomically replace that file.
- The projection MUST use the closed schema `acpus.acp-session.v3` and contain
  the matching Agent Session id; one closed structured binding; backend session
  id and resume/load capabilities;
  bounded semantic conversation; optional latest stop and token usage; and
  canonical UTC creation and update timestamps.
- The semantic conversation MUST retain a bounded newest suffix of User and
  Agent text, thought, tool calls, and compact tool-result content. It MUST omit
  raw tool output.
- Opening an existing projection MUST validate its closed shape, Agent Session
  id, and exact binding before spawning the Provider. A malformed projection is
  corruption; a genuine mismatch is a typed Session-binding failure with
  fixed-order safe categories. Either failure MUST leave the file unchanged.
- The private projection MUST preserve the resolved launch without display
  name, real cwd, model or null, and complete string options. It MUST NOT contain
  environment values, permissions, secrets, raw protocol data, protocol-SDK
  values, or serialized Result objects. Earlier projection shapes are
  unsupported and MUST NOT be migrated.

### Session Binding

- `openAcpSession` MUST construct one closed binding before projection lookup or
  Provider spawn from the resolved launch without display name,
  `realpath(resolve(cwd))`, and immutable effective model/options.
- Option keys MUST be stored in stable UTF-16 code-unit order while their values
  and argv boundaries remain unchanged. Existing bindings MUST be compared
  directly by `launch`, `cwd`, `model`, and `options`.
- Environment, PATH, permission, selector name, Run/Attempt/owner identity, and
  physical executable/package version MUST NOT enter the binding.
- Provider-reported name/version MUST NOT enter the binding.

## Verification

- `pnpm --filter @acpus/acp typecheck`: verifies the package-owned stable-v1
  public surface.
- `pnpm test:unit packages/acp`: verifies input validation, event and failure
  normalization, permissions, client-operation fencing, and bounded projection.
- `pnpm test:integration packages/acp`: verifies stdio initialize, session
  recovery, configuration replay, turns, cancellation, client operations, and
  projection behavior.
- `pnpm test:contract packages/acp` and `pnpm test:type packages/acp`: verify
  the root export, closed package-owned type surface, and explicit
  `@acpus/acp/transport` Effect contract.
