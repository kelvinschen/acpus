# WebUI Design Spec

## Purpose

The Acpus WebUI design system defines the visual and interaction language for the local operator console. It keeps runtime work surfaces familiar, readable, and trustworthy while avoiding generated-UI patterns that reduce confidence.

## Requirements

- The WebUI MUST use a restrained product-tool visual register. Design choices MUST improve scanability, workflow control, graph inspection, or runtime feedback.
- The WebUI visual system MUST use a Sera-inspired high-contrast card style with a neutral canvas, white surfaces, black text, square corners, strong borders, soft elevation, and crisp editorial spacing.
- Standard cards, panels, buttons, inputs, popovers, dialogs, lists, tabs, and inspectors SHOULD use square corners and soft Sera-style shadows. Native controls and dense graph elements MAY retain geometry-specific radii or elevation when required for clarity.
- The WebUI MUST centralize color, radius, elevation, focus, and status styling behind semantic tokens instead of scattering raw colors across unrelated components.
- The WebUI MUST NOT use thick side-tab borders or one-side accent strips on toasts, cards, graph nodes, list rows, callouts, or alerts. Status and kind feedback MUST use full-border, icon, text, badge, or background treatment instead.
- The WebUI MUST avoid decorative glassmorphism, gradient text, repeating-gradient decoration, and generic grid backgrounds outside the graph canvas.
- The WebUI SHOULD avoid warm cream or beige as a reflexive dominant surface. Warm Terra tones MAY appear as a product identity accent, but neutral hierarchy MUST carry the main operator workspace.
- The WebUI MUST avoid nested card hierarchies where spacing, headings, dividers, or compact rows can express the structure.
- The WebUI MUST keep text contrast at WCAG AA for body-size text and MUST NOT use low-contrast gray text on tinted backgrounds.
- Product motion MUST communicate state changes, loading, panel docking, confirmation, or graph viewport movement. Motion MUST remain subtle, under 250ms for ordinary UI transitions, and MUST respect `prefers-reduced-motion`.
- Interactive components MUST share a consistent vocabulary for default, hover, focus, active, disabled, and loading states.
- The graph visual system MUST keep node kind, runtime status, and structural containment as separate visual layers.
- Each leaf or composite graph node MUST render one status-palette glyph; branch and scope containers MUST NOT render status glyphs.
- Graph node kinds MUST use a muted Morandi-functional palette, while non-graph application chrome MUST remain primarily black and white.
- Toasts MUST use status icons and full-surface tone. They MUST NOT use side-tab accent borders.

## Verification

- Tests cover semantic tokens, component states, reduced motion, contrast, graph/status layer separation, and the side-accent prohibition.
- Manual browser review checks the design language at representative desktop widths and reduced-motion settings.
