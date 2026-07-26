---
"@acpus/agent-executor": minor
"@acpus/runtime": minor
"acpus": minor
"@acpus/web": patch
---

Add compact Private Turn Evidence for exact prompt, fence, and terminal
boundaries; bounded write-time semantic projection for inspection; and
opt-in full normalized Trace spooling without relaxing attempt fencing.

Replace target inspection with a high-density decision summary, add a unified
bounded Timeline with opaque pagination and incremental follow revisions, and
expose Evidence/Trace metadata only for exact Agent attempts. Keep rich node
details available to the Web operator surface without adding a Web Timeline.
Keep resource telemetry in explicit diagnostics, reserve Attention for hard
operator needs, and present steer as an available last-resort correction rather
than a recommendation.
