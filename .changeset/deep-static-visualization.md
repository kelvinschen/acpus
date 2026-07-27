---
"@acpus/web": minor
"acpus": patch
---

Deepen static workflow visualization around canonical compiler data:

- replace the HTML renderer's caller-assembled graph, metadata, and contract
  inputs with one `WorkflowIR` plus its source graph digest;
- derive browser and offline static visualization data through one Web-owned
  projection so those views cannot diverge;
- retain recoverable source and compiler failures as tagged Results until the
  Hono adapter produces the existing HTTP visualization envelope; and
- report workflow selections rejected before compiler preparation as
  source-phase failures instead of compile-phase failures while accepting
  contained workflow names that merely begin with two dots.

CLI HTML visualization output remains unchanged.
