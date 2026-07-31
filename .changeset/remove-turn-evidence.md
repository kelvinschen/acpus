---
"@acpus/runtime": minor
"acpus": minor
---

Remove private per-turn Evidence journals and their exact prompt, response, and
fence snapshots. Runtime now keeps Agent semantic observations and visible gaps
only in SQLite, while exact settled turns remain available through turn
artifacts and session history through run-local ACP projections.
