# WebUI Design Spec

## Purpose

The Acpus WebUI design system defines the visual and interaction language for the local operator console. It keeps runtime work surfaces familiar, readable, and trustworthy while avoiding generated-UI patterns that reduce confidence.

## Requirements

- The WebUI MUST use a restrained product-tool visual register. Design choices MUST improve scanability, workflow control, graph inspection, or runtime feedback.
- The WebUI MUST centralize color, radius, elevation, focus, and status styling behind semantic tokens instead of scattering raw colors across unrelated components.
- The WebUI MUST NOT use thick side-tab borders or one-side accent strips on toasts, cards, graph nodes, list rows, callouts, or alerts. Status and kind feedback MUST use full-border, icon, text, badge, or background treatment instead.
- The WebUI MUST avoid decorative glassmorphism, gradient text, repeating-gradient decoration, and generic grid backgrounds outside the graph canvas.
- The WebUI SHOULD avoid warm cream or beige as a reflexive dominant surface. Warm Terra tones MAY appear as a product identity accent, but neutral hierarchy MUST carry the main operator workspace.
- The WebUI MUST avoid nested card hierarchies where spacing, headings, dividers, or compact rows can express the structure.
- The WebUI MUST keep text contrast at WCAG AA for body-size text and MUST NOT use low-contrast gray text on tinted backgrounds.
- Product motion MUST communicate state changes, loading, panel docking, confirmation, or graph viewport movement. Motion MUST remain subtle, under 250ms for ordinary UI transitions, and MUST respect `prefers-reduced-motion`.
- Interactive components MUST share a consistent vocabulary for default, hover, focus, active, disabled, and loading states.
- The graph visual system MUST keep node kind, runtime status, and structural containment as separate visual layers.
- Toasts MUST use status icons and full-surface tone. They MUST NOT use side-tab accent borders.

## Verification

- Tests MUST cover WebUI design tokens and component styling hooks for buttons, toasts, inspector, graph, and status affordances.
- Tests MUST reject thick `border-left` or `border-right` side-tab accents in WebUI CSS except for 1px layout dividers.
- Slop detection SHOULD be run against WebUI client source before handoff and SHOULD report no deterministic AI-slop findings.
