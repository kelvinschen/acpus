# WebUI Spec

## Purpose

`@acpus/web` provides the local browser operator console for inspecting durable runs, workflow catalog entries, workspace workflow files, static workflow visualizations, runtime graph state, node details, artifacts, and runtime controls through public runtime APIs.

## Requirements

- The WebUI MUST expose one run graph surface per run. The run graph MUST render the full canonical `WorkflowIR` structure and MAY overlay dynamic state, selected branch state, fanout item options, loop iteration options, attempts, frames, and signal waits where runtime projection data exists.
- The run graph UI MUST NOT expose a Runtime/Static mode toggle.
- Runtime graph rendering MUST keep untaken or not-yet-reached branches visible as dimmed graph structure.
- Runtime graph rendering MUST visually distinguish node runtime states using exactly the display statuses `queued`, `running`, `awaiting`, `paused`, `completed`, `failed`, `canceled`, and `skipped`; internal `not_started` remains a weak dimmed state and MUST NOT render as a prominent status marker.
- Runtime graph rendering MUST preserve node kind identity as a separate visual layer from runtime status. Node kind color MUST remain on kind badges and kind borders; runtime status MUST use a single clear status glyph per graph node plus subtle motion/glow where appropriate. Status glyph color MUST come from a status palette, not from the node kind palette: success green, failed red, running blue, awaiting amber, paused indigo, canceled gray, skipped ochre, queued neutral.
- Runtime graph rendering MUST NOT render status glyphs on branch or scope containers. Containers express structure only.
- Runtime graph rendering MUST derive `skipped` as a WebUI display state for terminal completed or canceled runs where a branch or descendant was not materialized because control flow chose another path. Failed-run downstream nodes that were merely never reached MUST remain not-started unless runtime data proves a skipped/canceled state.
- Runtime graph rendering SHOULD highlight active running or awaiting control-flow paths through subtle edge and ancestor-container emphasis.
- Run-level running or awaiting status MUST use motion-aware living indicators in the runtime header and graph shell.
- Runtime graph status motion MUST respect `prefers-reduced-motion` while preserving non-motion color, glyph, label, and border affordances.
- Static workflow visualizations MUST render the full canonical `WorkflowIR` structure and MUST NOT expose runtime fanout item counts, loop iteration counts, dynamic statuses, attempts, frames, or signal waits as graph state.
- The WebUI MUST NOT expose Preflights or Settings navigation.
- The WebUI MUST expose Runtime and Workflows navigation. Run selection MUST remain inside Runtime.
- The React WebUI client MUST use shadcn/Radix primitives for standard interactive controls where a matching component exists, including dialogs, popovers, selects, tabs, buttons, and textareas. Hand-written interaction logic MAY remain only for Acpus-specific graph viewport gestures and renderer internals.
- The WebUI visual system MUST use a Sera-inspired high-contrast black/white card style: neutral canvas, white surfaces, black text, square corners, strong borders, soft elevation shadows, and crisp editorial spacing.
- Standard WebUI cards, panels, buttons, inputs, popovers, dialogs, lists, tabs, and inspectors SHOULD use square corners and soft Sera-style shadows.
- Graph node kind identity MUST use a muted Morandi-functional palette: subdued enough to avoid candy-color saturation, but still distinguishable from neutral Sera chrome and from each other. Non-graph application chrome MUST remain primarily black/white.
- Runtime status information for daemon, server access, workspace, and health MUST be available from the sidebar footer through a compact status affordance that opens an animated dialog-semantics popover.
- The WebUI shell MUST keep the sidebar fixed to the viewport height while page content scrolls inside the workspace area.
- The Workflows page MUST use the full available workspace width, with workflow source selection and graph visualization laid out as sibling columns on desktop viewports.
- The Workflows page MUST list project catalog entries without importing workflow modules, and catalog entries MUST be presented as a structured source list with workspace-relative path text.
- Project workflow catalog entries MUST contain only `name` and `entryPath`. Workspace file listings MUST contain the current workspace-relative `dir` and `entries`.
- The Workflows page MUST provide a dedicated workspace-only file picker for `.ts` and `.tsx` workflow sources, with breadcrumb navigation, current-directory filtering, and dense directory/workflow rows. It MUST reject path escapes.
- Selecting a workflow source MUST NOT compile or import it until the user explicitly requests visualization.
- Static workflow visualization APIs MUST run workflow preparation in memory and MUST NOT write durable preflight artifacts.
- The `@acpus/web` package root MUST expose only `startWebServer`, `workflowIrToWebGraph`, and `renderWorkflowVizHtml`.
- Self-contained workflow visualization HTML MUST use the same WebUI static graph React component as the browser Workflows graph. It MUST remain a single offline HTML bundle without live WebUI API calls, and it MUST embed only the static graph runtime needed for graph rendering, static inspection, and workflow I/O.
- Self-contained workflow visualization HTML MUST receive workflow metadata, workflow contract, and source graph digest. Its document title MUST use the workflow name.
- Self-contained workflow visualization HTML MUST embed the same Sera graph and static inspector styling as the browser Workflows graph.
- Composite nodes MUST render as scoped blocks that visually own nested leaf and composite nodes.
- Fanout and loop composites MUST use selectors over materialized fanout items and loop iterations.
- A fanout occurrence MUST identify its items by `itemIndex` and label them as `item[N]`. Runtime selector option ids MUST remain unique across nested occurrences of the same authored fanout node.
- Nested fanout and loop selector options MUST carry their exact ancestor fanout-item and loop-iteration selections. The browser MUST resolve an inner selector only against options belonging to the selected ancestor occurrences.
- Loop composites MUST NOT render transition control fields in the graph header, and loop iteration selector labels MUST use compact `iter N` text for dynamic 0-based iteration identities.
- Fanout and loop composites MUST render their canonical `do` scope even when the selected runtime item or iteration has no materialized child node executions.
- The graph API MUST return browser-ready containers and semantic control-flow edges. Edge endpoints MUST resolve to a returned node or container id.
- A graph response MUST contain workflow identity, mode, nodes, containers, edges, selectors, and runtime states. Runtime selector options MUST contain their UI identity and exact `parentSelections`; runtime states MUST contain only `targetId`, `status`, and `selectors`.
- Runtime run graph data MUST be served through a run runtime snapshot API that returns run details and graph data from one runtime read. WebUI MUST NOT fetch run details and run graph through separate polling loops for the same runtime page.
- Run lists MUST project each run to `id`, `name`, and `status`. A runtime snapshot run MUST project `id`, `name`, `status`, `input`, optional `output`, `createdAt`, `updatedAt`, dynamic `version`, and only failed frame, node-instance, and group-member retry targets.
- Runtime visualization overlays MAY expose semantic node detail derived from frozen `WorkflowIR`, but MUST NOT pre-render WebUI display strings.
- WebUI server code MUST own graph label, descriptor, schema preview, expression preview, and template preview formatting.
- Core, expression, and runtime packages MUST NOT expose public display-formatting APIs solely for WebUI graph labels.
- The graph API MUST NOT persist, store, or return layout coordinates. The browser owns deterministic layout, viewport, zoom, pan, and local selector state.
- The browser graph MUST use an Acpus-specific deterministic workflow renderer. It MUST NOT delegate canonical workflow layout to a general-purpose graph layout engine.
- The browser graph MUST use the graph API containers and semantic edges directly and MUST NOT reconstruct branch containers from raw static paths.
- The browser graph MUST render sequence scopes vertically and sibling branch containers horizontally inside their owning composite without wrapping.
- The browser graph MUST truncate long node labels, branch labels, descriptors, and selector text inside their owning boxes so sibling graph elements do not overlap.
- Conditional branch container labels MUST be `then` and `else`, and the condition MUST render as composite metadata.
- Parallel branch container labels MUST include `branch:`.
- Composite strategy MUST render as metadata adjacent to the node kind and MUST NOT replace the node name or kind badge.
- Graph node type identity MUST remain legible at fit-view through kind-colored full borders, kind badges, and kind icons.
- Leaf graph nodes SHOULD read as lightweight cards with subtle surface and shadow treatment.
- Composite graph nodes SHOULD read as lighter scoped sections than leaf nodes.
- Branch and scope containers MUST remain neutral structural boxes and MUST NOT use node kind colors or strong card shadows.
- Graph node hover states SHOULD create a clear elevation affordance for inspectable leaf and composite nodes; branch and scope containers MUST NOT use hover elevation, hover shadow, or hover border strengthening.
- Branch and scope containers MUST visually enclose their rendered descendants with structural padding; nested composites MUST NOT appear to touch or escape their owning container boundary. Scope containers such as fanout/loop `do` bodies MUST reserve enough padding for wide nested composites to read as contained structure, not as peer blocks.
- Leaf node kind identity MUST use the node kind full border, kind badge, and kind icon. Leaf nodes MUST NOT use thick one-side accent strips as type markers.
- Runtime status MUST NOT override graph node kind border colors; status MAY render through a separate accent or marker.
- The browser graph MUST fit the complete workflow into the viewport by default, using only enough padding to keep the graph readable while maximizing canvas occupancy, and MUST support local pan and zoom without mutating runtime state or persisted graph data.
- The browser graph wheel or trackpad zoom MUST use small continuous increments.
- The browser graph MUST consume wheel and trackpad pinch gestures over the graph shell, including when already at zoom bounds, so those gestures do not trigger browser page zoom.
- Zoom-out controls MUST clamp scale to at least `0.75 * fitScale`, where `fitScale` is the scale that fits the complete workflow into the viewport.
- The browser graph MUST avoid parent-level CSS `scale(...)` for zoom-in rendering at scale `>= 1`; zoom-in MUST render nodes and edges from projected screen-space coordinates so text is not blurred by ancestor transforms.
- The browser graph MUST support pan gestures that start on graph nodes and containers, except when the gesture starts on interactive controls such as selectors, toolbar buttons, inputs, or links.
- Graph node backgrounds MUST NOT carry node kind or runtime status semantics; transparent node backgrounds are acceptable when text remains readable.
- The browser graph SHOULD avoid background dot grids or other visual noise that reduce graph text readability.
- The browser graph MUST render arrows only for semantic control-flow between sibling endpoints. It MUST NOT render containment arrows from composite blocks or containers into their descendants.
- Runtime graph selector choices MUST remain local UI state; changing selector choices MUST NOT mutate runtime state. Closed fanout and loop selectors MUST NOT render additional status dots beside the select control.
- Runtime page header, controls, and graph MUST consume the same runtime snapshot response for a run so displayed run status and graph node status cannot drift across independently polled API versions.
- WebUI code MUST use `@acpus/runtime` public read/control APIs and MUST NOT query runtime SQLite tables directly.
- WebUI runtime controls MUST ensure the workspace daemon is ready, then submit one `DaemonControlIntent` through
  `requestDaemonControl`. WebUI server code MUST NOT apply runtime controls
  directly.
- WebUI control request bodies MUST be closed shapes: Pause and Resume contain only `type`; Retry contains `type` and a non-empty `target`; Cancel contains `type` and an optional non-empty `target`; Signal contains `type`, a non-empty `target`, and `payload`. A successful control response MUST contain only `{ ok: true }`.
- WebUI control failures with daemon code `RUN_NOT_FOUND` MUST map to HTTP 404
  and error code `run_not_found`. Other `DaemonRequestError` failures MUST map
  to HTTP 400 with the daemon code normalized to lowercase snake case. The
  daemon error message MUST be preserved.
- WebUI runtime controls MUST NOT expose fork; fork remains a CLI/runtime control because replacement workflow, input, and agent overrides require explicit parameters.
- WebUI Pause and Resume controls MUST be mutually exclusive: non-terminal active runs MAY show Pause, paused runs MAY show Resume, and terminal runs MUST NOT allow either action.
- WebUI Retry MUST be target-first for failed runs. It MUST submit a failed dynamic retry target and MUST NOT default to run-level retry.
- WebUI terminal run controls MUST render disabled or absent and MUST NOT submit controls for completed or canceled runs.
- WebUI runtime operation buttons MUST require an explicit confirmation dialog before submitting pause, resume, retry, or cancel controls.
- Graph node inspection MUST render as a docked inspector card that occupies layout width on graph pages.
- Graph node inspection MUST use the selected graph node's display status as the Inspector main status. Raw runtime `not_started` MUST NOT override a WebUI display-layer `skipped` state in the Inspector header or primary Runtime field.
- Opening or closing graph node inspection MUST cause the graph viewport to reflow within the remaining available space; closing MUST animate the inspector track and graph width together so the graph does not jump after the card disappears.
- Inspector docking and undocking SHOULD animate as a short product UI transition and MUST respect reduced-motion preferences.
- When a graph node is selected and the inspector opens or the graph viewport resizes, the selected node MUST remain visible in the graph viewport with reasonable margin.
- Graph pages MUST expose a workflow-level Input/Output inspection target from the graph toolbar. Workflow inspection MUST be distinct from node inspection and MUST NOT be inferred from the root composite node.
- Runtime workflow inspection MUST show actual `RunDetails.input` and final `RunDetails.output` when recorded. It MUST NOT derive partial workflow output from top-level node outputs while a run is active.
- Static workflow inspection MUST show workflow contract data: input schema when declared, the raw workflow `output: ExprIR`, and its `outputShape`. It MUST label the authored value as `Output Expression`, MUST NOT call it an output mapping, and MUST NOT show fake runtime values.
- Workflow-level Input/Output inspection MUST use the same docked inspector card and graph reflow behavior as node inspection.
- Runtime node inspection MUST resolve node instances, attempts, artifacts, and execution metadata against the current graph fanout/loop selector context. It MUST NOT show runtime output from another selected item or iteration.
- Runtime node inspection context MUST identify each fanout selection with a non-negative integer `itemIndex` and each loop selection with a non-negative integer iteration. The WebUI API MUST reject incomplete or malformed selector context.
- Runtime node inspection APIs MUST consume the shared runtime target inspection
  projection rather than independently resolving static nodes, dynamic
  instances, frames, attempts, signals, progress, execution metadata, or
  artifact references in the Web server.
- Runtime node Overview inspection MUST refresh once per second while the run
  is non-terminal and MUST stop periodic refresh after terminal state.
- Runtime Agent Overview data MUST use the authored Agent key and normalized
  compact Agent state supplied by runtime target inspection, including current
  activity, turn, context/token counters, and bounded recent tool commands.
  The Web server MUST NOT re-resolve the effective Agent or re-parse tool input
  previews for Overview.
- Node inspection MUST present a low-noise Overview with identity, status,
  prompt, input, output, and the shared structured failure where relevant. It
  MUST preserve upstream acpx/RPC cause fields without independently parsing
  provider error text, and MUST NOT expose generic raw `Instances`, `Frames`,
  `Signals`, or `Metadata` tabs.
- Artifact content MUST be shown in a conditional `Artifacts` tab for leaf nodes with artifacts, and artifact preview requests MUST be lazy-loaded from that tab. Artifact rows MUST truncate long artifact titles while exposing the full title on hover or keyboard focus, and artifact previews MUST stay inside the Inspector width without page-level horizontal overflow.
- Artifact rows and runtime inspection responses MUST expose the absolute `path`; they MUST NOT expose the runtime store's internal relative path.
- Artifact preview responses MUST cap the body at 128 KiB and MUST expose the preview media type through `Content-Type`.
- Agent execution telemetry MUST be shown in a conditional `Execution` tab for agent nodes. The tab MUST use semantic `agent_attempt` execution metadata and MUST refresh only while active.
- Artifact bodies and full Agent telemetry artifacts MUST NOT be embedded in the
  shared target inspection response. The Web server MUST load them only through
  the existing artifact preview or active Execution-tab paths.
- Agent execution MUST render semantic Context Window, Token Usage, and Last Tool Calls sections. It MUST NOT render raw telemetry JSON as the primary UI.
- Agent execution responses MUST contain only availability/reason, summary, last-active time, context-window usage, input/output/total token usage with source, streamed-output summary, tool-call count, and the recent tool-call fields rendered by the Execution tab.
- Task input MUST prefer selected-scope evaluated runtime input from `task_attempt` metadata, with authored input expression preview as fallback for unexecuted tasks.
- Prompt and structured output/error content MUST render through Markdown and JSON viewer components.
- Inspector key/value rows MUST expose full values on hover and keyboard focus. They MUST NOT rely on copy buttons as the primary way to read truncated values.
- Signal prompt information MUST appear only for signal nodes or selected signal waits, and artifacts MUST appear only when leaf-node artifacts exist.
- Runtime health responses MUST project checks to `area`, `status`, and `message`. Server config responses MUST contain only `cwd` and `access`.
- WebUI access MUST be open by default for all bind hosts, including network hosts.
- Token access MUST be explicit opt-in through the launcher/CLI and MUST NOT be inferred from `--host`.
- When token access is enabled, the launcher MUST generate a temporary token for that server start and the API MUST require it through the existing bearer/query/cookie token middleware.

## Verification

- Tests MUST cover static graph output without dynamic cardinality or runtime states.
- Tests MUST cover runtime graph containers, semantic edge endpoint validity, fanout item selector options, loop iteration selector options, nested occurrence isolation, and selected-runtime-state resolution.
- Tests MUST cover unified run graph API behavior, browser-read run/health/config projections, and the absence of a user-selectable runtime/static mode.
- Tests MUST cover workflow catalog listing, workspace file browsing safety, explicit static visualization, and self-contained HTML rendering with workflow metadata and contract data.
- Tests MUST cover nested composite graph rendering for `parallel`, `if`, `switch`, `fanout`, and `loop` with all branches visible.
- Tests MUST cover layout invariants for nested containers: every node placed, no overlapping leaves, and children contained by their parent.
- Tests MUST cover default fit-view math and rendered-edge filtering for containment edges.
- Tests MUST cover precise graph wheel zoom, wheel event consumption, inspector dock/undock animation hooks, and selected-node visibility after viewport resize.
- Tests MUST cover workflow-level Input/Output inspection for runtime run values and static workflow contract data.
- Tests MUST cover runtime node Overview delegation to the shared target
  projection, exact fanout/loop context forwarding, one-second non-terminal
  refresh, and terminal refresh cessation.
- Tests MUST prove artifact previews and Agent telemetry artifact reads remain
  lazy after adopting the shared target projection.
- Tests MUST cover WebUI control visibility, disabled terminal controls,
  target-first retry behavior, absence of WebUI fork control, closed request
  shapes, daemon readiness before submission, daemon intent mapping, and daemon
  error mapping.
- Tests MUST cover WebUI control confirmation text and command payloads before controls are submitted.
- Manual browser smoke SHOULD capture runtime and workflow static graph screenshots before handoff.
- Tests MUST cover open-by-default network host binding and explicit token-enabled access.
