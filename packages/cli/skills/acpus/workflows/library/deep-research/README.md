# Deep Research Workflow

Deep Research turns a complex question into one coherent, sourced report. It can
research the public web, inspect a local codebase, or combine both.

Use it to:

- understand a complex topic, system, or event from several connected angles;
- compare competing explanations, options, or claims against the available
  evidence;
- trace how a codebase behaves and connect implementation details to the
  user-visible outcome;
- investigate open-ended questions where early findings may reveal important
  follow-up work;
- produce a report that explains conclusions, evidence, uncertainty, and
  remaining gaps together.

The workflow breaks the question into focused investigations, follows up on
what they uncover, cross-checks important claims, and synthesizes the results
into a single reader-first answer. It is best for questions that need judgment
and integration, not simple lookups or a mechanical census of unrelated items.

## Inputs

- `question` (required): the question to investigate.
- `context` (optional): constraints or background such as audience, time range,
  repository scope, required topics, or source preferences.
- `depth` (optional, default `deep`):
  - `fast`: up to 6 groups in 1 round, without Skeptic review;
  - `deep`: up to 8 groups per round for 2 rounds;
  - `xdeep`: up to 16 groups per round for 3 rounds;
  - `max`: up to 32 groups per round for 3 rounds.

Group counts are ceilings, not quotas. The Lead chooses only the work the answer
needs. A group may investigate one explanatory relationship or a coherent batch
of homogeneous objects under one comparison frame.

## Outputs

Every run returns `evidenceBundle`, a readable Markdown dossier containing the
final sourced report and its supporting research. It also publishes an HTML
report and retains the authoritative Markdown beside it.

## Run

Resolve the active Acpus skill directory, bind its `lead`, `worker`, and
`skeptic` Agent slots in `agents.json`, then use the workflow's absolute path:

```sh
acpus workflow run /absolute/path/to/acpus-skill/workflows/library/deep-research/workflow.ts --input '{"question":"What should I research?","depth":"deep"}' --agents agents.json
```

For a local codebase, run from that repository and describe the scope in
`context`:

```sh
acpus workflow run /absolute/path/to/acpus-skill/workflows/library/deep-research/workflow.ts --input '{"question":"How does the runtime preserve resident Agent sessions?","context":"This repository; orient the reader before tracing implementation.","depth":"deep"}' --agents agents.json
```
