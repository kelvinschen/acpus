# Real trajectory evidence

The authoritative traces for the R0-R6 study and final hardening regression are
the local SQLite databases listed in `../results/rounds.json`. Each database
contains the ordered team, task, message, turn, and projected ACP event journal.
The corresponding JSON exports were produced with:

```sh
acp-teams --state <database> --team <team-id> trajectory --limit 500
```

The raw exports are intentionally not committed: they contain provider tool
inputs and local absolute paths, and R0/R1 predate the bounded evidence
projection. `rounds.json` records their byte sizes and SHA-256 digests so the
local artifacts used for the study can be identified without treating `/tmp`
paths as a product contract.

The R6 database digest identifies the raw snapshot captured before subsequent
read/checkpoint opens. SQLite may rewrite local file bytes without changing the
recorded logical state, so database digests are retention identifiers rather
than long-term reproducibility guarantees. Its 228,946-byte trajectory view was
hashed directly from stdout and the raw export was not retained.
