---
"acpus": patch
---

Separate publication writing from HTML rendering in the bundled deep- and
wide-research workflows. Writers now produce reader-first Markdown drafts with
small visual briefs, while a shared HTML-only Renderer owns subject-specific
layout, DataViz, and content-grounded constraints that avoid generic AI styling.
The Renderer chooses whether and how to validate each result instead of running
a required browser or mobile-specific pass. The two phases continue one
publication Agent session so subject context and a cacheable conversation prefix
carry into rendering without combining both roles' instructions in one turn.
Mermaid-syntax diagrams
now use `beautiful-mermaid`, and the rendering contract names recurring slop
patterns while adding typography, surface, interaction, and motion polish rules.
Reader-first drafts now plan from the reader's purpose and starting knowledge,
separate essential explanation from appendix detail, provide a self-contained
opening when the report warrants one, keep one term per concept and one evidence
thread per paragraph, and make observations, inferences, and recommendations
distinguishable without form-like labels. HTML rendering preserves responsive
evidence layouts, linked citations, heading fidelity, readable visuals, and
accessible controls as design constraints.
Deep-research lane reports and wide-research unit records now share compact
evidence-record language with stable within-record terminology, local
observation-versus-inference boundaries, and finding-level evidence, confidence,
and caveat proximity for downstream synthesis.
