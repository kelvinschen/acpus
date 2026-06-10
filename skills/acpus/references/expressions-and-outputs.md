# Expressions And Outputs

## CEL vs Template Interpolation

Use raw CEL where Acpus expects an expression:

```yaml
- id: require_changes
  guard:
    when: steps.collect.output.changed_file_count > 0
    then: continue
    else: fail

- id: repair
  loop:
    until: loop.iter > 0 && loop.last.ok
    steps: [...]

- id: review_files
  fanout:
    over: steps.plan.output.items
    key: "${{ item.id }}"
    steps: [...]
```

Use `${{ ... }}` inside text templates:

```yaml
prompt: |
  Review ${{ input.target }} using report ${{ steps.prepare.output.report_path }}.

key: "${{ item.id }}"
message: "No files changed for ${{ input.target }}"
```

Do not wrap `when`, `until`, or expression-valued `over` in `${{ ... }}`.

## Step Output Shapes

Agent and Program Steps expose an envelope:

```yaml
steps.review.output.summary
steps.collect.output.report_path
steps.collect.exit_code
```

Other step kinds expose their produced value directly:

```yaml
# parallel is a record keyed by branch id
steps.review_parallel.contract.output.summary
steps.review_parallel.tests.output.summary

# fanout is an array of successful lane outputs
steps.research_lanes[0].output.report_path

# guard is direct
steps.require_ready.matched
steps.require_ready.action

# approval is direct
steps.human_gate.approved
steps.human_gate.decision
```

Avoid `steps.<composite>.output`; composites do not add an `output` wrapper.

## Output Schema Shape

Keep output schemas shallow:

```yaml
output:
  report_path: string
  summary: string
  risk_count: integer
  ready: boolean
```

Avoid returning full reports, nested transcript fragments, or intermediate chain-of-thought-like material. Write those to files and output the file path.
