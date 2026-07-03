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
  inspection, supervisor health, and static preflight graph preview.
- [x] Static preview accepted: preview reads existing preflight artifacts under
  `.acpus/.local/preflight/`; the WebUI does not run workflow preparation in v1.
- [x] Package boundary accepted: create a new `@acpus/web` package. The `acpus`
  CLI may expose a thin launcher such as `acpus web`.
- [x] Service framework accepted: Hono is acceptable for the local HTTP server
  and API routing layer.
- [x] Runtime data boundary accepted: web code reads run data through
  `@acpus/runtime` public APIs rather than querying SQLite directly.
- [x] Sync model accepted: v1 uses REST reads with polling versions/cursors, not
  SSE or WebSocket.
- [x] Graph modes accepted: distinguish static definition view from runtime
  execution view.
- [x] Nested dynamic graph direction accepted: use scoped expansion for fanout
  items, loop iterations, and composite frames instead of forcing one fully
  expanded graph.
- [x] Layout boundary accepted: the server returns graph data, not coordinates;
  frontend owns deterministic layout and local viewport state.
- [x] Node inspection accepted: show metadata and artifact references by
  default; fetch prompt, response, stderr, telemetry, and artifact contents
  lazily with preview limits.
- [x] Control boundary accepted: UI actions submit durable runtime commands and
  do not advance scheduler work inside the web server.
- [x] Supervisor direction accepted: auto-start the detached supervisor when a
  command leaves runnable work, while still surfacing supervisor health and
  operations.
- [x] Local access direction accepted: bind localhost by default; when binding a
  network host, require a generated token.
- [x] Frontend stack accepted: React, Vite, TypeScript, TanStack Query, React
  Flow, elkjs, Tailwind CSS, shadcn/ui, and lucide-react form the v1 baseline.
- [x] Design direction accepted: use the Sahara warm minimalism direction,
  adapted for an operator console.
- [x] Runtime page layout accepted: the primary Runtime page is centered on the
  currently selected run and does not include dashboard metric cards such as
  running runs, awaiting signals, failed runs, or completed today.
- [x] Navigation scope accepted: Signals and Runtime Ops are not standalone v1
  pages. Signal handling and runtime controls live inside the Runtime page.
- [ ] Detailed frontend packaging, component inventory, and graph interaction
  behavior remain open for implementation planning.

## Background

Acpus already has the runtime facts needed for a useful operator console:

- admitted runs freeze `WorkflowIR`, input, lock metadata, digests, and run-local
  directories;
- the runtime store persists runs, public run events, scheduler projection
  rows, dynamic frames, node instances, attempts, group members, signal waits,
  execution metadata, commands, supervisor leases, and artifacts;
- runtime public APIs already expose run lists, run details, health checks,
  durable controls, and a visualization overlay helper that combines frozen IR
  structure with dynamic scheduler projection state;
- workflow preflight writes `workflow.ir.json` and `lock.json` under
  `.acpus/.local/preflight/<id>/`.

The screenshot used in discussion was not treated as a design file. It served
only to name the important product elements:

- Run Graph visualization;
- Node Inspection;
- Runs history and command feedback.

The main foundation question is therefore not whether data exists. It is how to
shape a web-facing control plane without leaking runtime internals into the
frontend or turning the runtime package into a UI package.

## Goal

Create a local web foundation that can support:

- a Runtime workbench centered on the currently selected run, including run
  identity, run status, freshness/version metadata, graph, inspection, command
  feedback, and runtime controls;
- a Runs page for selecting and filtering historical runs;
- a Run Graph with static/runtime modes, status rollups, scoped expansion, and
  selected-node synchronization with inspection;
- Node Inspection for static nodes, dynamic node instances, attempts, signal
  waits, outputs, errors, execution metadata, and artifacts;
- command feedback for pause, resume, retry, cancel, signal, and future fork
  actions;
- static graph preview for already-written preflight artifacts.

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

Static preflight preview reads existing preflight artifacts:

- `.acpus/.local/preflight/<id>/workflow.ir.json`;
- `.acpus/.local/preflight/<id>/lock.json`.

V1 does not compile, typecheck, import, or prepare workflow modules from the web
service. Users continue to use CLI check/preflight commands to create preview
artifacts.

### API And Synchronization

The initial API is REST-first. Responses include enough freshness information
for polling:

- runs list: updated time/count metadata;
- run detail and graph: runtime dynamic version when projection rows exist;
- command feedback: command status and update time where available.

Candidate API families:

- `GET /api/health`;
- `GET /api/runs`;
- `GET /api/runs/:id`;
- `GET /api/runs/:id/graph?mode=static|runtime`;
- `GET /api/runs/:id/nodes/:target`;
- `POST /api/runs/:id/commands`;
- `GET /api/runs/:id/artifacts/:artifactId/preview`;
- `GET /api/preflights`;
- `GET /api/preflights/:id/graph`.

SSE/WebSocket invalidation is a later enhancement. The v1 contract should not
depend on it.

### Graph Model

The graph contract has two explicit modes:

- Static definition view: derived from `WorkflowIR`; fanout and loop cardinality
  are unknown, and switch branches represent possible paths.
- Runtime execution view: derived from frozen IR plus scheduler projections;
  materialized fanout items, loop iterations, selected switch branches, attempts,
  and signal waits can be shown where execution has reached them.

Nested dynamic execution uses scoped expansion. For example, a `fanout` that
contains a `switch` should default to a readable folded fanout node. Expanding a
specific item/frame reveals that item's nested switch path and child nodes.

The backend should not persist or return layout coordinates. The frontend owns
deterministic layout, zoom, fit, pan, and local expansion state.

### Node Inspection And Artifacts

Node Inspection starts from metadata:

- static node id and kind;
- dynamic node key or frame key when selected;
- status, status reason, outputs, and errors;
- attempts and deadlines;
- signal waits and actionable signal targets;
- agent execution metadata;
- artifact references.

Artifact content is loaded lazily. Preview endpoints should enforce registry
lookup, run-local path resolution, media type handling, and max preview bytes.
Prompt, response, stderr, telemetry, raw parsed output, and raw ACP debug
artifacts are inspection data, not graph data.

### Controls And Supervisor

UI actions submit durable runtime command rows through runtime control APIs.
The web server does not mutate scheduler projection tables and does not drive
scheduler advancement itself.

When a command leaves runnable work, the web service can follow the CLI pattern
and ensure the detached supervisor is running. The UI should still make
supervisor health and operational state visible.

### Local Access

The default bind target is localhost. If a user explicitly asks to expose the
server on a network host, the launcher should generate a token and require it
for browser/API access. This protects local run controls and artifact previews
without introducing accounts or role-based access control in v1.

## Accepted Technology Baseline

The accepted v1 baseline is:

- Hono and `@hono/node-server` for the local HTTP app, routing, middleware, and
  static asset serving.
- React, Vite, and TypeScript for the browser application.
- TanStack Query for REST data fetching, polling intervals, mutation feedback,
  and cache invalidation.
- React Flow for graph viewport behavior, node/edge rendering, selection,
  minimap, fit/zoom controls, and interaction primitives.
- elkjs for deterministic layout of directed graphs, especially nested
  fanout, loop, switch, and scoped runtime expansion views.
- Tailwind CSS v4 for styling and design tokens.
- shadcn/ui as the component source model, with local component code owned by
  `@acpus/web` rather than opaque imported widgets.
- lucide-react for icons in buttons, tabs, status controls, graph affordances,
  and navigation.
- Vitest for route, view-model, and component-level tests, with browser smoke
  tests added once the UI shell stabilizes.

## Accepted Design Direction

The accepted visual direction is **Sahara — Warm Minimalism**.

North star: **Sun-Baked Simplicity**. The UI should combine luxurious warmth
with disciplined operator-console structure. It should feel curated and calm,
not decorative or marketing-led.

### Palette

- Primary: burnt sienna `#c2652a` for primary actions, focus states, and sparse
  active accents.
- Background: warm cream `#fdfbf7`, avoiding cold white while staying calmer
  and lighter than the earlier linen direction.
- Surface: `rgb(253 251 247 / 0.5)` for primary panels and cards. Avoid pure
  white as the default surface so the warm cream background continues to shape
  the page.
- Border: warm pale gray `#e8e4dc`.
- Text: `#2d2926`; muted text: `#7a756d`.
- Success: muted green `#4b7c61`.
- Warning/awaiting: reuse primary sienna `#c2652a` to keep the palette quiet.
- Danger: muted dusty red `#b34d4d`.
- Grays should be warm-shifted and low contrast; avoid cool slate and blue-gray
  chrome.

### Typography

- Headlines and major numeric summaries use Playfair Display for an editorial,
  high-trust feel.
- Body text, labels, tables, controls, and graph node metadata use Manrope for
  operational clarity.
- Monospace content uses `ui-monospace`, `SFMono-Regular`, Menlo, Monaco,
  Consolas, Liberation Mono, Courier New, then `monospace`.
- Large headings can be elegant, but compact panels and graph labels stay
  restrained so text does not overwhelm dense runtime data.

### Components And Surfaces

- Buttons use 8px radius. Primary buttons are solid sienna; secondary buttons
  use warm outlined styling.
- Cards and panels use warm white or low-contrast warm surface tinting,
  generous padding, minimal borders, and quiet neutral shadows:
  `0 1px 2px 0 rgba(0, 0, 0, 0.05)`,
  `0 1px 3px 0 rgba(0, 0, 0, 0.05), 0 1px 2px -1px rgba(0, 0, 0, 0.05)`,
  and `0 4px 6px -1px rgba(0, 0, 0, 0.05), 0 2px 4px -2px rgba(0, 0, 0, 0.05)`.
- Inputs use white or warm-white backgrounds, warm gray borders, and sienna
  focus states.
- Pure white is reserved for rare high-contrast needs such as dense code/text
  preview backgrounds, not ordinary layout surfaces.
- Links use underlines on hover instead of heavy button styling.
- Default border radius should stay close to 8px. Larger 12px radii are reserved
  for page-scale containers, not every card.

### Tailwind Token Sketch

The design token direction can be represented as:

```ts
theme: {
  extend: {
    colors: {
      sahara: {
        primary: "#c2652a",
        bg: "#fdfbf7",
        surface: "rgb(253 251 247 / 0.5)",
        border: "#e8e4dc",
        text: "#2d2926",
        muted: "#7a756d",
        success: "#4b7c61",
        warning: "#c2652a",
        danger: "#b34d4d",
      },
    },
    fontFamily: {
      sans: ["Manrope", "sans-serif"],
      serif: ["Playfair Display", "serif"],
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
      xl: "0.5rem",
      "2xl": "0.75rem",
    },
    boxShadow: {
      sm: "0 1px 2px 0 rgba(0, 0, 0, 0.05)",
      DEFAULT:
        "0 1px 3px 0 rgba(0, 0, 0, 0.05), 0 1px 2px -1px rgba(0, 0, 0, 0.05)",
      md:
        "0 4px 6px -1px rgba(0, 0, 0, 0.05), 0 2px 4px -2px rgba(0, 0, 0, 0.05)",
    },
  },
}
```

### Operator Console Adaptation

Sahara should not reduce the console to a sparse editorial landing page. The
first screen still prioritizes the working surface:

- The Runtime page is centered on one selected run and its current execution
  state.
- Run Graph remains the main visual object.
- Node Inspection stays adjacent to the graph.
- Command feedback and runtime controls remain available without navigation
  churn.
- Signal payload submission appears as an in-context Runtime action for
  awaiting signal nodes, not as a separate Signals page.
- Supervisor health and start/stop style operations appear as Runtime controls,
  not as a separate Runtime Ops page.
- Global metric cards such as running runs, awaiting signals, failed runs, and
  completed today are not part of the Runtime page.
- Whitespace is generous, but repeated operational workflows should remain
  efficient.
- Color is semantic first: completed/running/awaiting/failed states need clear
  distinctions while staying inside the warm palette.

## Accepted Information Architecture

The v1 navigation model is intentionally small:

- Runtime: the primary selected-run workbench. It contains run identity,
  status/version metadata, graph, node inspection, signal actions, durable run
  controls, command feedback, and supervisor status/actions.
- Runs: a list/search/filter surface for selecting a run to inspect in Runtime.
- Preflights: a static preview list and graph view for existing preflight
  artifacts.
- Settings: local web preferences and access/server details where needed.

Signals is not a standalone page. Runtime Ops is not a standalone page.
Global dashboard metric cards are not part of the Runtime page.

## Out Of Scope For This Goal

- Hosted team server, shared workspaces, multi-user auth, or RBAC.
- Workflow authoring, editing, or browser-based TypeScript checking.
- Web-triggered workflow preparation in v1.
- Direct SQLite queries from frontend or web package code.
- Persisted user graph coordinates or drag-to-save layout.
- SSE/WebSocket as a required v1 primitive.
- Legacy YAML workflow compatibility or legacy UI behavior.
- A global dashboard surface optimized around aggregate metric cards.
- Standalone Signals or Runtime Ops pages in v1.

## Remaining Technology Questions

These are the intended next decisions before implementation planning:

- Package build shape for `@acpus/web`: server build, frontend build, static
  asset location, and local dev workflow.
- Exact Hono middleware shape for localhost/network-token access, static asset
  fallback, route errors, and preview limits.
- Component inventory for the first shell: sidebar, toolbar, cards, tables,
  tabs, inspector sections, command feedback, artifact preview, and modals.
- Graph interaction details: expansion controls, minimap placement, fit-view
  behavior, selection sync, keyboard affordances, and large-run degradation.
- Polling intervals by screen state: active run, terminal run, runs list,
  health, command feedback, and artifact previews.
- Whether browser smoke tests start with Playwright, Vitest Browser Mode, or a
  smaller screenshot-free route/component test layer first.

## Verification Themes For The Future Implementation

- Graph view-model tests for static graphs, runtime overlays, nested
  fanout/switch, loops, mixed statuses, and scoped expansion.
- Web API contract tests for success shapes, tagged error shapes, polling
  versions, command submission, and preflight preview.
- Integration tests using runtime fixtures while keeping web code behind runtime
  public APIs.
- Artifact preview tests for media type limits, size truncation, unsupported
  content, and run-local registry enforcement.
- Frontend smoke/component states for empty workspace, active run, awaiting
  signal, failed node, completed run, malformed preflight, and unavailable
  artifact preview.
