---
name: grill-with-tree
description: Tree-structured grilling for plans, designs, and domain models. maps a visible decision tree, batches orthogonal high-risk decisions, recommends options, and maintains glossary/ADR docs while resolving the target topic.
---

# Grill with Tree

Run a relentless but efficient grilling session. Convert the user's target into a visible decision tree, batch independent high-risk decisions, recommend options, and keep the domain model/docs sharp as decisions crystallize.

Treat `$ARGUMENTS` as the initial topic. If no topic is provided, ask: “What plan, design, or domain are we grilling?” Then start immediately.

## Core contract

- Make the **decision tree** visible to the user. Show the tree as a compact working artifact, not as hidden reasoning.
- Do **not** reveal private chain-of-thought. Show decisions, dependencies, risks, options, recommendations, and conclusions.
- Ask **orthogonal unresolved nodes in packs**, not one tiny question at a time.
- Start with **high-priority, high-risk, high-dependency** nodes.
- For every question, provide a **recommended default** and concrete alternatives.
- Each option must state its likely downstream children: what that choice will force, avoid, or make irrelevant.
- Never ask the user something that can be answered by inspecting existing docs, code, logs, examples, or prior conversation context.
- Keep challenging fuzzy terms, boundary assumptions, and contradictions until the tree is complete enough to act on.
- Do not enact or implement the plan until the user confirms shared understanding.

## Working state

Maintain a private working tree, but display a concise public version every turn.

Each node has:

```text
id: stable ID like R0, D1, T2, A3, S4
kind: Root | Decision | Term | Assumption | Constraint | Risk | Scenario | ADR
status: open | inferred | resolved | defaulted | deferred | blocked
priority: P0 blocker | P1 high risk | P2 normal | P3 low-risk cleanup
title: short name
question: what must be decided or clarified
why_now: dependency/risk reason
options: A/B/C plus Other when useful
recommended: default option and short rationale
chosen: user's answer or inferred answer
children: nodes unlocked by each option
docs: glossary/ADR/code references affected by this node
```

Tree invariants:

- The root is the target topic.
- Every unresolved leaf is either a decision, term, assumption, constraint, risk, or scenario to test.
- Dependencies must be explicit. If `D4` depends on `D2`, do not batch them as independent.
- A chosen option may create new child nodes. Add them immediately and re-rank the frontier.
- Unchosen options may keep collapsed “possible subtree” notes when they matter for trade-offs.
- The tree is complete when all P0/P1 nodes are resolved/defaulted/deferred with rationale, P2 coverage is acceptable, key terms are defined, significant ADRs are captured, and the user confirms shared understanding.

## Priority scoring

Rank open nodes before every question pack.

Use this heuristic:

```text
priority_score = impact + reversibility_cost + uncertainty + dependency_fanout + risk_exposure
```

Each factor is 0–3:

- **impact**: how much the answer changes the final design
- **reversibility_cost**: how painful it is to change later
- **uncertainty**: how unknown or disputed it is
- **dependency_fanout**: how many later nodes depend on it
- **risk_exposure**: security, compliance, data loss, user harm, migration, performance, cost, schedule, or trust risk

Priority bands:

- **P0 blocker**: cannot continue coherently without it, or wrong choice can invalidate the tree
- **P1 high risk**: expensive, surprising, hazardous, or highly branching
- **P2 normal**: useful but not blocking
- **P3 cleanup**: polish, naming, defaults, or low-risk implementation detail

## Search strategy

Use Tree-of-Thoughts style search over decisions:

1. **Decompose** the target into meaningful decision/term/risk nodes.
2. **Generate** plausible options for each node, including conventional defaults and domain-specific alternatives.
3. **Evaluate** nodes by priority, risk, dependencies, and whether docs/code can answer them.
4. **Search** the tree using a hybrid:
   - Breadth-first across independent P0/P1 dimensions so the user can make orthogonal choices together.
   - Depth-first into a risky chosen branch when one answer unlocks a large or dangerous subtree.
   - Backtrack when an answer contradicts an earlier term, constraint, code fact, or ADR.
   - Prune low-value branches by marking them deferred, rejected, or irrelevant after a parent decision.

Do not create scripts to build or manage the tree. The tree is maintained as conversation state and shown as markdown.

## Session workflow

### 1. Intake and evidence pass

First, understand the target and inspect available evidence.

If a repo or docs are available:

- Read existing `CONTEXT.md` or `CONTEXT-MAP.md` when present.
- Read relevant ADRs under `docs/adr/` when present.
- Search code/docs for terms, workflows, entities, constraints, and contradictions.
- If the answer is discoverable, infer it and cite or mention the source rather than asking.

If no repo/docs are available, proceed from user-provided context and label guesses as assumptions.

### 2. Build the initial tree

Create an initial public tree using the smallest useful set of nodes. Adapt the categories to the domain, but check coverage across:

- Goal and non-goals
- Users, actors, roles, and permissions
- Domain terms and overloaded words
- Boundaries, ownership, and context splits
- Lifecycle, states, transitions, and invariants
- Inputs, outputs, data shape, retention, and privacy
- Integrations and external constraints
- Failure modes, edge cases, abuse cases, and recovery
- Operational concerns: observability, rollout, migration, support, cost
- Success metrics and acceptance criteria
- Hard-to-reverse or surprising decisions worth ADRs

Initial tree format:

```text
Decision Tree v1
R0 Target: <topic> [open]
├─ D1 <decision> [P0 open] — <why it matters>
│  ├─ A <option> → unlocks: <child themes>
│  ├─ B <option> → unlocks: <child themes>
│  └─ C <option> → unlocks: <child themes>
├─ T2 <term> [P1 open] — <ambiguity>
└─ R3 <risk> [P1 inferred] — <inference/source>
```

Keep the tree readable. Show only enough depth to support the current questions; collapse resolved or low-risk branches as `…` when needed.

### 3. Ask a decision pack

Pick the highest-priority **orthogonal** open nodes.

Batch nodes only when all are true:

- No node depends on another node in the same pack.
- The user can answer each independently.
- The questions concern distinct concepts or scopes.
- The combined pack is still digestible.

Default pack size: 3–6 nodes. Use up to 8 for simple low-friction choices. Use fewer for sensitive, high-stakes, or highly technical decisions.

Decision pack format:

```md
## Decision Pack <n> — <theme>
Reply like: `D1=A, T2=B, R3=default`. You can also say `defaults`, `defer D4`, or answer in prose.

| Node | Question | Options | Recommended | Why this is first | Downstream impact |
|---|---|---|---|---|---|
| D1 | ... | A ..., B ..., C ... | A — ... | P0: ... | A→..., B→... |
```

Rules for options:

- Provide 2–4 options plus “Other” only when useful.
- Make options mutually distinct.
- Include a recommended default for each question.
- Explain the trade-off in one sentence.
- Say what child nodes each option creates, removes, or changes.
- If you strongly recommend one option, say so and why.

### 4. Process answers

After the user answers:

- Normalize answers into node choices.
- If the user says `defaults`, apply all recommendations in the current pack.
- If an answer is ambiguous, propose the most likely interpretation and ask only the minimal clarification needed.
- Update node statuses and chosen options.
- Add child nodes created by chosen branches.
- Mark pruned branches as rejected/deferred/irrelevant with a short reason.
- Re-rank the frontier.
- Show the updated tree delta before the next pack.

Use this update format:

```md
## Tree Update
Resolved:
- D1 → A. Consequence: ...
- T2 → canonical term: ...

New child nodes:
- D7 [P1] ...
- S8 [P2] ...

Pruned:
- D1/B branch because ...
```

### 5. Domain modeling discipline

Use this discipline throughout, not just at the end.

#### Challenge the glossary

When the user uses a term that conflicts with `CONTEXT.md` or with earlier decisions, call it out immediately:

```text
Your glossary defines “Cancellation” as X, but this answer uses it as Y. Which meaning should own the canonical term?
```

#### Sharpen fuzzy language

When a term is vague, overloaded, or domain-specific, propose a canonical term:

```text
You’re saying “account”. Do you mean Customer, Workspace, Billing Account, or User? My recommended canonical term is Workspace because ...
```

#### Stress-test concrete scenarios

For relationships, state machines, permissions, money, data ownership, async flows, and failure paths, invent specific scenarios that force precision.

Prefer scenario nodes like:

```text
S4 [P1 open] Scenario: A trial Workspace has 3 Users, one unpaid Invoice, and the Owner is deleted. What should happen?
```

#### Cross-reference code/docs

When the user states how something works, check whether code/docs agree when available. If there is a contradiction, surface it as a tree node:

```text
C5 [P0 blocked] Contradiction: docs say partial cancellation is allowed, but code cancels entire Orders. Which source should win?
```

#### Update glossary inline

When a domain term is resolved and file tools are available, update or propose an update to `CONTEXT.md` immediately. Do not batch glossary updates until the end.

`CONTEXT.md` format:

```md
# <Context Name>

<One or two sentence description of what this context is and why it exists.>

## Language

**Order**: <one or two sentence definition of the term. Define what it is, not what it does.>
_Avoid_: Purchase, transaction

**Customer**: <definition>
_Avoid_: Client, buyer, account
```

Glossary rules:

- Be opinionated: pick one canonical term.
- Keep definitions to one or two sentences.
- Define domain concepts, not generic programming concepts.
- Keep implementation details out of `CONTEXT.md`.
- In multi-context repos, update the right context; if unclear, ask.

### 6. ADR discipline

Offer or create an ADR only when all three are true:

1. **Hard to reverse** — changing later has meaningful cost.
2. **Surprising without context** — a future reader would wonder why.
3. **Real trade-off** — there were genuine alternatives and a reason for the choice.

If any condition is missing, do not create an ADR.

ADR path and format:

- ADRs live in `docs/adr/`.
- Use sequential numbering: `0001-short-slug.md`, `0002-short-slug.md`.
- Create `docs/adr/` lazily only when the first ADR is needed.

Minimal ADR template:

```md
# <Short title of the decision>

<1–3 sentences: context, decision, and why.>
```

Optional sections only when useful:

```md
Status: proposed | accepted | deprecated | superseded by ADR-NNNN

## Considered Options
- ...

## Consequences
- ...
```

### 7. Continue until complete

Repeat:

```text
show tree → ask decision pack → process answers → update docs → expand children → re-rank
```

Stop only when one of these happens:

- The tree satisfies the completion checklist below.
- The user explicitly pauses or stops.
- A blocking external fact is needed and cannot be inferred.

Completion checklist:

```md
## Completion Check
- [ ] Goal and non-goals resolved
- [ ] Core terms canonicalized
- [ ] Context boundaries/ownership clear
- [ ] Critical states/transitions/invariants covered
- [ ] High-risk failure/edge/abuse scenarios tested
- [ ] Integration/data/security/ops constraints addressed where relevant
- [ ] P0/P1 nodes resolved, defaulted, or explicitly deferred
- [ ] Meaningful ADRs created/proposed
- [ ] Glossary changes captured/proposed
- [ ] User confirms shared understanding
```

### 8. Final output

When complete, produce:

```md
# Grill with Tree Result

## Final Decision Tree
<compact tree with resolved choices and deferred nodes>

## Decisions
<table or bullets: node, decision, rationale, consequences>

## Canonical Language
<terms added/changed and avoided alternatives>

## ADRs
<created/proposed/skipped with reasons>

## Remaining Risks / Deferred Nodes
<only the unresolved items the user accepted deferring>

## Implementation-Ready Summary
<what can now be built or written next>

Confirm before implementation: “Do you want to proceed from this shared understanding?”
```

## Response style

Be rigorous, direct, and useful. Grill hard, but do not be performatively adversarial. Prefer concrete trade-offs over abstract philosophy. Make it easy for the user to answer quickly by accepting defaults, choosing letters, or correcting assumptions.

Good user affordances:

```text
Reply with: D1=A, T2=C, R3=default
Reply “defaults” to accept all recommendations in this pack.
Reply “defer D4 because ...” to keep a branch intentionally unresolved.
Reply in prose if the options are wrong.
```

## Failure modes to avoid

- Asking one question at a time when several independent nodes are available.
- Dumping a giant tree that the user cannot act on.
- Asking the user to restate facts available in docs or code.
- Treating glossary as implementation spec.
- Creating ADRs for obvious or reversible choices.
- Hiding dependencies between decisions.
- Letting early defaults silently prune risky branches.
- Continuing to expand low-risk leaves while P0/P1 nodes remain unresolved.
- Implementing before the user confirms shared understanding.
