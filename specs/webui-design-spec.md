# WebUI Design Spec

## Purpose

The Acpus WebUI design system defines the visual and interaction language for the local operator console. It uses the shared Acpus logo lockup within a Gruvbox-derived Acpus Ink theme and gives workflow graphs a restrained categorical node-kind vocabulary.

## Requirements

- The WebUI MUST use a restrained product-tool visual register. Design choices MUST improve scanability, workflow control, graph inspection, or runtime feedback.
- The WebUI MUST use the shared [Acpus logo lockup](../page/logo/logo-lockup.svg) as its application brand.
- The WebUI visual system MUST derive application chrome, graph surfaces, node kinds, and runtime feedback from the Gruvbox-derived Acpus Ink palette.
- The WebUI visual system MUST use predominantly square geometry and crisp editorial spacing. Task, Agent, and Signal leaf nodes MAY use the dedicated compact radius defined below.
- The WebUI MUST define its core dark-theme palette through the following semantic tokens.

| Token | Value | Primary role |
| --- | --- | --- |
| `surface` | `#282828` | application canvas and deepest chrome |
| `surface-raised` | `#32302f` | controls, panels, cards, and sidebar |
| `ink` | `#ebdbb2` | warm primary text and strong foregrounds |
| `accent` | `#fe8019` | brand interaction and current-state source color |
| `added` | `#b8bb26` | completed and positive-state source color |
| `removed` | `#fb4934` | failure and destructive-state source color |

- Ordinary cards, panels, controls, inspectors, and structural graph containers MUST use borders and surface contrast instead of cast shadows for structural separation.
- Every leaf and composite graph node block MUST use centralized, low-opacity, blurred multi-layer soft shadows to establish elevation. Graph node shadows MUST NOT use hard edges or high-offset drop-shadow treatment.
- Floating dialogs, popovers, toasts, and dragged surfaces MAY use restrained low-offset shadows. Selected and active graph nodes MAY add a semantic ring or soft glow while retaining their base soft elevation.
- Standard cards, panels, buttons, inputs, popovers, dialogs, lists, tabs, and inspectors MUST use square corners.
- The WebUI MUST centralize color, radius, elevation, focus, and status styling behind semantic tokens instead of scattering raw colors across unrelated components.
- The WebUI MUST NOT use thick side-tab borders or one-side accent strips on toasts, ordinary cards, composite graph nodes, list rows, callouts, or alerts. Task, Agent, and Signal leaf nodes MUST use the restrained leading type keyline defined below in addition to their full outline.
- The WebUI MUST avoid decorative glassmorphism, gradient text, repeating-gradient decoration, and generic grid backgrounds outside the graph canvas.
- The WebUI MUST avoid nested card hierarchies where spacing, headings, dividers, or compact rows can express the structure.
- The WebUI MUST keep text contrast at WCAG AA for body-size text and MUST NOT use low-contrast gray text on dark surfaces.
- Raw source colors that do not meet the required contrast MUST NOT be used for body text, small icons, or critical borders; accessible lighter tones MUST be derived for those roles.
- Product motion MUST communicate state changes, loading, panel docking, confirmation, or graph viewport movement. Motion MUST remain subtle, under 250ms for ordinary UI transitions, and MUST respect `prefers-reduced-motion`.
- Interactive components MUST share a consistent vocabulary for default, hover, focus, active, disabled, and loading states.
- The graph toolbar Navigate and current-work focus controls MUST use the same fixed-size icon-button geometry as fit and zoom controls, with their operation names disclosed on hover. Workflow-level Input/Output MAY retain its labeled entry point.
- The graph visual system MUST keep node kind, runtime status, and structural containment as separate visual layers.
- Each leaf or composite graph node with a display status other than `not_started` MUST render exactly one semantic status stamp in a fixed top-right node slot. `not_started` nodes and branch, scope, and fanout item occurrence containers MUST NOT render a status stamp.
- Status stamps MUST be visually independent of node-kind identity: completed uses green, failed and canceled use red, running uses orange, awaiting uses aqua, paused uses purple, and queued or skipped use neutral tones. Every stamp MUST retain a distinct status icon and hover label.
- Status stamps MUST use the status icon itself as the sole enclosing shape at the shared fixed size; they MUST NOT add a surrounding border, background fill, or solid semantic-color fill.
- The graph canvas, leaf nodes, composite nodes, and structural containers MUST use a shared warm-charcoal surface family derived from Gruvbox. Node kind MUST NOT tint these large-area backgrounds.
- Node-kind borders, icons, and badges MUST use the Gruvbox-derived categorical token set with accessible lighter foreground tones and medium-value borders. Saturated kind colors MUST remain confined to small identity cues.
- Task, Agent, and Signal MUST use three contrasting Gruvbox families: yellow (`#fabd2f`) for Task, muted blue (`#7daea3`) for Agent, and purple (`#d3869b`) for Signal. Parallel MUST use aqua-blue (`#83a598`) so every node kind retains a unique categorical color.
- Task, Agent, and Signal leaf blocks MUST use a 4px leading border in their darker kind color, a 1px border on the remaining sides, and a 4px corner radius. Composite nodes and structural containers MUST remain square and MUST NOT use this leading-border treatment.
- Reused Gruvbox hues MUST remain distinguishable by their visual layer: node-kind color appears only in keylines, icons, headers, and kind badges, while runtime semantics use status stamps, rings, glows, and edges.
- Task, Agent, Signal, Assert, If, Switch, Parallel, Fanout, and Loop nodes MUST remain distinguishable through their combined leaf-border or composite-header highlight, icon shape, kind label, and badge treatment. Kind identity MUST NOT depend on hue alone.
- Graph node kind MUST remain identifiable without color through its icon shape, kind label, and badge text.
- Graph runtime status colors MUST follow the semantic status-stamp mapping above.
- Runtime status stamps, rings, glows, and edges MUST remain a separate visual layer and MUST NOT overwrite node-kind surfaces, borders, icons, or badges.
- Toasts MUST use status icons and full-surface tone. They MUST NOT use side-tab accent borders.

## Verification

- `pnpm test:unit -- packages/web`: verifies the shared logo asset, Gruvbox-derived Acpus Ink theme anchors, warm-charcoal large-area graph surfaces, accessible categorical highlight tokens, leaf-only rounded leading keylines, component states, reduced motion, soft node-shadow policy, and graph/status layer separation.
- Manual browser review checks palette use, text contrast, elevation restraint, logo treatment, representative desktop widths, and reduced-motion settings.
