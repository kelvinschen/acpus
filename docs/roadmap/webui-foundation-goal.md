# WebUI Foundation Goal

This document records the accepted direction and open design questions for the
Acpus WebUI foundation. It is a roadmap goal record, not current product truth.
Implemented behavior belongs in `specs/` after implementation lands.

The immediate purpose is to preserve the decisions from the WebUI foundation
brainstorm so the next discussion can focus on technology choices for the local
web service and frontend.

## Decision Status

- [x] Product shape accepted: the WebUI starts as a local-first operator
  console, not a hosted team service.
- [x] Scope accepted: v1 focuses on run observation, run controls, node
  inspection, daemon health/status info, and explicit static workflow
  visualization.
- [x] Static visualization accepted: WebUI and CLI visualization prepare
  workflow source in memory on explicit user action; `workflows check` no
  longer writes durable preflight artifacts.
- [x] Package boundary accepted: create a new `@acpus/web` package. The `acpus`
  CLI may expose a thin launcher such as `acpus web`.
- [x] Service framework accepted: Hono is acceptable for the local HTTP server
  and API routing layer.
- [x] Runtime data boundary accepted: web code reads run data through
  `@acpus/runtime` public APIs rather than querying SQLite directly.
- [x] Sync model accepted: v1 uses REST reads with polling versions/cursors, not
  SSE or WebSocket.
- [x] Unified run graph accepted: the Runtime page shows one canonical workflow
  graph with runtime overlay when dynamic state exists. Static definition
  visualization lives under Workflows and CLI HTML bundle generation.
- [x] Nested dynamic graph direction accepted: use scoped composite blocks with
  fanout item and loop iteration selectors instead of forcing one fully expanded
  graph.
- [x] Layout boundary accepted: the server returns graph data, not coordinates;
  frontend owns deterministic layout and local viewport state.
- [x] Node inspection accepted: show metadata and artifact references by
  default; fetch prompt, response, stderr, telemetry, and artifact contents
  lazily with preview limits.
- [x] Control boundary accepted: UI actions should forward typed control intents
  to the local daemon socket and must not advance scheduler work inside the web
  server.
- [x] Daemon lifecycle direction accepted: control paths should start/wake the
  local daemon when needed, while read-only views stay read-only and surface
  daemon health.
- [x] Local access direction accepted: bind localhost by default; token access is
  explicit opt-in and is not inferred from the bind host.
- [x] Frontend stack accepted: React, Vite, TypeScript, TanStack Query, an
  Acpus-specific deterministic graph renderer, Tailwind CSS, shadcn/ui, and
  lucide-react form the v1 baseline.
- [x] Design direction accepted: use the Terra organic design direction,
  adapted for an operator console.
- [x] Runtime page layout accepted: the primary Runtime page is centered on the
  currently selected run and does not include dashboard metric cards such as
  running runs, awaiting signals, failed runs, or completed today.
- [x] Navigation scope accepted: Signals and Runtime Ops are not standalone v1
  pages. Signal handling and runtime controls live inside the Runtime page.
- [x] Detailed graph renderer direction accepted: use an Acpus-specific
  deterministic renderer with local fit, zoom, pan, selector state, and
  browser-owned layout.
- [x] Display formatting boundary accepted: runtime exposes semantic frozen-run
  visualization data, while `@acpus/web` owns browser graph labels and previews.

## Background

Acpus already has the runtime facts needed for a useful operator console:

- admitted runs freeze `WorkflowIR`, input, lock metadata, digests, and run-local
  directories;
- the runtime store persists runs, public run events, scheduler projection
  rows, dynamic frames, node instances, attempts, group members, signal waits,
  execution metadata, daemon liveness diagnostics, and artifacts;
- runtime public APIs already expose run lists, run details, health checks,
  daemon control clients, and a visualization overlay helper that combines
  frozen IR structure with dynamic scheduler projection state;
- workflow preparation returns frozen IR, lock metadata, and digests in memory.

The screenshot used in discussion was not treated as a design file. It served
only to name the important product elements:

- Run Graph visualization;
- Node Inspection;
- Runs history and control feedback.

The main foundation question is therefore not whether data exists. It is how to
shape a web-facing control plane without leaking runtime internals into the
frontend or turning the runtime package into a UI package.

## Goal

Create a local web foundation that can support:

- a Runtime workbench centered on the currently selected run, including run
  identity, run status, freshness/version metadata, graph, inspection, control
  feedback, and runtime controls;
- a Runs page for selecting and filtering historical runs;
- a unified Run Graph with status rollups, scoped composite blocks, fanout item
  and loop iteration selectors, and selected-node
  synchronization with inspection;
- Node Inspection for static nodes, dynamic node instances, attempts, signal
  waits, outputs, errors, execution metadata, and artifacts;
- daemon control feedback for pause, resume, retry, cancel, and signal actions;
- a Workflows page and `workflows viz` command for static graph visualization.

The first web surface should feel like a run-focused operator workbench. It is
not a marketing page, hosted service, workflow editor, full authoring
environment, or generic multi-run business dashboard.

## Accepted Architecture Direction

### Package And Process Boundary

Add a new `@acpus/web` package that owns:

- the Hono app and local HTTP server;
- web API route handlers and view-model builders;
- static frontend assets and development/build integration;
- graph and inspector response shapes intended for browser consumption.

The existing `acpus` CLI should only launch the web service and print/open the
local URL. CLI command behavior and runtime behavior remain in their current
packages.

### Data Sources

Run data comes from `@acpus/runtime` public APIs. If the web experience needs a
generic read capability that runtime does not expose yet, the preferred follow-up
is a small runtime read API, not direct SQL inside `@acpus/web`.

Static workflow visualization runs workflow preparation in memory only after an
explicit user action. It does not read or write durable preflight artifacts.

### API And Synchronization

The initial API is REST-first. Responses include enough freshness information
for polling:

- runs list: updated time/count metadata;
- run detail and graph: runtime dynamic version when projection rows exist;
- control feedback: daemon `applied`/`failed` responses, or a browser-facing
  client timeout when control application is not confirmed within the wait
  window.

Candidate API families:

- `GET /api/health`;
- `GET /api/runs`;
- `GET /api/runs/:id`;
- `GET /api/runs/:id/graph`;
- `GET /api/runs/:id/nodes/:target`;
- `POST /api/runs/:id/controls` as a browser-facing route that forwards to the
  runtime daemon socket;
- `GET /api/runs/:id/artifacts/:artifactId/preview`;
- `GET /api/workflows/catalog`;
- `GET /api/workflows/files`;
- `POST /api/workflows/visualize`.

SSE/WebSocket invalidation is a later enhancement. The v1 contract should not
depend on it.

### Graph Model

The graph contract has two explicit modes:

- Static definition view: derived from `WorkflowIR`; fanout and loop cardinality
  are unknown, and switch branches represent possible paths.
- Runtime execution view: derived from frozen IR plus scheduler projections;
  materialized fanout items, loop iterations, selected switch branches, attempts,
  and signal waits can be shown where execution has reached them.

Composite nodes use scoped blocks. A composite block visually owns its nested
steps with a scoped background, border treatment, title row, and local status
rollup. Nested static structure remains visible inside the block instead of
being hidden behind a generic folded node.

Static composites such as `parallel` and `switch` can expand their known nested
steps directly inside the scoped block. Branch labels and selected switch paths
should be visible where runtime projection data exists.

Dynamic composites use a canonical shape with an instance selector:

- `fanout` shows one item-shaped nested graph because every item has the same
  workflow shape. The block shows item count, status rollup, and an index/key
  selector for choosing which materialized item supplies runtime state.
- `loop` shows one iteration-shaped nested graph. The block shows loop status,
  iteration count/current iteration, and an iteration selector. Loop semantics
  should be visible through iconography and subtle loop/return-line styling, not
  by duplicating the same shape for every iteration.

For large dynamic runs, the graph should keep the canonical shape stable and
move instance navigation into selectors, search, and inspector details rather
than drawing every fanout item or loop iteration at once.

The backend should not persist or return layout coordinates. The frontend owns
deterministic layout, zoom, fit, pan, and local expansion state.

### Node Inspection And Artifacts

Node Inspection uses a common inspector shell with a header and type-specific
tabs. The header starts from metadata:

- static node id and kind;
- dynamic node key or frame key when selected;
- status, status reason, outputs, and errors;
- attempts and deadlines;
- signal waits and actionable signal targets;
- agent execution metadata;
- artifact references.

Inspector tabs should not introduce an `Events` or `Logs` product surface in
v1.

Agent inspection tabs:

- `Prompt & Output`: rendered prompt, output after completion, and failure or
  response-repair status when relevant.
- `Execution`: context window, token usage, latest tool-call summary, turn
  count, session/model/cwd, attempts, deadlines, and timing.
- `Artifacts`: prompt, response, stderr, telemetry, raw parsed output, and raw
  ACP debug artifact references when present.

Task inspection tabs:

- `Input & Output`: evaluated task input JSON, output after completion, and
  failure details.
- `Artifacts`: task-written artifact references and previews.
- `Execution`: attempt, cwd/env summary, deadline, timing, and status reason.

Signal inspection tabs:

- `Prompt & Payload`: rendered prompt, awaiting state, payload submission action
  when open, and consumed payload/output after completion.
- `Schema`: expected payload shape and validation guidance when a schema exists.
- `Execution`: wait timing, deadline/timeout state, selected target identity,
  and terminal reason when present.

Composite inspection tabs:

- `Overview`: scoped block identity, status rollup, selected fanout item or loop
  iteration, and runtime/static mode context.
- `Children`: child steps, branch/item/iteration status table, and navigation to
  a selected nested node.
- `Execution`: frame status, strategy, timing, result/error where available, and
  dynamic frame or group-member details.

Artifact content is loaded lazily. Preview endpoints should enforce registry
lookup, run-local path resolution, media type handling, and max preview bytes.
Prompt, response, stderr, telemetry, raw parsed output, and raw ACP debug
artifacts are inspection data, not graph data.

Task evaluated input, artifact previews, and agent artifact contents require a
runtime or web read model. WebUI code must not recover them by importing live
workflow source or querying SQLite directly.

### Controls And Daemon

UI actions submit typed control intents to the web server. The web server
forwards those intents to the local runtime daemon socket and returns either the
daemon's `applied` result, the daemon's `failed` error, or a client-side timeout
when application is not confirmed within the wait window. Timeout feedback is a
client outcome, not runtime state.

Control paths can follow the CLI pattern and ensure the local daemon is running
before sending daemon control. Read-only pages and polling reads must not start
or wake the daemon. The UI should still make daemon health and operational state
visible.

If daemon shutdown is exposed, it is a service lifecycle action only. It must
not cancel, pause, fail, or otherwise mutate runs, and it should fail or be
disabled while active run execution sessions exist.

### Local Access

The default bind target is localhost. Binding to a network host remains open
unless the user explicitly enables token access. When token access is enabled,
the launcher generates a temporary token and requires it for browser/API access
without introducing accounts or role-based access control in v1.

## Accepted Technology Baseline

The accepted v1 baseline is:

- Hono and `@hono/node-server` for the local HTTP app, routing, middleware, and
  static asset serving.
- React, Vite, and TypeScript for the browser application.
- TanStack Query for REST data fetching, polling intervals, mutation feedback,
  and cache invalidation.
- An Acpus-specific deterministic graph renderer for workflow structure,
  node/container rendering, semantic edges, selection, and local selector
  state.
- Tailwind CSS v4 for styling and design tokens.
- shadcn/ui as the component source model, with local component code owned by
  `@acpus/web` rather than opaque imported widgets.
- lucide-react for icons in buttons, tabs, status controls, graph affordances,
  and navigation.
- Vitest for route, view-model, and component-level tests, with browser smoke
  tests added once the UI shell stabilizes.

## Accepted Design Direction

The accepted visual direction is **Terra — Organic Design**.

North star: **Rooted Warmth**. The UI should feel calm, grounded, and human.
Earthy tones, soft shapes, and natural textures should create a warm,
approachable operator-console experience without reducing operational clarity.

### Palette

- Primary: forest green `#4a7c59` for primary actions, navigation, focus states,
  and interactive states.
- Background: warm cream `#faf6f0`, organic and never sterile white.
- Tertiary: warm amber `#705c30` for highlights, accents, and badges.
- Surface: layered warm cream tones for panels and cards, preferring tonal
  separation over shadows.
- Border: low-opacity `outline_variant` when a boundary is needed.
- Text should stay warm and grounded; muted text and grays should carry
  yellow/green undertones instead of cool slate or blue-gray.
- Palette philosophy: earthy and desaturated. Avoid neon, pure-hue colors, hard
  contrast, and clinical tech-stock color treatments.

### Typography

- Headlines and major numeric summaries use Literata for a warm serif voice with
  personality.
- Body text, labels, tables, controls, and graph node metadata use Nunito Sans
  for friendly, rounded readability.
- Monospace content uses `ui-monospace`, `SFMono-Regular`, Menlo, Monaco,
  Consolas, Liberation Mono, Courier New, then `monospace`.
- Body content should use generous line-height, at least `1.6`, so dense runtime
  data still feels comfortable and unhurried.
- Compact panels and graph labels stay restrained so type does not overwhelm
  operational data.

### Components And Surfaces

- Buttons use large touch targets and `12px` radius. Primary buttons are solid
  forest green; secondary buttons use a cream background, green text, and a thin
  warm border.
- Cards and panels use warm cream fills, `24px` padding, `12px` rounded corners,
  and no harsh borders.
- Elevation is very soft: `0 4px 20px rgba(46, 50, 48, 0.06)`. Prefer tonal
  separation over shadows wherever possible.
- Inputs use cream backgrounds, rounded corners, soft borders, and soft green
  focus rings.
- Pure white is reserved for rare high-contrast needs such as dense code/text
  preview backgrounds, not ordinary layout surfaces.
- Links use underlines on hover instead of heavy button styling.
- Spacing should be breathable, with generous hit areas and comfortable gaps.
- Avoid sharp corners and hard contrasts. Everything should feel soft and
  approachable while preserving scanability.
- Images should feel natural and warm; avoid clinical or generic tech-stock
  imagery.

### Tailwind Token Sketch

The design token direction can be represented as:

```ts
theme: {
  extend: {
    colors: {
      terra: {
        primary: "#4a7c59",
        bg: "#faf6f0",
        tertiary: "#705c30",
        surface: "#f4ede3",
        surfaceMuted: "#eee5da",
        outlineVariant: "rgb(112 92 48 / 0.18)",
        text: "#2e322f",
        muted: "#6f746c",
        success: "#4a7c59",
        warning: "#705c30",
        danger: "#a14f45",
      },
    },
    fontFamily: {
      sans: ["Nunito Sans", "sans-serif"],
      serif: ["Literata", "serif"],
      mono: [
        "ui-monospace",
        "SFMono-Regular",
        "Menlo",
        "Monaco",
        "Consolas",
        "Liberation Mono",
        "Courier New",
        "monospace",
      ],
    },
    borderRadius: {
      xl: "0.75rem",
      "2xl": "0.75rem",
    },
    boxShadow: {
      DEFAULT: "0 4px 20px rgba(46, 50, 48, 0.06)",
    },
  },
}
```

### Operator Console Adaptation

Terra should not reduce the console to a decorative lifestyle surface. The
first screen still prioritizes the working surface:

- The Runtime page is centered on one selected run and its current execution
  state.
- Run Graph remains the main visual object.
- Node Inspection stays adjacent to the graph.
- Daemon control feedback and runtime controls remain available without navigation
  churn.
- Signal payload submission appears as an in-context Runtime action for
  awaiting signal nodes, not as a separate Signals page.
- Daemon health, idle state, and bounded lifecycle actions appear as Runtime
  status/actions, not as a separate Runtime Ops page.
- Global metric cards such as running runs, awaiting signals, failed runs, and
  completed today are not part of the Runtime page.
- Spacing is generous and breathable, but repeated operational workflows should
  remain efficient.
- Color is semantic first: completed/running/awaiting/failed states need clear
  distinctions while staying inside the earthy, desaturated palette.

## Accepted Information Architecture

The v1 navigation model is intentionally small:

- Runtime: the primary selected-run workbench. It contains run identity,
  status/version metadata, graph, node inspection, signal actions,
  daemon-backed runtime controls, control feedback, and daemon status/actions.
- Runs: a list/search/filter surface for selecting a run to inspect in Runtime.
- Workflows: project catalog and workspace file selection for explicit static
  visualization.

Signals is not a standalone page. Runtime Ops is not a standalone page.
Global dashboard metric cards are not part of the Runtime page.

## Out Of Scope For This Goal

- Hosted team server, shared workspaces, multi-user auth, or RBAC.
- Workflow authoring or editing.
- Direct SQLite queries from frontend or web package code.
- HTTP daemon control protocol, offline control request/status queue, or legacy
  control-plane compatibility layer.
- Persisted user graph coordinates or drag-to-save layout.
- SSE/WebSocket as a required v1 primitive.
- Legacy YAML workflow compatibility or legacy UI behavior.
- A global dashboard surface optimized around aggregate metric cards.
- Standalone Signals or Runtime Ops pages in v1.

## Remaining Technology Questions

These are the intended next decisions before implementation planning:

- Package build shape for `@acpus/web`: server build, frontend build, static
  asset location, and local dev workflow.
- Exact Hono middleware shape for explicit token access, static asset
  fallback, route errors, and preview limits.
- Daemon lifecycle helper shape for `@acpus/web`: reuse the CLI-private
  start/wake pattern, add a small `@acpus/runtime` public helper, or keep a web
  owned launcher.
- Runtime read API gaps: bounded run listing, filtering/search,
  artifact metadata/content preview, and frozen graph/lock details.
- Control request view-model shape over low-level daemon intents, including
  request id generation, target validation UX, stable daemon error mapping, and
  client-side timeout display.
- Component inventory for the first shell: sidebar, toolbar, cards, tables,
  tabs, inspector sections, control feedback, artifact preview, and modals.
- Graph interaction details: scoped block styling, fanout item selector, loop
  iteration selector, minimap placement, fit-view behavior, selection sync,
  keyboard affordances, and large-run degradation.
- Inspector view-model details: tab payloads for Agent, Task, Signal, and
  Composite nodes, plus empty/running/failed/completed states for each tab.
- Polling intervals by screen state: active run, terminal run, runs list,
  health, control feedback, and artifact previews.
- Whether browser smoke tests start with Playwright, Vitest Browser Mode, or a
  smaller screenshot-free route/component test layer first.

## Verification Themes For The Future Implementation

- Graph view-model tests for static graphs, runtime overlays, nested
  fanout/switch, loops, mixed statuses, scoped blocks, canonical fanout item
  shape, and canonical loop iteration shape.
- Web API contract tests for success shapes, tagged error shapes, polling
  versions, daemon-forwarded control submission, client-side timeout mapping,
  and workflow static visualization.
- Integration tests using runtime fixtures while keeping web code behind runtime
  public APIs.
- Artifact preview tests for media type limits, size truncation, unsupported
  content, and run-local registry enforcement.
- Inspector view-model tests for Agent, Task, Signal, and Composite tab payloads
  without introducing Events or Logs as v1 surfaces.
- Frontend smoke/component states for empty workspace, active run, awaiting
  signal, failed node, completed run, malformed workflow visualization, and
  unavailable artifact preview.
