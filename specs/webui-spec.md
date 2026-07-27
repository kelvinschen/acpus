# WebUI Spec

## Purpose

`@acpus/web` owns the local browser operator console for inspecting workflows and durable runs through the [Runtime](runtime-spec.md) public APIs. [WebUI Design](webui-design-spec.md) owns the shared visual and interaction language.

## Requirements

- The WebUI MUST expose one run graph surface per run.
- Static and runtime graphs MUST render the full canonical authored `WorkflowIR` topology.
- A runtime graph MUST add materialized occurrences and runtime state without removing or replacing authored nodes, branches, or scope containers.
- The run graph UI MUST NOT expose a Runtime/Static mode toggle.
- Runtime graph rendering MUST keep untaken or not-yet-reached branches visible as dimmed graph structure.
- Runtime graph rendering MUST visually distinguish node runtime states using exactly the display statuses `queued`, `running`, `awaiting`, `paused`, `completed`, `failed`, `canceled`, and `skipped`; internal `not_started` remains a weak dimmed state and MUST NOT render as a prominent status marker.
- Runtime graph rendering MUST derive `skipped` as a WebUI display state for terminal completed or canceled runs where a branch or descendant was not materialized because control flow chose another path. Failed-run downstream nodes that were merely never reached MUST remain not-started unless runtime data proves a skipped/canceled state.
- Runtime graph rendering SHOULD highlight active running or awaiting control-flow paths through subtle edge and ancestor-container emphasis when that emphasis preserves kind, status, and containment contrast; otherwise the base status presentation remains sufficient.
- Run-level running or awaiting status MUST use motion-aware living indicators in the runtime header and graph shell.
- Runtime graph status motion MUST respect `prefers-reduced-motion` while preserving non-motion color, glyph, label, and border affordances.
- Static workflow visualizations MUST NOT expose fanout item occurrences, loop iteration occurrences, dynamic statuses, attempts, frames, or signal waits as graph state.
- The WebUI MUST NOT expose Preflights or Settings navigation.
- The WebUI MUST expose Runtime and Workflows navigation. Run selection MUST remain inside Runtime.
- The React WebUI client MUST use shadcn/Radix primitives for standard interactive controls where a matching component exists, including dialogs, popovers, selects, tabs, buttons, and textareas. Hand-written interaction logic MAY remain only for Acpus-specific graph viewport gestures and renderer internals.
- Runtime status information for daemon, server access, workspace, and health MUST be available from the sidebar footer through a compact status affordance that opens an animated dialog-semantics popover.
- The WebUI shell MUST keep the sidebar fixed to the viewport height while page content scrolls inside the workspace area.
- The Workflows page MUST use the full available workspace width, with workflow source selection and graph visualization laid out as sibling columns on desktop viewports.
- The Workflows page MUST list project catalog entries without importing workflow modules, and catalog entries MUST be presented as a structured source list with workspace-relative path text.
- Project workflow catalog entries MUST contain only `name` and `entryPath`. Workspace file listings MUST contain the current workspace-relative `dir` and `entries`.
- The Workflows page MUST provide a dedicated workspace-only file picker for `.ts` and `.tsx` workflow sources, with breadcrumb navigation, current-directory filtering, and dense directory/workflow rows. It MUST reject path escapes.
- Selecting a workflow source MUST NOT compile or import it until the user explicitly requests visualization.
- Static workflow visualization APIs MUST run workflow preparation in memory and MUST NOT write durable preflight artifacts.
- A catalog or workspace visualization source that cannot be resolved before workflow preparation MUST return a failed visualization with phase `source`.
- Static workflow visualization failures MUST preserve compiler-owned `source`, `check`, `compile`, `lock`, and `validate` phases.
- The `@acpus/web` package root MUST expose only the runtime values `startWebServer`, `workflowIrToWebGraph`, and `renderWorkflowVizHtml`.
- `startWebServer` MUST return a tagged `listen-failed` Result when the requested listener cannot be established.
- Self-contained workflow visualization HTML MUST use the same WebUI static graph React component as the browser Workflows graph. It MUST remain a single offline HTML bundle without live WebUI API calls, and it MUST embed only the static graph runtime needed for graph rendering, static inspection, and workflow I/O.
- `renderWorkflowVizHtml` MUST receive canonical [Core](core-spec.md) `WorkflowIR` and source graph digest and MUST derive workflow metadata, workflow contract, and Web graph data internally. Its document title MUST use the workflow name.
- Self-contained workflow visualization HTML MUST embed the same graph and static Inspector styling as the browser Workflows graph.
- Composite nodes MUST render as scoped blocks that visually own nested leaf and composite nodes.
- A runtime fanout occurrence MUST expand every materialized item inside its canonical authored `do` scope.
- Each runtime fanout occurrence MUST render exactly one `do` scope and MUST NOT duplicate that scope for individual items.
- Each runtime fanout item occurrence MUST render the canonical authored descendants of the `do` scope under that item's exact context.
- A runtime fanout item occurrence MUST identify its item by non-negative `itemIndex`.
- A runtime fanout item occurrence label MUST use `item[N]`.
- Runtime fanout item occurrences MUST render in ascending `itemIndex` order.
- A runtime fanout item occurrence MUST carry its exact ancestor fanout-item and loop-iteration context plus its own fanout selection.
- Graph occurrence contexts MUST order selections from the outermost occurrence to the innermost occurrence.
- Runtime graph rendering MUST NOT invent an unmaterialized fanout item occurrence.
- Loop composites MUST use selectors over materialized loop iterations.
- Each loop selector MUST have a stable occurrence identity and the exact ancestor fanout-item and loop-iteration context of its loop occurrence.
- The browser MUST resolve a loop selector only against iterations belonging to that exact occurrence context.
- Loop composites MUST NOT render transition control fields in the graph header, and loop iteration selector labels MUST use compact `iter N` text for dynamic 0-based iteration identities.
- Fanout and loop composites MUST render their canonical `do` scope when no runtime item or selected iteration has a materialized child node execution.
- The graph API MUST return browser-ready containers and semantic control-flow edges. Edge endpoints MUST resolve to a returned node or container id.
- A graph response MUST contain workflow identity, mode, canonical authored nodes, canonical authored containers, semantic edges, `fanoutOccurrences`, loop selectors, and runtime states.
- A static graph response MUST return empty `fanoutOccurrences`, selectors, and runtime states.
- Each `fanoutOccurrences` entry MUST contain stable `id`, authored `nodeId`, canonical `do`-container `targetId`, exact ancestor `context`, occurrence `status`, and `items`.
- Each fanout occurrence item MUST contain stable `id`, `itemIndex`, `item[N]` label, item `status`, and exact context including that item.
- Fanout occurrence ids and fanout item ids MUST remain unique across nested contexts in one graph response.
- The graph response `selectors` collection MUST contain only loop selectors.
- Each loop selector MUST contain stable `id` and exact ancestor `context` in addition to its authored node and target identities and materialized iteration options.
- Loop selector ids MUST remain unique across nested contexts in one graph response.
- A runtime state MUST contain only `targetId`, `status`, and exact occurrence `context`.
- Runtime run graph data MUST be served through a run runtime snapshot API that returns run details, graph data, and run-level control applicability from one Runtime read snapshot. WebUI MUST NOT fetch run details and run graph through separate polling loops for the same runtime page.
- Run lists MUST project each run to `id`, `name`, and `status`. A runtime snapshot run MUST project only `id`, `name`, `status`, `input`, optional `output`, `createdAt`, `updatedAt`, and optional `runtimeVersion`.
- A runtime snapshot controls projection MUST contain only Runtime-approved exact retry targets and useful run-cancel applicability. Each retry target MUST contain a non-blank exact target, node/frame kind, and optional authored node id, without status rows, group-member identities, display labels, or additional Runtime fields.
- Runtime visualization overlays MAY expose semantic node detail derived from frozen `WorkflowIR`, but MUST NOT pre-render WebUI display strings.
- WebUI server code MUST own graph labels and Inspector definition, schema preview, expression preview, and template preview formatting.
- Browser HTTP transport MUST distinguish network failure, invalid JSON, invalid envelopes, and application request failures before the React Query adapter converts them to thrown query errors.
- Before returning a successful JSON API response to React Query, Browser HTTP transport MUST validate the payload against the endpoint's Web-owned result shape; a mismatch MUST be classified as `response-invalid-envelope`.
- Recoverable workflow browsing and preparation failures MUST remain tagged Results until the Hono adapter converts them to an HTTP response; permission, I/O, and other unknown failures MUST propagate to the redacted `500` boundary.
- Workflow browsing and file visualization MUST reject lexical or symlink-resolved paths outside the workspace.
- WebUI server code MUST read artifact bodies only through the [Runtime verified artifact reader](runtime-spec.md#read-apis-and-daemon-lifecycle).
- A Runtime artifact-read absence MUST map to `404`.
- A Runtime artifact durable-corruption rejection MUST map to the fixed, redacted `500` envelope.
- WebUI server code MUST NOT independently open an artifact record's public path or duplicate Runtime containment, file-type, size, or digest validation.
- Core, expression, and runtime packages MUST NOT expose public display-formatting APIs solely for WebUI graph labels.
- The graph API MUST NOT persist, store, or return layout coordinates. The browser owns deterministic layout, viewport, zoom, pan, and local selector state.
- The browser graph MUST expose local navigation through a searchable directory of rendered node occurrences, a selected-node containment breadcrumb, and a clickable minimap. These controls MUST update only local graph viewport or selection state.
- A graph node directory entry for a repeated occurrence MUST include its exact fanout-item or loop-iteration context. Structural containers MAY appear in the containment breadcrumb as focus targets, but MUST NOT open node inspection.
- The minimap MUST render actual node blocks and its viewport indicator, but MUST NOT render structural container outlines.
- The browser graph MUST use an Acpus-specific deterministic workflow renderer. It MUST NOT delegate canonical workflow layout to a general-purpose graph layout engine.
- The browser graph MUST use the graph API containers and semantic edges directly and MUST NOT reconstruct branch containers from raw static paths.
- The browser graph MUST render ordered sequential siblings left-to-right and sibling branch containers plus materialized fanout item occurrence lanes top-to-bottom inside their owning composite without wrapping.
- The browser graph MUST truncate long node labels, branch labels, and selector text inside their owning boxes so sibling graph elements do not overlap.
- The browser graph MUST NOT render authored node definitions such as Assert and If conditions, Fanout `over`, task inputs, Agent configuration, Signal schemas, or Switch case predicates; the selected node's Inspector MUST render its complete `NodeDetail` as Definition.
- Conditional branch container labels MUST be `then` and `else`; the condition MUST render only in the owning If node's Inspector.
- Switch case branch container labels MUST be zero-based `case 0`, `case 1`, `case 2`, and so on in authored order; the case predicates MUST render only in the owning Switch node's Inspector, while the fallback branch remains `default`.
- Parallel branch container labels MUST include `branch:`.
- Composite strategy MUST render as metadata adjacent to the node kind and MUST NOT replace the node name or kind badge.
- Graph node type identity MUST remain legible at fit-view through shared neutral surfaces plus medium-saturation leaf borders, composite-header accents, explicit kind badges, and distinct kind icons.
- Leaf graph node blocks MUST read as near-neutral raised surfaces with low-opacity, multi-layer blurred soft shadows; selection and status treatments MAY temporarily emphasize that base styling.
- Composite graph node blocks MUST use the shared neutral-surface and soft-elevation system while confining node-kind color to header icons, labels, badges, and transient hover or selection boundaries; dense nesting MAY use a stronger neutral boundary when required to keep containment legible.
- Branch, scope, and fanout item occurrence containers MUST remain neutral structural boxes and MUST NOT use node kind colors or card shadows.
- Inspectable leaf and composite nodes SHOULD expose a clear hover affordance through border, surface, or restrained movement.
- Every authored leaf and composite node block MUST expose an Inspector target. Structural graph containers remain non-inspectable.
- Structural graph containers MUST NOT use hover elevation, hover shadow, or hover border strengthening.
- Branch, scope, and fanout item occurrence containers MUST visually enclose their rendered descendants with structural padding; nested composites MUST NOT appear to touch or escape their owning container boundary. Scope containers such as fanout/loop `do` bodies MUST reserve enough padding for wide nested composites to read as contained structure, not as peer blocks.
- A static graph and a runtime graph with no running node occurrence MUST fit the complete workflow into the viewport on first layout, using only enough padding to keep the graph readable while maximizing canvas occupancy.
- On the first layout for a run with exactly one running node occurrence, the graph MUST focus that occurrence.
- On the first layout for a run with multiple running node occurrences, the graph MUST focus their deepest common ancestor in the rendered containment tree, treating the workflow surface as the root.
- The runtime graph toolbar MUST expose an explicit action that reapplies the same running-node focus rule.
- Running-node focus MUST select any materialized loop iterations required to reveal the active occurrences before calculating their focus target; polling alone MUST NOT change a user-selected historical iteration.
- The running-node focus action MUST be disabled when the graph has no running node occurrence.
- Runtime polling after the first layout MUST preserve the current viewport and MUST NOT automatically reapply running-node focus.
- The browser graph MUST support local pan and zoom without mutating runtime state or persisted graph data.
- The browser graph wheel or trackpad zoom MUST use small continuous increments.
- The browser graph MUST consume wheel and trackpad pinch gestures over the graph shell, including when already at zoom bounds, so those gestures do not trigger browser page zoom.
- Zoom-out controls MUST clamp scale to at least `0.75 * fitScale`, where `fitScale` is the scale that fits the complete workflow into the viewport.
- The browser graph MUST avoid parent-level CSS `scale(...)` for zoom-in rendering at scale `>= 1`; zoom-in MUST render nodes and edges from projected screen-space coordinates so text is not blurred by ancestor transforms.
- The browser graph MUST support pan gestures that start on graph nodes and containers, except when the gesture starts on interactive controls such as selectors, toolbar buttons, inputs, or links.
- Graph node backgrounds MUST remain in the shared neutral surface family and MUST NOT carry node-kind hue. Runtime status MUST remain outside the node background layer, and graph text MUST retain WCAG AA contrast.
- The browser graph SHOULD avoid background dot grids or other visual noise that reduce graph text readability. A spatial guide MAY appear only when it improves orientation without reducing text contrast.
- The browser graph MUST render arrows only for semantic control-flow between sibling endpoints. It MUST NOT render containment arrows from composite blocks or containers into their descendants.
- A semantic arrow between nested sibling endpoints MUST render above their shared structural container background and below its endpoint node blocks.
- Runtime loop selector choices MUST remain local UI state; changing a selector choice MUST NOT mutate runtime state. A closed loop selector MUST NOT render additional status dots beside the select control.
- Runtime page header, run controls, retry targets, and graph MUST consume the same runtime snapshot response for a run so displayed run status, graph node status, and run-level capability cannot drift across independently polled API versions.
- WebUI code MUST use `@acpus/runtime` public read/control APIs and MUST NOT query runtime SQLite tables directly.
- WebUI runtime controls MUST ensure the workspace daemon is ready, then submit one `DaemonControlIntent` through `requestDaemonControl`. WebUI server code MUST NOT apply runtime controls directly.
- WebUI control request bodies MUST be closed shapes: Pause and Resume contain only `type`; Retry contains `type` and a non-blank `target`; Cancel contains `type` and an optional non-blank `target`; Signal contains `type`, a non-blank `target`, and `payload`. A successful control response MUST contain only `{ ok: true }`.
- WebUI control failures with daemon code `RUN_NOT_FOUND` MUST map to HTTP 404 and error code `run_not_found`. Other daemon rejections MUST map to HTTP 400 with the daemon code normalized to lowercase snake case. The daemon error message MUST be preserved.
- Unexpected WebUI server failures MUST return a fixed `internal_error` response without exposing filesystem, process, or runtime details.
- WebUI runtime controls MUST NOT expose fork; fork remains a CLI/runtime control because replacement workflow, input, and agent overrides require explicit parameters.
- WebUI Pause and Resume controls MUST be mutually exclusive: active runs show Pause, paused runs show Resume, and terminal runs show neither.
- WebUI Retry MUST be target-first for failed runs. It MUST submit one exact Runtime-approved retry target and MUST NOT default to run-level retry.
- WebUI MUST use Runtime-projected retry/run-cancel applicability and MUST NOT reconstruct target legality from run status, failed dynamic rows, graph state, or authored ids. WebUI owns only product filtering, selection, labels, and confirmation copy.
- When multiple retry targets share one authored display label, WebUI MUST include each exact target key in its option and confirmation label.
- WebUI terminal run controls MUST render disabled or absent and MUST NOT submit controls for completed or canceled runs.
- When any node occurrence is selected, targeted Cancel MUST remain disabled unless Runtime target inspection returns an exact planner-approved cancel target. It MUST NOT fall back to the authored node id, including for a single unmaterialized occurrence.
- WebUI runtime operation buttons MUST require an explicit confirmation dialog before submitting pause, resume, retry, or cancel controls.
- Graph node inspection MUST render as a docked inspector card that occupies layout width on graph pages.
- Graph node inspection MUST render the selected graph node's display status in the primary Inspector header. Raw runtime `not_started` MUST NOT override a WebUI display-layer `skipped` state there. The secondary runtime header MUST contain only run metadata such as start time and duration before the Overview tabs.
- Authored branch containers, authored scope containers, and fanout item occurrence containers MUST remain structural and MUST NOT open node inspection.
- Structural graph containers MUST NOT use button roles or keyboard focus semantics that imply an Inspector target.
- Repeated node occurrence controls MUST include exact occurrence context in their accessible names, and a loop iteration selector MUST NOT be nested inside the node's inspect button semantics.
- Opening or closing graph node inspection MUST cause the graph viewport to reflow within the remaining available space; closing MUST animate the inspector track and graph width together so the graph does not jump after the card disappears.
- Inspector docking and undocking SHOULD animate as a short product UI transition and MUST respect reduced-motion preferences.
- When a graph node is selected and the inspector opens or the graph viewport resizes, the selected node MUST remain visible in the graph viewport with reasonable margin.
- Graph pages MUST expose a workflow-level Input/Output inspection target from the graph toolbar. Workflow inspection MUST be distinct from node inspection and MUST NOT be inferred from the root composite node.
- Runtime workflow inspection MUST show actual `RunDetails.input` and final `RunDetails.output` when recorded. It MUST NOT derive partial workflow output from top-level node outputs while a run is active.
- Static workflow inspection MUST show declared input schema, raw `output: ExprIR`, and `outputShape`, label the authored value `Output Expression`, and omit invented runtime values or output-mapping terminology.
- Workflow-level Input/Output inspection MUST use the same docked inspector card and graph reflow behavior as node inspection.
- A rendered runtime node occurrence MUST expose an Inspector target containing its authored node identity and exact ordered fanout-item and loop-iteration context.
- Runtime node inspection MUST resolve node instances, attempts, artifacts, and execution metadata against the selected node occurrence's exact context.
- Runtime node inspection MUST NOT show runtime output from another fanout item or loop iteration.
- Runtime node inspection context MUST identify each fanout selection with a non-negative integer `itemIndex` and each loop selection with a non-negative integer iteration.
- The WebUI API MUST reject incomplete or malformed inspection context.
- Runtime node inspection APIs MUST consume the shared runtime target inspection projection rather than independently resolving static nodes, dynamic instances, frames, attempts, signals, progress, execution metadata, or artifact references in the Web server.
- Runtime node inspection HTTP responses MUST be closed Web-owned projections containing only the node and frame identity, optional exact cancel target, runtime timing, latest attempt, compact Agent identity, selected input, prompt, loop progress, output, structured failure, public artifact identity, and optional actionable Signal fields used by the Inspector.
- Runtime node inspection HTTP responses MUST NOT expose Runtime inspection schema markers, run, target, static-node document, raw items, instances, frames, attempts, signal waits, execution metadata, progress, registry artifact fields, or unrendered Agent telemetry.
- An actionable Signal projection MUST use the normalized target inspection Signal only when its normalized node status is `awaiting`. An aggregate target without one normalized Signal action MUST omit the action rather than select an arbitrary dynamic wait.
- Runtime node Overview inspection MUST refresh once per second while the run is non-terminal and MUST stop periodic refresh after terminal state.
- Runtime Agent Overview data MUST use the authored Agent key, model, and last-observed time from normalized compact Agent state supplied by runtime target inspection. Turn, context-window, token-usage, output, and tool telemetry MUST remain in the lazy Execution response and MUST NOT be duplicated in Overview. The Web server MUST NOT re-resolve the effective Agent or re-parse tool input previews for Overview.
- Node inspection MUST present a low-noise Overview with identity, status, prompt, input, output, and the shared structured failure where relevant. It MUST preserve upstream acpx/RPC cause fields without independently parsing provider error text, and MUST NOT expose generic raw `Instances`, `Frames`, `Signals`, or `Metadata` tabs.
- Artifact content MUST appear in a lazy-loaded `Artifacts` tab only for leaf nodes with artifacts; rows truncate long titles with hover/focus disclosure, and previews stay within the Inspector width.
- WebUI artifact rows MUST project the public `path` from the [Runtime-owned artifact record](runtime-spec.md#read-apis-and-daemon-lifecycle) and MUST omit internal storage coordinates.
- Artifact preview responses MUST cap the body at 128 KiB.
- Artifact preview `Content-Type` MUST prefer the registered media type and otherwise fall back to the public path extension.
- Agent execution details MUST be shown in a conditional `Execution` tab for Agent nodes.
- The Agent Execution tab MUST consume Runtime execution inspection for the exact selected context and MUST NOT derive execution telemetry from Runtime details arrays.
- The Agent Execution tab MUST refresh only while its Runtime execution status is `starting`, `ready`, `running`, or `awaiting`.
- The Web execution endpoint MUST project the Runtime execution document field by field and MUST NOT read Agent turn artifacts, Private Turn Evidence, Trace, or any other artifact body.
- The Web execution endpoint MUST map Runtime `target-ambiguous` failures to HTTP 409 with error code `target_ambiguous`.
- An artifact-backed Agent prompt descriptor with `field: "prompt"` MUST be resolved through the Runtime verified artifact reader and rendered as exact Markdown text.
- An artifact-backed Agent prompt read MUST NOT use the 128 KiB generic artifact preview limit.
- Agent execution MUST render semantic Context Window, Token Usage, and Last Tool Calls sections. It MUST NOT render raw turn JSON as the primary UI.
- Agent execution responses MUST use this closed Web-owned shape.

```ts
type NodeExecutionInspection = ({
  available: true;
  reason?: never;
} | {
  available: false;
  reason: string;
}) & {
  summary: {
    status: RunInspectionStatus;
    sessionName?: string;
    turnCount?: number;
    message?: string;
  };
  lastObservedAt?: string;
  contextWindow?: {
    used?: number;
    size?: number;
    percent?: number;
    updatedAt?: string;
  };
  tokenUsage?: {
    source?: "prompt_response" | "usage_update";
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
  output?: {
    tail: string;
    totalBytes: number;
    truncated: boolean;
  };
  toolCallCount?: number;
  lastToolCalls: Array<{
    turn: number;
    toolCallId?: string;
    toolName?: string;
    status?: string;
    durationMs?: number;
    inputPreview?: string;
  }>;
  recentToolsIncomplete: boolean;
};
```

- Agent execution responses MUST NOT expose Runtime schema markers, run, subject, details arrays, registry fields, or unrendered telemetry.
- The browser decoder MUST reject unrecognized root, summary, context-window, token-usage, output, or tool-call fields; invalid availability/reason combinations; malformed or negative metrics; and more than three recent tool calls.
- When `recentToolsIncomplete` is true, the Execution tab MUST identify retained tool details as incomplete. An empty partial list MUST NOT render the definitive `No tool calls` state.
- Task input MUST prefer selected-scope evaluated runtime input from `task_attempt` metadata, with authored input expression preview as fallback for unexecuted tasks.
- Prompt and structured output/error content MUST render through Markdown and JSON viewer components.
- Inspector key/value rows MUST expose full values on hover and keyboard focus. They MUST NOT rely on copy buttons as the primary way to read truncated values.
- Signal prompt information MUST appear only for signal nodes or selected signal waits, and artifacts MUST appear only when leaf-node artifacts exist.
- Runtime health responses MUST project checks to `area`, `status`, and `message`. Server config responses MUST contain only `cwd` and `access`.
- WebUI access MUST be open by default for all bind hosts, including network hosts.
- Token access MUST be explicit opt-in through the launcher/CLI and MUST NOT be inferred from `--host`.
- When token access is enabled, the launcher MUST generate a temporary token for that server start and the API MUST require it through the existing bearer/query/cookie token middleware.

## Verification

- `pnpm test:unit packages/web`: verifies browser JSON transport classification and endpoint payload validation, closed Runtime-control, node-inspection, and Agent-execution projections and decoders, honest partial recent-tool UI, exact retry ordering, Runtime-gated run cancellation, canonical static/runtime topology, single-scope fanout expansion, exact loop and Inspector contexts, deterministic layout, running-node focus, viewport preservation, and structural-container semantics.
- `pnpm test:contract packages/web`: verifies graph response shapes, unified runtime snapshots with exact controls, workflow browsing, closed node-inspection responses with exact selected-target cancellation, Runtime-owned occurrence-exact Agent execution without artifact reads, inspection context, controls, verified prompt/artifact-reader delegation and error mapping, and access behavior.
- `pnpm test:integration packages/web`: verifies selected workflow source resolution, in-memory compiler preparation, and static visualization projection as one real seam.
- Manual browser review verifies representative graph, Inspector, dynamic fanout, running focus, and reduced-motion states.
