---
"@acpus/agent-executor": patch
"@acpus/core": patch
"@acpus/expression": patch
"@acpus/loader": patch
"@acpus/runtime": patch
"@acpus/workflow-compiler": patch
"@acpus/web": patch
"acpus": patch
---

Make Core boundary failures deterministic and accurately observable:

- report the zx-rendered command for array and complex Task command interpolation;
- return `invalid-default` for cyclic or uncloneable Zod defaults instead of
  throwing, while using native structured-clone semantics for shared values;
- preserve own object-map fields named `__proto__` throughout Core lowering
  instead of treating them as prototype mutation;
- reject POSIX, Windows drive-relative, rooted, UNC, and device paths wherever
  reusable Task referrers require a portable workspace-relative path;
- reject unknown workflow reference roots, unknown run metadata fields, and
  malformed values in otherwise allowed frozen-IR fields; and
- inspect schemas only through the supported Zod 4 `def`, `type`, and
  `description` interfaces.

Classify structured agent configuration failures by JSON-RPC code rather than
by the command that emitted them: numeric or string `-32602` remains `config`,
while every other structured JSON-RPC failure is now `provider_exit`.
Unstructured rejected configuration commands remain `config`.

Make reusable Task compilation produce complete IR in one pass:

- accept source links before Core graph construction instead of publishing
  empty module targets for the compiler to mutate afterward;
- accept the shared reusable-Task referrer as one path fact instead of an
  input object shaped like the eventual IR descriptor;
- return typed Core compilation failures for missing or invalid reusable Task
  links, including when ordinary IR validation is disabled;
- fail malformed Task specs instead of returning an empty inline executable;
- retain ordinary build/lowering causes in the typed failure while preserving
  the throwing convenience API's original exception identity; and
- run compiler Task analysis and source-containment checks before invoking the
  workflow build callback. Successful compiled IR and runtime behavior are
  unchanged.

Make expression graph boundaries total and preserve authored data:

- return tagged lowering failures for cyclic or uninspectable values instead of
  leaking recursion or Proxy trap exceptions;
- reject cyclic callback inputs with `ExpressionEvaluationError` and use native
  structured cloning, which preserves shared-reference identity while
  isolating callback mutation;
- preserve ordinary object fields named `__proto__` during lowering and
  evaluation; and
- validate missing and non-JSON template values before an adapter formatter can
  handle them.

Resolve lazy bare imports from overlapping authoring source roots through the
most specific registered dependency authority, independent of registration
order, and propagate symlink-loop or I/O failures while canonicalizing an
authority instead of treating them as a missing path.

Reject self-consistent but structurally invalid prepared workflow IR before
Runtime admission or fork mutation. Core validator errors and pre-existing
error diagnostics now return the typed `invalid-ir` preparation failure;
warning-only IR remains admissible.

Preserve an authored Task input field named `__proto__` as ordinary own
WorkflowData instead of silently installing it as the temporary input object's
prototype and dropping it before execution.

Make prepared workflow source identity single-owned:

- preparation inputs identify a workspace or global catalog but no longer
  repeat the workflow entry;
- CLI catalog resolution carries that input identity directly instead of
  constructing an entry that its preparation adapter immediately discarded;
- the compiler derives the portable entry from the workflow path and selected
  source root exactly once;
- missing global roots, inconsistent workspace roots, and workflow paths
  lexically outside the selected root now fail before check or compilation
  with the typed `source-invalid` failure;
- existing workflow symlinks that resolve outside the selected source root are
  rejected in the same source phase before source checking or execution;
- contained workflow names beginning with `..` remain valid unless `..` is an
  actual parent path segment; and
- CLI and Web workflow-visualization output expose the corresponding `source`
  phase as part of their closed result unions.

Restrict the followed workflow run NDJSON admission record to the public `RunRecord`
projection. This removes previously exposed normalized input, Agent overrides,
hook history, execution state, dynamic details, and internal event/node counts;
subsequent follow records are unchanged.
