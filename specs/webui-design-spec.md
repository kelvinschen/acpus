# WebUI Design Spec

## Purpose

The Acpus WebUI design system defines the visual and interaction language for the local operator console. It extends the shared Acpus homepage identity through the light Paper Relay system: pale paper surfaces, sharp editorial geometry, cobalt actions, orange emphasis, and deliberately restrained workflow-graph styling.

## Requirements

- The WebUI MUST use a bold product-tool visual register. Design choices MUST improve scanability, workflow control, graph inspection, or runtime feedback.
- The WebUI MUST use the shared [Acpus logo lockup](../page/logo/logo-lockup.svg) as its application brand. Fixed colors inside that brand asset are exempt from CSS tokenization.
- The WebUI MUST use the Paper Relay light color scheme and the following canonical foundation tokens.

| Token | Value | Primary role |
| --- | --- | --- |
| `--ui-canvas` | `#FAF8F3` | application canvas |
| `--ui-surface` | `#FFFEFB` | sidebar and primary paper surface |
| `--ui-surface-raised` | `#FFFFFF` | controls, cards, and floating surfaces |
| `--ui-surface-muted` | `#F1EEE7` | quiet controls and grouped content |
| `--ui-ink` | `#252828` | primary text, hard outlines, and hard shadows |
| `--ui-text-muted` | `#625F58` | secondary text |
| `--ui-border` | `#DED9D0` | low-emphasis structural borders |
| `--ui-primary` | `#0A46D4` | primary actions, focus, and selection |
| `--ui-primary-text` | `#0737A7` | accessible blue text and active graph paths |
| `--ui-accent` | `#FA7408` | brand emphasis and selected navigation fill |
| `--ui-accent-text` | `#943800` | accessible orange-family text |
| `--ui-success` | `#087445` | completed and positive feedback |
| `--ui-danger` | `#C63525` | failed, canceled, and destructive feedback |
| `--ui-awaiting` | `#934000` | awaiting feedback |
| `--ui-paused` | `#6B3FA0` | paused feedback |
| `--ui-on-solid` | `#FFFFFF` | text on primary, success, and danger fills |
| `--ui-workspace-inset` | `20px 24px` | graph-page block and inline inset |
| `--ui-region-gap` | `16px` | major workspace region spacing |
| `--ui-panel-gap` | `12px` | graph and docked Inspector spacing |

- The WebUI MUST use Outfit for sans-serif UI text and IBM Plex Mono for identifiers, code, runtime metadata, and other monospaced content, with platform fallbacks when the web fonts are unavailable.
- The application canvas MAY use a very low-contrast paper grain. The texture MUST NOT appear inside graph nodes, inspectors, inputs, or other content surfaces.
- The WebUI MUST use predominantly square geometry and crisp editorial spacing. Task, Agent, and Signal leaf nodes MAY use the dedicated compact radius defined below.
- Graph workspaces MUST use `--ui-workspace-inset` around page content, `--ui-region-gap` between major workspace regions, and `--ui-panel-gap` between a graph and its docked Inspector so both panels maximize the available viewport while retaining distinct structural boundaries.
- Main application plates, selected navigation, primary controls, and floating surfaces MAY use low-offset hard shadows derived from `--ui-ink`. Hard shadows MUST remain centralized as `--ui-shadow-control` (`2px 3px 0 #252828`) and `--ui-shadow-panel` (`6px 8px 0 #252828`).
- Dense information cards, list rows, nested Inspector content, and structural graph containers MUST remain flat or use a quiet soft separator. The WebUI MUST NOT give every nested surface equal visual weight.
- Leaf and composite graph nodes MUST retain centralized, low-opacity, blurred multi-layer soft elevation. Changing the application style MUST NOT replace graph-node elevation with hard offset shadows.
- Floating dialogs, popovers, toasts, and dragged surfaces MAY use the panel shadow. Selected and active graph nodes MAY add a semantic ring or soft glow while retaining their base soft elevation.
- Standard cards, panels, buttons, inputs, popovers, dialogs, lists, tabs, and inspectors MUST use square corners.
- The WebUI MUST centralize color, radius, elevation, focus, and status styling behind semantic tokens instead of scattering raw colors across unrelated components.
- The WebUI MUST NOT use thick side-tab borders or one-side accent strips on toasts, ordinary cards, composite graph nodes, list rows, callouts, or alerts. Task, Agent, and Signal leaf nodes MUST use the restrained leading type keyline defined below in addition to their full outline.
- The WebUI MUST avoid decorative glassmorphism, gradient text, and generic grid backgrounds outside the graph canvas.
- The WebUI MUST avoid nested card hierarchies where spacing, headings, dividers, or compact rows can express the structure.
- The WebUI MUST keep text contrast at WCAG AA for body-size text. Raw brand fills that do not meet the required contrast, including `--ui-accent`, MUST NOT be used for body text, small icons, or critical borders; their accessible text tokens MUST be used instead.
- Product motion MUST communicate state changes, loading, panel docking, confirmation, or graph viewport movement. Motion MUST remain subtle, under 250ms for ordinary UI transitions, and MUST respect `prefers-reduced-motion`.
- Runs-to-Monitor navigation MAY use the product workspace transition, but changing the selected workspace MUST switch directly to its loading state without a page-level transition so identity and content never appear to drift between scopes.
- Interactive components MUST share a consistent vocabulary for default, hover, focus, active, disabled, and loading states.
- Each Artifact row MUST be one full-width control with a hit area of at least 44px. It MUST present path, media type, size, and a compact View cue; activating any point on the row opens the full viewer, and closing the viewer MUST restore focus to that row without changing the active Inspector tab or scroll context.
- The full Artifact viewer MUST use a square Paper Relay floating surface with a structural ink border, the shared soft card shadow, a fixed metadata-and-action header, and an independently scrolling document body. Desktop viewports MUST retain a small canvas inset; viewports at or below 640px MUST use `100dvw × 100dvh` without an outer border or shadow.
- Artifact view modes MUST use a compact segmented-button treatment. Viewer actions MUST retain text labels and 44px hit areas, Markdown preview MUST use a reading measure no wider than approximately `72ch`, and raw source MUST use the product monospace type system.
- Prompt and full-view Markdown MUST share one document hierarchy: distinct heading scale and section rhythm, visible list markers and task controls, restrained quote keylines, horizontally scrollable bordered tables, differentiated inline and fenced code, and responsive images with a quiet outline. Prompt previews MUST scroll inside their available Inspector region without flattening those document semantics.
- Rendered Mermaid diagrams MUST use a flat Paper Relay surface and structural border without card elevation. A diagram MUST preserve its intrinsic readable width inside a keyboard-scrollable region instead of shrinking complex labels, and render failure MUST expose the authored source rather than an empty surface.
- The full Artifact viewer MUST enter within 160ms using opacity and no more than 8px of vertical movement, exit within 120ms, and remove its custom motion under `prefers-reduced-motion`.
- The Runs workspace selector MUST use the existing Radix Select interaction model. Its trigger MUST present the workspace basename and `CURRENT` or `READ ONLY` identity before compact `n runs` and last-update metadata; its options MUST add a truncated canonical path so equal basenames remain distinguishable without expanding the control.
- Workspace-selector absolute paths and update timestamps MUST be available through hover and keyboard-accessible descriptions. Identifiers, counts, and times MUST use monospaced or tabular figures, and long paths MUST truncate visually without truncating their accessible names.
- The workspace selector popup MUST be vertically scrollable, preserve keyboard navigation, typeahead, Home/End, Escape, and focus restoration, and fit within the viewport. Its surface MUST use the Paper Relay structural border and quiet soft floating elevation rather than a hard offset shadow.
- At narrow widths the Runs heading and workspace selector MUST stack, the selector trigger MUST fill the available content width, and the popup MUST remain no wider than the viewport. Read-only identity MUST remain visible without using a large status-colored surface.
- The graph toolbar Navigate, current-work focus, selected-node focus, and fit controls MUST use the same fixed-size icon-button geometry with their operation names disclosed on hover; current-work and selected-node focus MUST use distinct icons.
- The workflow-level Inspector entry point MUST remain labeled `Workflow`.
- The workflow graph layout algorithm, node and container dimensions, spacing, edge geometry, status-stamp placement, zoom, pan, and viewport behavior MUST remain independent from the Paper Relay color system.
- The graph visual system MUST keep node kind, runtime status, selection, and structural containment as separate visual layers.
- The graph MUST use the following canonical surface and edge tokens.

| Token | Value | Primary role |
| --- | --- | --- |
| `--graph-canvas` | `#F5F2EB` | graph viewport |
| `--graph-node` | `#FFFFFF` | leaf-node surface |
| `--graph-composite` | `#FFFEFB` | composite-node surface |
| `--graph-structure` | `#FAF8F3` | branch, scope, and occurrence containers |
| `--graph-structure-border` | `#9D978C` | structural containment |
| `--graph-edge` | `#625E57` | ordinary semantic edges and arrowheads |
| `--graph-edge-muted` | `#79736C` | branch and loop edges |
| `--graph-edge-active` | `#0737A7` | active semantic path fallback |
| `--graph-selection` | `#0A46D4` | selected-node ring and minimap selection |

- Ordinary graph edges MUST have at least 3:1 contrast against the graph canvas. Active graph edges MUST have at least 4.5:1 contrast. Arrowheads MUST be opaque and use the ordinary edge token.
- Loop-return edges MUST retain a dashed treatment but use a stronger semantic-edge weight and a directional arrowhead so they remain distinct from dashed structural container boundaries at fit-view.
- The graph canvas, leaf nodes, composite nodes, and structural containers MUST use the shared neutral Paper Relay surface family. Node kind and runtime status MUST NOT tint these large-area backgrounds.
- Graph node-kind identity MUST use the following accessible categorical tokens. The corresponding border token MUST be used only for keylines, outlines, and compact identity cues.

| Kind | Foreground token | Foreground | Border token | Border |
| --- | --- | --- | --- | --- |
| Task | `--graph-kind-task` | `#765600` | `--graph-kind-task-border` | `#A57A00` |
| Agent | `--graph-kind-agent` | `#0737A7` | `--graph-kind-agent-border` | `#3C64B9` |
| Signal | `--graph-kind-signal` | `#8A2D5B` | `--graph-kind-signal-border` | `#A85A94` |
| Assert | `--graph-kind-assert` | `#A12A23` | `--graph-kind-assert-border` | `#C65A50` |
| If | `--graph-kind-if` | `#246B37` | `--graph-kind-if-border` | `#4B8858` |
| Switch | `--graph-kind-switch` | `#5B3AA4` | `--graph-kind-switch-border` | `#7C5AB7` |
| Parallel | `--graph-kind-parallel` | `#006B68` | `--graph-kind-parallel-border` | `#338987` |
| Fanout | `--graph-kind-fanout` | `#943800` | `--graph-kind-fanout-border` | `#B96524` |
| Loop | `--graph-kind-loop` | `#4F4A45` | `--graph-kind-loop-border` | `#79736C` |

- Task, Agent, Signal, Assert, If, Switch, Parallel, Fanout, and Loop nodes MUST remain distinguishable through their combined leaf-border or composite-header highlight, icon shape, kind label, and badge treatment. Kind identity MUST NOT depend on hue alone.
- Task, Agent, and Signal leaf blocks MUST use a 4px leading border in their darker kind color, a 1px border on the remaining sides, and a 4px corner radius. Composite nodes and structural containers MUST remain square and MUST NOT use this leading-border treatment.
- Node-kind color MUST remain confined to keylines, icons, headers, and kind badges. Runtime semantics MUST use status stamps, rings, glows, and edges, while selection MUST use its dedicated ring.
- A leaf node MUST render its identity on a dedicated single-line content row; its icon and kind label MUST share a compact metadata badge above that row.
- Each leaf or composite graph node with a display status other than `not_started` MUST render exactly one semantic status stamp in a fixed top-right node slot. `not_started` nodes and branch, scope, and fanout item occurrence containers MUST NOT render a status stamp.
- Status stamps MUST be visually independent of node-kind identity and MUST follow this mapping.

| Runtime status | Semantic token |
| --- | --- |
| `not_started` | `--status-not-started` (`#858078`) |
| `queued` | `--status-queued` (`#625F58`) |
| `running` | `--status-running` (`#0737A7`) |
| `awaiting` | `--status-awaiting` (`#934000`) |
| `paused` | `--status-paused` (`#6B3FA0`) |
| `completed` | `--status-completed` (`#087445`) |
| `failed` | `--status-failed` (`#C63525`) |
| `canceled` | `--status-canceled` (`#C63525`) |
| `skipped` | `--status-skipped` (`#79736C`) |

- Every status stamp MUST retain a distinct status icon and hover label. The status icon itself MUST be the sole enclosing shape at the shared fixed size; stamps MUST NOT add a surrounding border, background fill, or solid semantic-color fill.
- Runtime status stamps, rings, glows, and edges MUST NOT overwrite node-kind surfaces, borders, icons, or badges.
- The minimap MUST read as a lightweight topology map rather than a scaled screenshot. It MUST render semantic edges without arrowheads, leaf nodes with the neutral node surface and kind-colored outlines, and composite-node bounds as transparent structural outlines rather than large solid blocks.
- Minimap active and selected states MUST strengthen outlines without replacing node fills. Selection MUST use `--graph-selection` and MUST NOT reuse the success token.
- The minimap MUST use one square structural frame without decorative inset padding or a second elevation ring. When the viewport covers only part of the graph, its closed indicator MUST use a dashed `--ui-accent-text` outline and the surrounding shade MUST remain at or below 6% `--ui-ink` opacity. When the complete graph is visible, the minimap MUST omit that redundant inner frame and shade.
- Toasts MUST use status icons and full-surface tone. They MUST NOT use side-tab accent borders.

## Verification

- `pnpm test:unit packages/web`: verifies Paper Relay foundation and compact workspace-spacing tokens, shared Markdown semantics, document hierarchy, Mermaid rendering and fallback, the single-action Artifact row and full-view hierarchy, full-view responsive sizing and reduced motion, workspace-selector hierarchy and responsive behavior, light color scheme, font contract, accessible semantic and graph palettes, neutral graph surfaces, leaf-only rounded leading keylines, component states, graph soft-elevation policy, opaque readable edges and directional loop returns, graph kind/status/selection separation, and minimap topology hierarchy.
- Manual browser review checks paper texture restraint, text contrast, hard-shadow hierarchy, Artifact viewer focus restoration and desktop/narrow-screen reading behavior, workspace-selector keyboard and narrow-screen behavior, logo treatment, representative desktop widths, graph readability, and reduced-motion settings.
