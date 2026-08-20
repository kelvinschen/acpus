# Configuration Spec

## Purpose

`@acpus/runtime` owns the single project/global Acpus configuration boundary
used by named Agents, Agent Presets, and Runtime Hooks. Domain packages consume
validated sections through Runtime APIs rather than reading configuration files.

## Requirements

- Project configuration MUST live at `<workspace>/.acpus/config.json`; global
  configuration MUST live at `$HOME/.acpus/config.json`.
- The configuration file MUST be a closed JSON object with only optional
  `agents`, `presets`, and `hooks` fields. A missing file or omitted field MUST
  contribute an empty section.
- `agents` MUST be a closed map from normalized non-empty names to non-empty
  shell command strings. `presets` MUST be a closed map of valid Runtime-owned
  Agent Preset definitions. `hooks` MUST be a supported-event map of valid
  command-hook arrays.
- Invalid JSON, an unknown top-level field, or invalid content in any section
  MUST invalidate the complete file for every consumer.
- Project configuration MUST be rooted at Runtime's canonical workspace and
  MUST NOT follow an Agent's effective `cwd`. Global configuration MUST use the
  Runtime/Host process home and MUST NOT follow workflow `env.HOME`.
- Named Agent composition MUST be Host, project, global, then built-in. Alias
  lookup MUST NOT allow a global exact name to outrank a project canonical
  name.
- Agent Preset composition MUST be Host, project, then global for an exact id.
- Hook composition MUST be the direct union of project and global entries;
  every matching entry from both scopes MUST execute.
- Runtime MUST own path resolution, complete-schema validation, safe reads,
  locking, atomic replacement, and file permissions for this boundary.
- Reads and writes MUST reject symbolic-link or non-regular substitution of
  the scope `.acpus` directory or configuration file, prove canonical direct
  containment and opened-directory identity, and never chmod or write through
  an external link.
- Writes MUST serialize through an owner-private sibling lock containing PID,
  available process-start token, and random owner token. Contention MAY reclaim
  and retry once only after process identity proves the owner dead or reused;
  malformed or unprovable ownership MUST remain busy without mtime inference.
- A successful write MUST atomically replace a `0600` file and make a global
  `.acpus` directory `0700` on POSIX.
- A section mutation MUST preserve the other validated sections semantically.
  Serialized output MUST order top-level fields as `agents`, `presets`, then
  `hooks`, omit empty sections, sort Agent and Preset keys, and preserve Hook
  array declaration order.
- Hooks MUST load only when Runtime/daemon starts. Named Agent configuration
  MUST be re-read for each new Session lease. Presets MUST be re-read during
  discovery and admission.

## Verification

- `pnpm test:unit packages/runtime`: verifies strict parsing, composition,
  secure persistence, locking, permissions, and section-preserving mutation.
- `pnpm test:integration packages/runtime packages/agent-executor`: verifies
  Runtime-rooted Agent resolution, reload cadence, Preset admission, and Hooks.
- `pnpm test:contract packages/cli packages/dsh`: verifies configuration-facing
  CLI and Host behavior.
