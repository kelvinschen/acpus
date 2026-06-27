# Swarm Intelligence

A multi-role swarm intelligence discussion workflow — four specialized agents (Challenger, Builder, Synthesizer, Empiricist) debate a topic through a shared blackboard, gradually converging from divergence to consensus.

## Design

### Blackboard Model + Role Specialization

Inspired by insect-colony collective decision-making: individuals perceive only local information (the blackboard), interact through simple rules (contribute / object / evidence), and high-quality consensus emerges at the group level.

Four roles, each with a distinct mandate, form an adversarial collaboration:

| Role | Mandate | Typical contributions |
|------|---------|----------------------|
| **Challenger** | Finds weaknesses, raises objections, prevents groupthink | objection, question |
| **Builder** | Constructs solutions, responds to objections, drives consensus | proposal, claim |
| **Synthesizer** | Spots patterns, bridges perspectives, surfaces implicit agreement | claim, evidence |
| **Empiricist** | Grounds discussion in evidence, cites precedents, curbs hallucination | evidence, objection |

### Convergence

The loop does not run forever. Three exit conditions, any one triggers a stop:

1. **Semantic Stop** — enough agents vote `ready_to_stop` (≥ `stop_vote_quorum`), with no `block_stop` votes, for `stop_patience` consecutive rounds. This is the normal convergence path.
2. **Activity Saturation** — cognitive activity stays ≤ `saturation_threshold` for `saturation_patience` consecutive rounds. Detects a discussion that has naturally exhausted itself without an explicit vote.
3. **Max Rounds** — reaches `max_iterations` (hard cap 50 rounds), the safety valve.

`block_stop` is the critical safety mechanism: any agent that believes an unresolved material issue remains may cast a block vote with references to the unresolved contributions. Even if ready votes reach quorum, a block prevents the stop.

### Attention Assignment

At the start of each round, the `assign_attention` step builds a Mandatory Attention Set for each role:

- With ≤ 6 active claims, every role reviews all of them.
- With more claims, assignment follows contribution-type affinity (objection → Challenger, proposal → Builder, evidence → Empiricist, claim → Synthesizer), backfilled with cross-affinity and round-robin.
- Each agent must reference at least one claim from its attention set in its contributions; silence implies consent.

This prevents attention dilution — when the blackboard holds many contributions, each one still gets reviewed.

### Deterministic Merge

The `merge` step is fully deterministic (`swarm.mjs`), with no LLM calls:

- **Validation** — checks every agent's output JSON structure, stance consistency, and reference validity. Non-compliant contributions are dropped wholesale and the agent is quarantined for that round.
- **Conflict resolution** — a strong objection (confidence ≥ `block_confidence_threshold`) marks the target claim contested; high-quality evidence can restore a contested claim.
- **Consensus promotion** — a claim with confidence ≥ `consensus_confidence` and no unresolved objection is auto-promoted to consensus.
- **Eviction** — contested claims lacking evidence, or objections lacking support, are marked withdrawn after a grace period.
- **Event sourcing** — every state transition (promotion, contest, withdrawal, quarantine, dangling reference) is recorded in an append-only `events` log.

### Session Continuity

Each agent reuses its session across rounds via `session_key`, preserving its own chain of thought. Agents perceive the group only through the blackboard and never see another agent's internal reasoning — this information isolation is essential.

## Quick Start

### Run

```sh
acpus workflows run .acpus/workflows/swarm-intelligence/workflow.spec.yaml \
  --input '{"topic": "your discussion topic"}'
```

With context and tuned parameters:

```sh
acpus workflows run .acpus/workflows/swarm-intelligence/workflow.spec.yaml \
  --input '{
    "topic": "your discussion topic",
    "context": "background, constraints, reference URLs for agents to look up…",
    "max_rounds": 15,
    "min_rounds": 3,
    "language": "english"
  }'
```

Run in the background (recommended; a discussion can take several minutes):

```sh
acpus workflows run .acpus/workflows/swarm-intelligence/workflow.spec.yaml \
  --background \
  --input '{"topic": "your discussion topic"}'
```

### Input Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `topic` | string | *(required)* | Discussion topic |
| `context` | string | `""` | Background context; may include URLs for agents to fetch |
| `max_rounds` | integer | `50` | Maximum rounds (hard cap 50) |
| `min_rounds` | integer | `3` | Minimum rounds before stop conditions are evaluated |
| `stop_vote_quorum` | integer | `3` | Ready votes required for semantic stop |
| `stop_patience` | integer | `2` | Consecutive rounds the stop condition must hold |
| `consensus_confidence` | integer | `4` | Minimum confidence to promote a claim to consensus |
| `ready_confidence_threshold` | integer | `4` | Minimum confidence for a ready vote |
| `block_confidence_threshold` | integer | `4` | Minimum confidence for a block vote |
| `saturation_threshold` | integer | `0` | Cognitive activity at or below this counts as saturated |
| `saturation_patience` | integer | `2` | Consecutive saturated rounds to trigger saturation exit |
| `language` | string | `"english"` | Output language |
| `serve_viz` | boolean | `false` | Start the live visualization server during the run |
| `output_root` | string | `".acpus/output/swarm-intelligence"` | Output directory |

### View Results

```sh
# Show Run status
acpus runs show <runId>

# Read the summary report
cat .acpus/output/swarm-intelligence/<runId>/summary.md

# Read the full blackboard (all contributions, debates, state transitions)
cat .acpus/output/swarm-intelligence/<runId>/blackboard.md
```

### Visualization

Start live visualization during a run:

```sh
acpus workflows run .acpus/workflows/swarm-intelligence/workflow.spec.yaml \
  --input '{"topic": "your topic", "serve_viz": true}'
```

Export a self-contained HTML after the run finishes:

```sh
node .acpus/workflows/swarm-intelligence/scripts/viz/viz-server.mjs \
  export .acpus/output/swarm-intelligence/<runId> viz.html
```

The exported HTML inlines all frontend assets and the blackboard snapshot — open it directly in a browser or deploy to static hosting.

Four views:

1. **Chronicle** — round-by-round debate timeline grouped by role
2. **Graph** — contribution reference network, with adjustable minimum-confidence filter
3. **Trajectory** — how the board's state evolves over rounds
4. **Scorecard** — terminal-state summary, vote distribution, unresolved material
