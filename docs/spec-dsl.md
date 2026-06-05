# acpus DSL Reference & Canonical Specs

> Status: Normative reference (prototype scope)
> Stack: TypeScript + Temporal TS SDK. Expression engine: `@marcbachmann/cel-js`.
> Indexed by: `docs/PRD-acpus.md`. Companion: `docs/spec-cli.md`.

This is the authoritative DSL reference. It supersedes the demo specs in `acpus_draft_design.md` wherever they conflict — the 12 reconciliations below are normative.

---

## 1. Design principles

1. **Data, not code.** All dynamic computation lives in `${{ ... }}` (CEL); no embedded general-purpose language.
2. **Nodes are first-class.** Every step requires an `id`; its output is at `steps.<id>.output` (always a JSON object).
3. **Side effects are explicit.** `program` / `agent` steps annotate `side_effects: read | write | none`, which (with `idempotency_key`) gates safe auto-retry.
4. **Orthogonal, not piled-on.** 8 primitives: `run:agent` / `run:program` / `parallel` / `fanout` / `switch` / `loop` / `approval` / `subworkflow` (+ `include`).
5. **Composite output is explicit.** Every composite node must declare `outputFrom`; `lint` fails otherwise.

---

## 2. Spec skeleton

```yaml
version: 1
name: <workflow-name>
description: <human readable>
inputs:
  <param>: { type: string, required: true, default: <value> }
defaults:
  retry: { max_attempts: 3, initial_interval: 5s, backoff: 2.0 }
  timeout: 30m
agents:
  <ref>:
    type: claude-code | codex | opencode | mock | <acp-registry-id>
    model: <model>
    cwd: ${{ inputs.workspace }}
    env: { ... }
    tools_allowlist: [fs.read, fs.write, shell]
    max_concurrency: 1
    mock_script: ./tests/mock.yaml      # only when type: mock
workflow:
  steps: [ ... ]                        # implicit top-level pipeline
outputs:
  <key>: ${{ steps.<id>.output.<path> }}
```

> Removed vs draft: no `secrets:` block; no `artifacts.store` sugar (large values auto-offload to `artifact://` refs transparently).

---

## 3. The 8 primitives (corrected field tables)

### 3.1 `run: agent`
```
{ id, run: agent, use, prompt, expect?: { schema }, side_effects?, retry?, timeout?, on_error? }
```
- Sends `prompt` to an ACP agent session; waits for the final message.
- **Output is always a JSON object** at `steps.<id>.output`. `expect.schema` (JSONSchema/shape) is validated when present.
- Parse failure or schema failure triggers **continuation-retry** (within `retry.max_attempts`) using the fixed runtime continuation prompt.
- Prose belongs in a named string field of the JSON object (e.g. `plan_md`, `report_md`); large prose offloads to an `artifact://` ref field.

### 3.2 `run: program`
```
{ id, run: program, cmd, env?, idempotency_key?, side_effects?, output?: { from: stdout|file, path?, parse: json|text }, retry?, timeout? }
```
- Runs an external command. Default `output: { from: stdout, parse: text }`.
- `parse: json` parses stdout (or the named `file`) into a JSON object; `parse: text` yields a string at `steps.<id>.output`.
- Always exposes execution metadata: `steps.<id>.exit_code`, `steps.<id>.stdout_ref`, `steps.<id>.stderr_ref`.
- **Non-zero exit is data, not a runtime error.** Authors branch on `steps.<id>.exit_code` via `switch`.
- Auto-retry applies only when `side_effects: read|none` or `idempotency_key` is present; `side_effects: write` without a key → lint warning.

### 3.3 `parallel`
```
{ id, parallel: [ <named steps> ], max_concurrency?, join?: all|race, outputFrom }
```
- Each element must carry an `id`; `parallelBranchId` = that id. Default `join: all`.
- **Output = a map keyed by branch id**, projected via `outputFrom`. `on_error: continue` allowed per branch.

### 3.4 `fanout`
```
{ id, fanout: { over: <list>, key?: <expr>, max_concurrency?, join: all|race|quorum, quorum?, do: [ <named steps> ], outputFrom } }
```
- Items are exposed inside `do` via the fixed namespace `item` / `item_id` / `item_index` (no `as:`).
- `key: <expr>` designates the stable `fanoutItemId` (e.g. `key: ${{ item.path }}`); absent → index + lint warning.
- **Output = an ordered array** of each lane's `outputFrom`, indexed by `fanoutItemId`. Under `join: quorum` only completed lanes appear; metadata exposes which.

### 3.5 `switch`
```
{ id, switch: { on?: <expr>, cases: [ { when: <expr>, do: [ <named steps> ] } ], default?: { do: [ <named steps> ] } }, outputFrom }
```
- **Single-select:** the first `case` whose `when` is truthy runs; otherwise `default`. Every nested step needs an `id`.
- **Output = the selected case's `outputFrom`** (null if `default` produced none).

### 3.6 `loop`
```
{ id, loop: { until: <expr>, max_iterations, do: [ <named steps> ] }, outputFrom }
```
- **`until` only** (post-iteration check; runs ≥1). `max_iterations` is mandatory (hard cap).
- Inside the body: `loop.iter` (0-based index), `loop.last` (previous iteration's output object; null on first).
- Outside: `steps.<id>.last.<inner>.output` and `steps.<id>.iterations[]`. `outputFrom` projects the loop's exposed output.

### 3.7 `approval`
```
{ id, approval: { prompt, timeout, on_timeout: fail|escalate|approve|reject } }
```
- Waits for an external Signal; durable Timer backstop. No `channels` in the prototype (CLI/Signal delivery only).
- **Output = `{ approved: bool, decision: "approved"|"rejected"|"timeout", by?, comment?, at }`.** Branch via `switch` on `steps.<id>.output.approved`.

### 3.8 `subworkflow`
```
{ id, subworkflow: <path>, inputs: {...}, outputFrom? }
```
- Always an **awaited** child workflow (independently observable/cancelable via its own run id). No `async`.
- Output = the child's top-level `outputs` object at `steps.<id>.output` (optionally narrowed by `outputFrom`).

### 3.9 `include`
- Inlines another spec at compile time (flattened into the AST before freezing).

---

## 4. Expressions (CEL via `@marcbachmann/cel-js`)

- Context vars: `inputs.*`, `steps.<id>.output.*`, `steps.<id>.exit_code`, `loop.iter`, `loop.last`, `item` / `item_id` / `item_index` (fanout scope), `run_id`, `now()` (deterministic, from the workflow clock).
- Functions: `len`, `startsWith`, `matches`, `json.parse`, `hash.sha256`, `coalesce`.
- Types: string / int / bool / list / map.
- **Forbidden:** external I/O, randomness, system time. (No `secrets.*` — secrets are out of scope.)
- Precompiled at compile time; evaluated inside the deterministic workflow.

---

## 5. Retry model

- A single unified `retry: { max_attempts, initial_interval, backoff }` covers **both** transient Activity failures and agent continuation-retries (parse/schema). `defaults.retry` is inherited; step-level overrides.
- `side_effects` / `idempotency_key` gate whether program auto-retry is safe (lint warning on `write` without a key).

---

## 6. Canonical example specs

All four are rewritten per the 12 reconciliations and serve as lint/compile fixture seeds.

### Case A — plan-review-impl (sequential + approval + single agent)

```yaml
version: 1
name: plan-review-impl
inputs:
  feature: { type: string, required: true }
agents:
  planner: { type: claude-code, model: sonnet-4.5 }
  coder:   { type: codex,       model: gpt-5 }
workflow:
  steps:
    - id: plan
      run: agent
      use: planner
      prompt: |
        Read repo structure, then propose an implementation plan for:
          ${{ inputs.feature }}
        Return JSON with a `plan_md` string field (numbered steps + risk list).
      expect:
        schema: { type: object, required: [plan_md], properties: { plan_md: { type: string } } }

    - id: human_review
      approval:
        prompt: "Review steps.plan.output.plan_md. Approve to proceed?"
        timeout: 24h
        on_timeout: fail

    - id: implement
      run: agent
      use: coder
      side_effects: write
      prompt: |
        Implement this plan exactly:
        ${{ steps.plan.output.plan_md }}
        Open files, edit, and stage commits.
      expect:
        schema: { type: object, required: [commit_sha], properties: { commit_sha: { type: string } } }

    - id: test
      run: program
      cmd: ["bash", "-lc", "make test"]
      side_effects: read
      output: { from: stdout, parse: text }
      retry: { max_attempts: 2 }
outputs:
  plan: ${{ steps.plan.output.plan_md }}
  patch_ref: ${{ steps.implement.output.commit_sha }}
```

### Case B — multi-agent-review (fanout + quorum + switch)

```yaml
version: 1
name: multi-agent-review
inputs:
  pr_url: { type: string, required: true }
agents:
  claude: { type: claude-code, model: sonnet-4.5 }
  codex:  { type: codex,       model: gpt-5 }
  open:   { type: opencode,    model: glm-4.6 }
workflow:
  steps:
    - id: fetch_pr
      run: program
      cmd: ["bash", "-lc", "gh pr checkout ${{ inputs.pr_url }}"]
      side_effects: write
      output: { from: stdout, parse: text }

    - id: reviews
      fanout:
        over: ["security", "performance", "readability"]
        key: ${{ item }}
        max_concurrency: 3
        join: quorum
        quorum: 2
        do:
          - id: by_claude
            run: agent
            use: claude
            prompt: "Review PR ${{ inputs.pr_url }} for ${{ item }} issues. Return JSON {issues:[...]}."
            expect: { schema: { type: object, required: [issues] } }
            timeout: 10m
          - id: by_codex
            run: agent
            use: codex
            prompt: "Same task, Codex viewpoint, aspect ${{ item }}. Return JSON {issues:[...]}."
            expect: { schema: { type: object, required: [issues] } }
            timeout: 10m
          - id: by_open
            run: agent
            use: open
            prompt: "Same task, OpenCode viewpoint, aspect ${{ item }}. Return JSON {issues:[...]}."
            expect: { schema: { type: object, required: [issues] } }
            timeout: 10m
        outputFrom: by_claude

    - id: aggregate
      run: program
      cmd: ["acpus-tool", "vote", "--input", "${{ steps.reviews.output }}"]
      side_effects: none
      output: { from: stdout, parse: json }

    - id: gate
      approval:
        prompt: |
          Aggregated issues:
          ${{ steps.aggregate.output.summary_md }}
          Approve auto-comment to PR?
        timeout: 12h
        on_timeout: reject

    - id: post_comment
      switch:
        on: ${{ steps.gate.output.approved }}
        cases:
          - when: ${{ steps.gate.output.approved }}
            do:
              - id: do_comment
                run: program
                cmd: ["gh", "pr", "comment", "${{ inputs.pr_url }}", "--body-file", "${{ steps.aggregate.output.body_path }}"]
                side_effects: write
                output: { from: stdout, parse: text }
        default:
          do:
            - id: skip
              run: program
              cmd: ["echo", "skipped"]
              output: { from: stdout, parse: text }
      outputFrom: do_comment
```

### Case C — refactor-and-fix (fanout + subworkflow + loop + switch)

```yaml
version: 1
name: refactor-and-fix
inputs:
  module:         { type: string, required: true }
  from_framework: { type: string, required: true }
  to_framework:   { type: string, required: true }
agents:
  fixer: { type: codex, model: gpt-5 }
workflow:
  steps:
    - id: discover
      run: program
      cmd: ["acpus-tool", "list-files", "--module", "${{ inputs.module }}"]
      output: { from: stdout, parse: json }

    - id: rewrite_files
      fanout:
        over: ${{ steps.discover.output.files }}
        key: ${{ item.path }}
        max_concurrency: 4
        join: all
        do:
          - id: refactor_one
            subworkflow: ./refactor-one-file.spec.yaml
            inputs:
              file: ${{ item.path }}
              from: ${{ inputs.from_framework }}
              to:   ${{ inputs.to_framework }}
        outputFrom: refactor_one

    - id: fix_loop
      loop:
        until: ${{ coalesce(loop.last.tests_green, false) }}
        max_iterations: 5
        do:
          - id: run_tests
            run: program
            cmd: ["bash", "-lc", "pnpm test --json"]
            output: { from: file, path: .test.json, parse: json }
          - id: parse_failures
            run: program
            cmd: ["acpus-tool", "parse-jest", "--input", ".test.json"]
            output: { from: stdout, parse: json }
          - id: fix_round
            switch:
              cases:
                - when: ${{ len(steps.parse_failures.output.failures) > 0 }}
                  do:
                    - id: apply_fix
                      run: agent
                      use: fixer
                      side_effects: write
                      prompt: |
                        These tests failed in ${{ inputs.module }}:
                        ${{ steps.parse_failures.output.failures_md }}
                        Fix them. Do not change unrelated files. Return JSON {tests_green: bool}.
                      expect: { schema: { type: object, required: [tests_green] } }
              default:
                do:
                  - id: green
                    run: program
                    cmd: ["echo", "all green"]
                    output: { from: stdout, parse: text }
            outputFrom: apply_fix
        outputFrom: fix_round

    - id: final_gate
      approval:
        prompt: "Refactor done. Patches summarized in steps.fix_loop.iterations. Push branch?"
        timeout: 24h
        on_timeout: reject
outputs:
  pushed: ${{ steps.final_gate.output.approved }}
```

### Case D — deep-research (agent + dynamic fanout + loop)

```yaml
version: 1
name: deep-research
inputs:
  topic: { type: string, required: true }
  depth: { type: int,    default: 2 }
agents:
  planner:   { type: claude-code, model: opus-4 }
  collector: { type: opencode,    model: glm-4.6 }
  writer:    { type: codex,       model: gpt-5 }
workflow:
  steps:
    - id: plan
      run: agent
      use: planner
      prompt: |
        For topic "${{ inputs.topic }}", produce a JSON tree with up to
        ${{ inputs.depth }} levels of sub-questions. Return JSON {leaves:[{text}]}.
      expect: { schema: { type: object, required: [leaves] } }

    - id: collect
      fanout:
        over: ${{ steps.plan.output.leaves }}
        key: ${{ item.text }}
        max_concurrency: 8
        join: all
        do:
          - id: gather
            run: agent
            use: collector
            prompt: |
              Search the web and return JSON {q, findings:[{url, snippet}]}.
              Question: ${{ item.text }}
            expect: { schema: { type: object, required: [findings] } }
            timeout: 8m
            retry: { max_attempts: 3 }
        outputFrom: gather

    - id: refine
      loop:
        until: ${{ coalesce(loop.last.coverage, 0) >= 0.9 }}
        max_iterations: 3
        do:
          - id: replan
            run: agent
            use: planner
            prompt: |
              Given findings ${{ steps.collect.output }} and previous gaps
              ${{ coalesce(loop.last.gaps, []) }}, propose follow-up sub-questions.
              Return JSON {gaps:[], coverage: 0..1, outline_md: ""}.
            expect: { schema: { type: object, required: [coverage] } }
          - id: merge
            run: program
            cmd: ["acpus-tool", "merge-findings", "--in", ".findings.json"]
            output: { from: stdout, parse: json }
        outputFrom: replan

    - id: human_outline
      approval:
        prompt: "Outline & coverage in steps.refine.last.replan.output. Approve writing?"
        timeout: 6h
        on_timeout: reject

    - id: write
      run: agent
      use: writer
      prompt: |
        Write a research report (markdown) for "${{ inputs.topic }}"
        from outline ${{ steps.refine.last.replan.output.outline_md }}.
        Return JSON {report_md: ""}.
      expect: { schema: { type: object, required: [report_md] } }
outputs:
  report: ${{ steps.write.output.report_md }}
```
