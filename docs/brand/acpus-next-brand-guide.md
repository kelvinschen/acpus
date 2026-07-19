# Acpus Next brand guide

## 1. Direction

**Brand idea:** **The Relay Ligature**

Acpus coordinates agents, checks the authored graph, executes it durably, and keeps the run observable. The identity turns that product truth into one gesture:

- the Roman-proportioned `A` keeps the cultivated, “opus” side of the existing brand;
- the open ultramarine loop reads as a lowercase `p`, a workflow edge, a repeatable run, and a conductor's gesture;
- the vermilion node marks the handoff where one capable actor passes work to another.

The result should feel **cultured, kinetic, and dependable**. It is classical through proportion and language, not through costume.

## 2. What changed

The previous mark leaned on an old-book frontispiece: nested borders, an italic motto, a star divider, a serif `Ap` ligature, parchment, and a gilded knot. The new system keeps only the useful memory:

| Keep | Reduce or remove |
| --- | --- |
| Roman `A` proportion | Frontispiece borders |
| `Ap` ligature idea | Decorative star and rules |
| “Every run is an opus.” | Motto embedded inside the mark |
| A single handoff node | Gold as the dominant accent |
| Warm paper as a neutral | All-over antique-paper styling |

This makes the identity easier to recognize at 16–32 px and lets the product feel alive without becoming generic “AI neon.”

## 3. Logo system

### Primary mark

Use `page/logo/logo-mark.svg` on light backgrounds and `logo-mark-reverse.svg` on dark backgrounds.

The mark has three parts:

1. **Structure** — the ink `A`; durable, measured, reviewable.
2. **Relay** — the ultramarine open loop; orchestration, branching, continuation.
3. **Handoff** — the vermilion node; agency, state change, human or agent intervention.

### Core lockup

Use `logo-lockup.svg` for long-lived Acpus material. The lowercase wordmark lowers the formality and makes the identity feel more active.

### Next lockup

Use `logo-next-lockup.svg` only when the release stage matters. The slash and `next` label are detachable; do not permanently fuse “Next” into the core brand.

### Clear space

Keep at least one handoff-node diameter around every side of the mark or lockup. For prominent placements, use two node diameters.

### Minimum size

- Use the full mark at **20 px or larger**.
- Use `logo-favicon.svg` below 20 px.
- Keep the horizontal lockup at **96 px wide or larger**.
- At small sizes, never add a tagline beneath the lockup.

### Monochrome

Use `logo-mark-mono.svg` when only one ink is available. Do not simulate the color mark with screens, gradients, shadows, or outlines.

## 4. Color

The palette uses historical pigment names with contemporary saturation.

| Token | Value | Role |
| --- | --- | --- |
| Carbon ink | `#101522` | Primary text, structure, dark fields |
| Warm paper | `#F4F0E4` | Main light background |
| Surface | `#FFFDF8` | Raised or quiet light field |
| Ultramarine | `#3155FF` | Motion, links, active run, relay path |
| Vermilion | `#FF5A36` | Handoff node, action accent, pulse |
| Brass | `#C89A3D` | Rare heritage note |
| Success | `#187254` | Accessible success text |
| Failure | `#B83A28` | Accessible failure text |
| Awaiting | `#7A4FB5` | Durable waiting / signal state |

Carbon ink on warm paper has a contrast ratio of about **16:1**. Ultramarine on warm paper is about **4.76:1** and may be used for normal text. Vermilion and brass are decorative on light fields; do not use them for small body text.

### Palette balance

A typical surface should be approximately:

- 65–80% paper / surface;
- 15–25% carbon ink;
- 5–12% ultramarine;
- under 4% vermilion;
- under 2% brass.

On dark hero surfaces, invert paper and ink, then use the lighter ultramarine token `#8FA2FF`.

## 5. Typography

### Primary: Cabin

Use **Cabin** for the wordmark, product UI, marketing headlines, and body text. Its humanist construction keeps the system warm while its compact shapes work well around graphs and code.

Recommended weights:

- 400 for body;
- 500 for navigation and supporting copy;
- 600 for headings and the wordmark;
- 700 only for short emphasis.

### Operational: Recursive

Use **Recursive** for code, CLI strings, state labels, run IDs, and compact metadata. Monospace is a semantic signal here, not a general “developer aesthetic.”

### Heritage accent: Gentium Book Plus Italic

Use **Gentium Book Plus Italic** only for the motto, a pull quote, or one key editorial sentence. It is the quiet classical trace. Do not use it for navigation, labels, or every section heading.

## 6. Graphic language

### Paths and nodes

Supporting graphics should use:

- open curves rather than closed decorative rings;
- one meaningful node at a handoff or state change;
- forward diagonals and asymmetry;
- real workflow structure when showing multiple nodes.

Avoid decorative constellations, random particles, and generic neural-network meshes.

### Pattern

`logo-flow-pattern.svg` is a supporting texture, not wallpaper. Crop it boldly, keep opacity low, and let one node remain visible.

### Corners and rules

Use moderate radii for application icons and compact tiles. Most marketing layouts should rely on edge-to-edge color fields, rules, and spacing rather than stacks of rounded cards.

## 7. Motion

Motion should describe orchestration:

- draw the relay path once;
- move or pulse the vermilion node at a meaningful handoff;
- reveal branches in execution order;
- settle completed states instead of keeping everything in motion.

Respect `prefers-reduced-motion`. Do not use perpetual floating, sparkle, or ambient particle effects.

## 8. Voice

Keep the existing line:

> Every run is an opus.

Pair it with direct operational language. Good Acpus copy moves between cultivated and concrete:

- “Describe the task. Let agents orchestrate agents.”
- “The file is real.”
- “Acpus keeps the run.”
- “Review the graph before it moves.”
- “Every handoff has momentum.”

Avoid grand claims about intelligence, magic, autonomy, or replacing teams.

## 9. Asset map

Production assets live in `page/logo/`:

- primary, reverse, and monochrome marks;
- core and Next lockups;
- compatibility tile, favicon, and app icon;
- social card and supporting pattern.

Design tokens live in `page/brand-tokens.css`. The live specimen is `page/brand-preview.html`.

## 10. Migration order

1. Replace the README and site header mark through the existing `logo-opus-mark.svg` path.
2. Replace the favicon through the existing `logo-favicon.svg` path.
3. Adopt the new color and type tokens on new surfaces first.
4. Move existing pages away from ornamental borders and all-over parchment gradually.
5. Use the core lockup for stable product material and reserve the Next lockup for release-specific pages.

---

## 中文速览

新形象的核心是 **“传奏结”**：保留罗马大写 `A` 的比例与 “opus” 文脉，用一条开放的群青色曲线同时暗示小写 `p`、工作流边和指挥手势；朱红结点表示任务在 agent、runtime 与人之间完成交接。

古典感只保留在**比例、语言和少量字体**里，不再依赖双重边框、星形分隔、仿古纸张或大面积金色。主色从“羊皮纸 + 黑 + 金”调整为“暖纸 + 碳黑 + 群青 + 朱红”，因此整体更轻、更有速度，也更适合图标、CLI、WebUI 和社交传播。
