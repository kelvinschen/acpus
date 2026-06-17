---
"@acpus/core": minor
"@acpus/runtime": minor
"acpus": minor
---

Add workflow metadata to CEL and template contexts through `workflow.name`,
`workflow.description`, `workflow.source_path`, and `workflow.source_dir`, and
preserve source paths from compilation through runtime evaluation.

Fork inheritance now includes workflow metadata in node definition hashes when a
node references `workflow.*`, preventing source-directory-dependent steps from
being incorrectly inherited across forks. The CLI catalog also discovers bundled
`workflow.spec.yaml` entries, and the project catalog now includes a
`swarm-intelligence` workflow bundle with spec-local helper scripts.
