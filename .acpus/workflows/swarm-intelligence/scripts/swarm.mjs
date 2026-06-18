#!/usr/bin/env node
// swarm.mjs - Deterministic helper CLI for the swarm-intelligence workflow.
// Usage:
//   node swarm.mjs init <output_dir> <topic> [context]
//   node swarm.mjs summary <blackboard_json_path> [role]
//   node swarm.mjs attention <blackboard_json_path>
//   node swarm.mjs merge <blackboard_json_path> <consensus_confidence> <saturation_threshold> <saturation_patience> \
//     <min_rounds> <stop_vote_quorum> <stop_patience> <ready_confidence_threshold> <block_confidence_threshold> \
//     <challenger_path> <builder_path> <synthesizer_path> <empiricist_path>
//   node swarm.mjs finalize <blackboard_json_path> <max_rounds>

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROLES = ["challenger", "builder", "synthesizer", "empiricist"];
const ACTIVE_CLAIM_LIMIT = 8;
const WITHDRAWN_COLLAPSE_THRESHOLD = 5;
const VALID_STANCES = new Set(["contribute", "quiet", "ready_to_stop", "block_stop"]);
const VALID_VOTES = new Set(["none", "ready", "block"]);
const VALID_CONTRIBUTION_TYPES = new Set(["objection", "question", "claim", "proposal", "evidence"]);
const VALID_TERMINAL_STATES = new Set([
  "consensus",
  "bounded_disagreement",
  "external_action_required",
  "inconclusive",
]);
const ROLE_SHORT = {
  challenger: "chal",
  builder: "build",
  synthesizer: "synth",
  empiricist: "emp",
};

// Flags claims that the deterministic merge rules will withdraw next round
// unless an agent supports them, giving the swarm a chance to rescue them.
function withdrawalWarning(c) {
  const rwe = c.rounds_without_evidence || 0;
  if (c.status === "contested" && rwe >= 1) {
    return " ⏳ withdrawn next round unless supported by evidence";
  }
  if (c.type === "objection" && c.status === "active" && rwe >= 2) {
    return " ⏳ withdrawn next round unless backed by new evidence";
  }
  return "";
}

export function generateMarkdown(bb) {
  const lines = [];
  lines.push(`# Swarm Blackboard: ${bb.topic}`);
  lines.push("");

  if (bb.context) {
    lines.push("## Context");
    lines.push(bb.context);
    lines.push("");
  }

  if (bb.control && bb.control.stop) {
    const stop = bb.control.stop;
    lines.push("## Control State");
    lines.push("");
    lines.push(`Semantic stop: ${Boolean(stop.semantic_stop)}`);
    lines.push(`Ready votes: ${stop.ready_votes || 0}`);
    lines.push(`Block votes: ${stop.block_votes || 0}`);
    lines.push(`Contribute votes: ${stop.contribute_votes || 0}`);
    lines.push(`Quiet votes: ${stop.quiet_votes || 0}`);
    lines.push(`Semantic stop streak: ${stop.semantic_stop_streak || 0}`);
    if (stop.semantic_terminal_state) {
      lines.push(`Semantic terminal state: ${stop.semantic_terminal_state}`);
    }
    if (stop.blockers && stop.blockers.length > 0) {
      lines.push("");
      lines.push("Valid blockers:");
      for (const blocker of stop.blockers) {
        lines.push(`- ${blocker.role}: ${blocker.reason}`);
      }
    }
    lines.push("");
  }

  const consensus = bb.contributions.filter(
    (c) => c.status === "consensus"
  );
  const active = bb.contributions.filter(
    (c) => c.status === "active" || c.status === "contested"
  );
  const withdrawn = bb.contributions.filter(
    (c) => c.status === "withdrawn"
  );

  if (consensus.length > 0) {
    lines.push("## Consensus");
    lines.push("(confidence ≥ 4, no unresolved objections)");
    lines.push("");
    for (const c of consensus) {
      const stars = "★".repeat(c.confidence);
      lines.push(`- [${c.id}] [${c.type}] ${c.summary} ${stars}`);
    }
    lines.push("");
  }

  if (active.length > 0) {
    lines.push("## Active Discussion");
    lines.push("");
    for (const c of active) {
      const stars = "★".repeat(c.confidence);
      const statusTag = c.status === "contested" ? " ⚠️ contested" : "";
      const refs =
        c.references && c.references.length > 0
          ? ` → refs: ${c.references.join(", ")}`
          : "";
      lines.push(
        `- [${c.id}] [${c.type}] ${c.summary} ${stars}${statusTag}${refs}`
      );
    }
    lines.push("");
  }

  if (withdrawn.length > 0) {
    lines.push("## Resolved / Withdrawn");
    lines.push("");
    for (const c of withdrawn) {
      lines.push(`- [${c.id}] ~~[${c.type}] ${c.summary}~~ → ${c.status}`);
    }
    lines.push("");
  }

  const byRound = {};
  for (const c of bb.contributions) {
    const roundNum = c.round;
    if (!byRound[roundNum]) byRound[roundNum] = [];
    byRound[roundNum].push(c);
  }

  const rounds = Object.keys(byRound)
    .map(Number)
    .sort((a, b) => a - b);
  if (rounds.length > 0) {
    lines.push("## Rationale Archive");
    lines.push("");
    for (const r of rounds) {
      lines.push(`### Round ${r}`);
      for (const c of byRound[r]) {
        if (c.rationale) {
          lines.push(`**${c.id} (${c.role})**: ${c.rationale}`);
        }
      }
      lines.push("");
    }
  }

  lines.push("---");
  lines.push(
    `Round: ${bb.round} | Content consensus: ${bb.metrics.has_consensus} | Semantic stop: ${Boolean(bb.metrics.semantic_stop)} | Activity saturated: ${bb.metrics.is_saturated} | New contributions: ${bb.metrics.new_contributions_count}`
  );

  return lines.join("\n");
}

export function initBlackboard({ outputDir, topic, context = "" }) {
  if (!outputDir || !topic) {
    throw new Error("Usage: swarm.mjs init <output_dir> <topic> [context]");
  }

  const dir = resolve(outputDir);
  mkdirSync(dir, { recursive: true });

  const blackboard = {
    topic,
    context,
    contributions: [],
    history: [],
    events: [],
    metrics: {
      has_consensus: false,
      is_saturated: false,
      semantic_stop: false,
      new_contributions_count: 0,
    },
    control: {
      stop: {
        semantic_stop: false,
        semantic_stop_streak: 0,
        ready_votes: 0,
        block_votes: 0,
        contribute_votes: 0,
        quiet_votes: 0,
        blockers: [],
        semantic_terminal_state: null,
      },
    },
    round: 0,
  };

  const jsonPath = join(dir, "blackboard.json");
  const mdPath = join(dir, "blackboard.md");

  writeFileSync(jsonPath, JSON.stringify(blackboard, null, 2), "utf-8");
  writeFileSync(mdPath, generateMarkdown(blackboard), "utf-8");

  return {
    blackboard_json_path: jsonPath,
    blackboard_md_path: mdPath,
    blackboard_dir: dir,
  };
}

export function summarizeBlackboard({ blackboardJsonPath, role }) {
  if (!blackboardJsonPath) {
    throw new Error("Usage: swarm.mjs summary <blackboard_json_path> [role]");
  }

  const resolved = resolve(blackboardJsonPath);
  const bb = JSON.parse(readFileSync(resolved, "utf-8"));
  const mdPath = resolved.replace(/blackboard\.json$/, "blackboard.md");

  let attentionIds = [];
  let attentionText = "";

  if (role) {
    const bbDir = dirname(resolved);
    const attentionPath = join(bbDir, `attention-${role}.json`);
    if (existsSync(attentionPath)) {
      const attData = JSON.parse(readFileSync(attentionPath, "utf-8"));
      attentionIds = attData.attention_set || [];
      attentionText = attData.attention_text || "";
    }
  }

  const consensus = bb.contributions.filter((c) => c.status === "consensus");
  const active = bb.contributions.filter(
    (c) => c.status === "active" || c.status === "contested"
  );
  const withdrawn = bb.contributions.filter((c) => c.status === "withdrawn");

  const lines = [];
  lines.push(`Topic: ${bb.topic}`);
  if (bb.context) {
    lines.push(`Context: ${bb.context}`);
  }
  lines.push(`Current round: ${bb.round}`);
  lines.push("");

  if (consensus.length > 0) {
    lines.push("## Consensus");
    for (const c of consensus) {
      const stars = "★".repeat(c.confidence);
      lines.push(`- [${c.id}] [${c.type}] ${c.summary} ${stars}`);
    }
    lines.push("");
  }

  if (attentionIds.length > 0 && attentionText) {
    lines.push("## Your Mandatory Attention Set");
    lines.push(
      "You MUST reference at least one of these claims in your contributions:"
    );
    lines.push(attentionText);
    lines.push("");
  }

  if (active.length > 0) {
    lines.push("## Active Discussion");

    if (active.length <= ACTIVE_CLAIM_LIMIT) {
      for (const c of active) {
        const stars = "★".repeat(c.confidence);
        const tag = c.status === "contested" ? " ⚠️" : "";
        const refs =
          c.references && c.references.length > 0
            ? ` → refs: ${c.references.join(", ")}`
            : "";
        lines.push(
          `- [${c.id}] [${c.type}] ${c.summary} ${stars}${tag}${refs}${withdrawalWarning(c)}`
        );
      }
    } else {
      const sorted = [...active].sort((a, b) => {
        if (b.confidence !== a.confidence) return b.confidence - a.confidence;
        return a.id.localeCompare(b.id);
      });

      const topN = sorted.slice(0, ACTIVE_CLAIM_LIMIT);
      const topIds = new Set(topN.map((c) => c.id));
      const attentionClaimsNotInTop = active.filter(
        (c) => attentionIds.includes(c.id) && !topIds.has(c.id)
      );

      for (const c of topN) {
        const stars = "★".repeat(c.confidence);
        const tag = c.status === "contested" ? " ⚠️" : "";
        const refs =
          c.references && c.references.length > 0
            ? ` → refs: ${c.references.join(", ")}`
            : "";
        lines.push(
          `- [${c.id}] [${c.type}] ${c.summary} ${stars}${tag}${refs}${withdrawalWarning(c)}`
        );
      }

      if (attentionClaimsNotInTop.length > 0) {
        lines.push("");
        lines.push("(From your attention set, below the top rankings:)");
        for (const c of attentionClaimsNotInTop) {
          const stars = "★".repeat(c.confidence);
          const tag = c.status === "contested" ? " ⚠️" : "";
          const refs =
            c.references && c.references.length > 0
              ? ` → refs: ${c.references.join(", ")}`
              : "";
          lines.push(
            `- [${c.id}] [${c.type}] ${c.summary} ${stars}${tag}${refs}${withdrawalWarning(c)}`
          );
        }
      }

      const shown = ACTIVE_CLAIM_LIMIT + attentionClaimsNotInTop.length;
      const remaining = active.length - shown;
      if (remaining > 0) {
        lines.push("");
        lines.push(
          `... and ${remaining} more active claims (see blackboard_md_path for full list)`
        );
      }
    }
    lines.push("");
  }

  if (withdrawn.length > 0) {
    lines.push("## Withdrawn");
    if (withdrawn.length <= WITHDRAWN_COLLAPSE_THRESHOLD) {
      for (const c of withdrawn) {
        lines.push(`- [${c.id}] ~~${c.summary}~~`);
      }
    } else {
      lines.push(
        `${withdrawn.length} withdrawn contributions (see full blackboard at blackboard_md_path)`
      );
    }
    lines.push("");
  }

  lines.push("---");

  if (bb.metrics.quarantined_agents && bb.metrics.quarantined_agents.length > 0) {
    lines.push("");
    lines.push("## ⚠️ Integrity Warnings");
    for (const q of bb.metrics.quarantined_agents) {
      lines.push(`- Agent ${q.role} output was quarantined last round (${q.reason}); its contributions were dropped.`);
    }
  }

  if (bb.metrics.dangling_references && bb.metrics.dangling_references.length > 0) {
    if (!(bb.metrics.quarantined_agents && bb.metrics.quarantined_agents.length > 0)) {
      lines.push("");
      lines.push("## ⚠️ Integrity Warnings");
    }
    for (const d of bb.metrics.dangling_references) {
      lines.push(`- ${d.from} references unknown id ${d.ref}; the link was ignored.`);
    }
  }

  if (bb.metrics.protocol_warnings && bb.metrics.protocol_warnings.length > 0) {
    if (
      !(bb.metrics.quarantined_agents && bb.metrics.quarantined_agents.length > 0) &&
      !(bb.metrics.dangling_references && bb.metrics.dangling_references.length > 0)
    ) {
      lines.push("");
      lines.push("## ⚠️ Integrity Warnings");
    }
    for (const warning of bb.metrics.protocol_warnings) {
      lines.push(`- Agent ${warning.role} packet had a protocol warning (${warning.reason}); usable content was kept, but semantic stop cannot advance this round.`);
    }
  }

  if (bb.metrics.momentum_report) {
    const mr = bb.metrics.momentum_report;
    lines.push("");
    lines.push("## Board Momentum");
    lines.push(`Round ${mr.round}: ${mr.objections_raised} objections, ${mr.evidence_provided} evidence`);
    lines.push(`Consensus: +${mr.claims_promoted_to_consensus} promoted | Challenges: ${mr.claims_demoted_or_contested} contested/demoted`);
    lines.push(`Confidence trend: ${mr.confidence_net_direction}`);
    if (typeof mr.round_activity === "number") {
      lines.push(`Board activity this round: ${mr.round_activity} (saturation triggers when this stays low)`);
    }
  }

  if (bb.metrics.stop_report) {
    const sr = bb.metrics.stop_report;
    lines.push("");
    lines.push("## Stop Readiness");
    lines.push(`Ready: ${sr.ready_votes}/${ROLES.length} | Blocks: ${sr.block_votes} | Contributions: ${sr.contribute_votes} | Quiet: ${sr.quiet_votes}`);
    lines.push(`Semantic stop candidate: ${sr.semantic_stop_candidate} | Streak: ${sr.semantic_stop_streak}`);
    if (sr.semantic_terminal_state) {
      lines.push(`Semantic terminal state: ${sr.semantic_terminal_state}`);
    }
    if (sr.blockers && sr.blockers.length > 0) {
      lines.push("Valid blockers:");
      for (const blocker of sr.blockers) {
        lines.push(`- ${blocker.role}: ${blocker.reason}`);
      }
    }
  }

  lines.push(
    `Content consensus reached: ${bb.metrics.has_consensus} | Semantic stop: ${Boolean(bb.metrics.semantic_stop)} | Activity saturated: ${bb.metrics.is_saturated}`
  );

  return {
    summary: lines.join("\n"),
    blackboard_md_path: mdPath,
  };
}

function seededShuffle(arr, seed) {
  const result = [...arr];
  let s = seed;
  for (let i = result.length - 1; i > 0; i--) {
    s = (s * 1664525 + 1013904223) & 0xffffffff;
    const j = (s >>> 0) % (i + 1);
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

function assignAttentionSets(activeClaims, round) {
  if (activeClaims.length <= 6) {
    const claimIds = activeClaims.map((c) => c.id);
    const result = {};
    for (const role of ROLES) {
      result[role] = claimIds;
    }
    return result;
  }

  const affinityMap = {
    objection: "challenger",
    question: "challenger",
    proposal: "builder",
    evidence: "empiricist",
    claim: "synthesizer",
  };

  const result = {};
  for (const role of ROLES) {
    result[role] = [];
  }

  const assigned = new Set();
  const perRoleCap = Math.ceil(activeClaims.length / ROLES.length) + 1;
  const affinityCap = Math.ceil(perRoleCap / 2);
  const shuffled = seededShuffle(activeClaims, round * 7);

  for (const claim of shuffled) {
    const preferredRole = affinityMap[claim.type];
    if (preferredRole && result[preferredRole].length < affinityCap && !assigned.has(claim.id)) {
      result[preferredRole].push(claim.id);
      assigned.add(claim.id);
    }
  }

  const crossAffinity = {
    challenger: "proposal",
    builder: "objection",
    empiricist: "claim",
    synthesizer: "evidence",
  };

  const remaining = shuffled.filter((c) => !assigned.has(c.id));
  const stillUnassigned = [];

  for (const claim of remaining) {
    let crossAssigned = false;
    for (const role of ROLES) {
      if (crossAffinity[role] === claim.type && result[role].length < perRoleCap) {
        result[role].push(claim.id);
        crossAssigned = true;
        break;
      }
    }
    if (!crossAssigned) {
      stillUnassigned.push(claim);
    }
  }

  let rrIdx = 0;
  for (const claim of stillUnassigned) {
    while (result[ROLES[(rrIdx + round) % ROLES.length]].length >= perRoleCap) {
      rrIdx++;
    }
    result[ROLES[(rrIdx + round) % ROLES.length]].push(claim.id);
    rrIdx++;
  }

  return result;
}

export function assignAttention({ blackboardJsonPath }) {
  if (!blackboardJsonPath) {
    throw new Error("Usage: swarm.mjs attention <blackboard_json_path>");
  }

  const resolved = resolve(blackboardJsonPath);
  const bb = JSON.parse(readFileSync(resolved, "utf-8"));
  const bbDir = dirname(resolved);

  const activeClaims = bb.contributions.filter(
    (c) => c.status === "active" || c.status === "contested"
  );

  const round = bb.round || 0;
  const assignments = assignAttentionSets(activeClaims, round);
  const output = {};

  for (const role of ROLES) {
    const ids = assignments[role];
    const claimDetails = activeClaims.filter((c) => ids.includes(c.id));
    const lines = [];
    for (const c of claimDetails) {
      const stars = "★".repeat(c.confidence);
      const tag = c.status === "contested" ? " ⚠️" : "";
      lines.push(`- [${c.id}] [${c.type}] ${c.summary} ${stars}${tag}`);
    }

    const attentionData = {
      role,
      round,
      attention_set: ids,
      attention_text: lines.join("\n"),
    };

    const filePath = join(bbDir, `attention-${role}.json`);
    writeFileSync(filePath, JSON.stringify(attentionData, null, 2), "utf-8");

    output[`${role}_attention`] = filePath;
    output[`${role}_attention_text`] = attentionData.attention_text;
    output[`${role}_attention_set`] = ids.join(",");
  }

  const allAssigned = new Set(Object.values(assignments).flat());
  const uncovered = activeClaims.filter((c) => !allAssigned.has(c.id));
  if (uncovered.length > 0 && activeClaims.length > 6) {
    console.error(
      `WARNING: ${uncovered.length} active claims not covered by any attention set: ` +
        uncovered.map((c) => c.id).join(", ")
    );
  }

  output.total_active_claims = activeClaims.length;
  output.coverage = allAssigned.size;
  return output;
}

function parseConfidence(value, fieldName, errors) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 5) {
    errors.push(`${fieldName} must be an integer from 1 to 5`);
    return null;
  }
  return parsed;
}

function validateContribution(c, idx, knownIds = null) {
  const errors = [];
  const warnings = [];
  if (!c || typeof c !== "object" || Array.isArray(c)) {
    return { errors: [`contributions[${idx}] must be an object`] };
  }
  if (!VALID_CONTRIBUTION_TYPES.has(c.type)) {
    errors.push(`contributions[${idx}].type must be one of ${[...VALID_CONTRIBUTION_TYPES].join(", ")}`);
  }
  if (typeof c.summary !== "string" || c.summary.trim().length === 0) {
    errors.push(`contributions[${idx}].summary must be a non-empty string`);
  }
  parseConfidence(c.confidence, `contributions[${idx}].confidence`, errors);
  if (!Array.isArray(c.references) || c.references.some((ref) => typeof ref !== "string" || ref.trim().length === 0)) {
    errors.push(`contributions[${idx}].references must be an array of non-empty strings`);
  }
  if (knownIds) {
    for (const ref of c.references || []) {
      if (!knownIds.has(ref)) {
        errors.push(`contributions[${idx}].references contains unknown id ${ref}`);
      }
    }
  }
  if (errors.length > 0) return { errors };
  return {
    errors: [],
    contribution: {
      type: c.type,
      summary: c.summary.trim().slice(0, 300),
      confidence: Number(c.confidence),
      references: c.references,
    },
  };
}

function normalizeRef(ref) {
  return typeof ref === "string" ? ref.trim().replace(/^\[|\]$/g, "") : ref;
}

function normalizeRefs(refs) {
  return Array.isArray(refs) ? refs.map(normalizeRef) : refs;
}

// Reads one agent's decision packet. A malformed agent output must not abort
// the whole round, so failures quarantine that role for the round.
function readAttentionIds(filePath, role) {
  try {
    const attentionPath = join(dirname(resolve(filePath)), `attention-${role}.json`);
    if (!existsSync(attentionPath)) return [];
    const data = JSON.parse(readFileSync(attentionPath, "utf-8"));
    return Array.isArray(data.attention_set) ? data.attention_set : [];
  } catch {
    return [];
  }
}

function readDecisionPacket(role, filePath, options = {}) {
  let data;
  try {
    const resolved = resolve(filePath);
    data = JSON.parse(readFileSync(resolved, "utf-8"));
  } catch (error) {
    return { stance: "quarantined", contribs: [], rationale: "", quarantine: `unreadable: ${error.message}` };
  }

  const errors = [];
  const warnings = [];
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { stance: "quarantined", contribs: [], rationale: "", quarantine: "decision packet must be an object" };
  }

  if (!VALID_STANCES.has(data.stance)) {
    errors.push(`stance must be one of ${[...VALID_STANCES].join(", ")}`);
  }
  if (!Array.isArray(data.contributions)) {
    errors.push("contributions field must be an array");
  }

  if (!("stop_vote" in data)) {
    errors.push("stop_vote field is required");
  }
  if (!("rationale" in data) || typeof data.rationale !== "string") {
    errors.push("rationale field must be a string");
  }

  const stopVote = data.stop_vote || {};
  if (!stopVote || typeof stopVote !== "object" || Array.isArray(stopVote)) {
    errors.push("stop_vote must be an object");
  }
  const rawVote = stopVote.vote || "none";
  let vote = rawVote;
  if (!VALID_VOTES.has(vote)) {
    if (data.stance === "contribute" || data.stance === "quiet") {
      warnings.push(`ignored invalid stop_vote.vote ${String(rawVote)} for ${data.stance} stance`);
      vote = "none";
    } else {
    errors.push(`stop_vote.vote must be one of ${[...VALID_VOTES].join(", ")}`);
    }
  }

  const contributions = [];
  if (Array.isArray(data.contributions)) {
    data.contributions.forEach((contribution, idx) => {
      const validated = validateContribution(contribution, idx);
      if (validated.errors.length > 0) errors.push(...validated.errors);
      else contributions.push({
        ...validated.contribution,
        references: normalizeRefs(validated.contribution.references),
      });
    });
  }

  const stance = data.stance;
  if (stance === "contribute") {
    if (contributions.length < 1 || contributions.length > 3) {
      errors.push("contribute stance requires 1-3 contributions");
    }
    if (vote !== "none") {
      warnings.push("contribute stance stop_vote was ignored; vote must be none");
    }
  } else if (stance === "quiet") {
    if (contributions.length !== 0) {
      errors.push("quiet stance requires zero contributions");
    }
    if (vote !== "none") {
      warnings.push("quiet stance stop_vote was ignored; vote must be none");
    }
  } else if (stance === "ready_to_stop") {
    if (contributions.length !== 0) {
      errors.push("ready_to_stop stance requires zero contributions");
    }
    if (vote !== "ready") {
      errors.push("ready_to_stop stance requires stop_vote.vote to be ready");
    }
    const confidence = parseConfidence(stopVote.confidence, "stop_vote.confidence", errors);
    if (confidence !== null && confidence < options.readyConfidenceThreshold) {
      errors.push(`ready_to_stop confidence must be >= ${options.readyConfidenceThreshold}`);
    }
    if (stopVote.attention_set_reviewed !== true) {
      errors.push("ready_to_stop requires stop_vote.attention_set_reviewed to be true");
    }
    if (typeof stopVote.reason !== "string" || stopVote.reason.trim().length === 0) {
      errors.push("ready_to_stop requires non-empty stop_vote.reason");
    }
    if (
      stopVote.semantic_terminal_state !== undefined &&
      !VALID_TERMINAL_STATES.has(stopVote.semantic_terminal_state)
    ) {
      errors.push(`stop_vote.semantic_terminal_state must be one of ${[...VALID_TERMINAL_STATES].join(", ")}`);
    }
  } else if (stance === "block_stop") {
    if (contributions.length < 1 || contributions.length > 3) {
      errors.push("block_stop stance requires 1-3 contributions");
    }
    if (vote !== "block") {
      errors.push("block_stop stance requires stop_vote.vote to be block");
    }
    const confidence = parseConfidence(stopVote.confidence, "stop_vote.confidence", errors);
    if (confidence !== null && confidence < options.blockConfidenceThreshold) {
      errors.push(`block_stop confidence must be >= ${options.blockConfidenceThreshold}`);
    }
    if (typeof stopVote.reason !== "string" || stopVote.reason.trim().length === 0) {
      errors.push("block_stop requires non-empty stop_vote.reason");
    }
    const unresolvedRefs = normalizeRefs(stopVote.unresolved_refs);
    if (
      !Array.isArray(unresolvedRefs) ||
      unresolvedRefs.length === 0 ||
      unresolvedRefs.some((ref) => typeof ref !== "string" || ref.trim().length === 0)
    ) {
      errors.push("block_stop requires stop_vote.unresolved_refs with at least one non-empty string");
    } else {
      const attentionIds = readAttentionIds(filePath, role);
      const contributionRefs = new Set(contributions.flatMap((c) => c.references));
      for (const ref of unresolvedRefs) {
        if (attentionIds.length > 0 && !attentionIds.includes(ref)) {
          errors.push(`block_stop unresolved_ref ${ref} is not in the mandatory attention set`);
        }
        if (!contributionRefs.has(ref)) {
          errors.push(`block_stop unresolved_ref ${ref} must also be referenced by a blocker contribution`);
        }
      }
    }
  }

  if ((stance === "contribute" || stance === "block_stop") && contributions.length > 0) {
    const attentionIds = readAttentionIds(filePath, role);
    if (
      attentionIds.length > 0 &&
      !contributions.some((c) => c.references.some((ref) => attentionIds.includes(ref)))
    ) {
      errors.push(`${stance} stance requires at least one contribution to reference the mandatory attention set`);
    }
  }

  if (errors.length > 0) {
    return { stance: "quarantined", contribs: [], rationale: "", quarantine: errors.join("; ") };
  }

  return {
    stance,
    stopVote: {
      vote: (stance === "contribute" || stance === "quiet") ? "none" : vote,
      confidence: Number(stopVote.confidence || 0),
      reason: typeof stopVote.reason === "string" ? stopVote.reason.trim() : "",
      attention_set_reviewed: stopVote.attention_set_reviewed === true,
      semantic_terminal_state: stopVote.semantic_terminal_state || null,
      unresolved_refs: Array.isArray(stopVote.unresolved_refs) ? normalizeRefs(stopVote.unresolved_refs) : [],
    },
    contribs: contributions,
    rationale: data.rationale || "",
    quarantine: null,
    warnings,
  };
}

export function mergeContributions({
  blackboardJsonPath,
  consensusConfidence = 4,
  saturationThreshold = 0,
  saturationPatience = 2,
  minRounds = 3,
  stopVoteQuorum = 3,
  stopPatience = 2,
  readyConfidenceThreshold = 4,
  blockConfidenceThreshold = 4,
  rolePaths,
}) {
  if (!blackboardJsonPath || !rolePaths || rolePaths.length < 4) {
    throw new Error(
      "Usage: swarm.mjs merge <bb_json> <consensus_conf> <sat_threshold> <sat_patience> " +
        "<min_rounds> <stop_vote_quorum> <stop_patience> <ready_conf_threshold> <block_conf_threshold> " +
        "<chal_path> <build_path> <synth_path> <emp_path>"
    );
  }

  const resolved = resolve(blackboardJsonPath);
  const bb = JSON.parse(readFileSync(resolved, "utf-8"));
  const currentRound = bb.round;
  const nextRound = currentRound + 1;
  const [chalPath, buildPath, synthPath, empPath] = rolePaths;

  if (!Array.isArray(bb.events)) bb.events = [];
  const events = [];
  const recordEvent = (type, payload) => {
    events.push({ round: nextRound, type, ...payload });
  };

  const agentOutputs = [
    { role: "chal", ...readDecisionPacket("challenger", chalPath, { readyConfidenceThreshold, blockConfidenceThreshold }) },
    { role: "build", ...readDecisionPacket("builder", buildPath, { readyConfidenceThreshold, blockConfidenceThreshold }) },
    { role: "synth", ...readDecisionPacket("synthesizer", synthPath, { readyConfidenceThreshold, blockConfidenceThreshold }) },
    { role: "emp", ...readDecisionPacket("empiricist", empPath, { readyConfidenceThreshold, blockConfidenceThreshold }) },
  ];

  const quarantined = [];
  const protocolWarnings = [];
  for (const out of agentOutputs) {
    if (out.quarantine) {
      quarantined.push({ role: out.role, reason: out.quarantine });
      recordEvent("agent_quarantined", { role: out.role, reason: out.quarantine });
    }
    if (out.warnings && out.warnings.length > 0) {
      for (const warning of out.warnings) {
        protocolWarnings.push({ role: out.role, reason: warning });
        recordEvent("protocol_warning", { role: out.role, reason: warning });
      }
    }
  }

  const stopVotes = [];
  for (const out of agentOutputs) {
    if (out.quarantine) continue;
    recordEvent("stance", {
      role: out.role,
      stance: out.stance,
      vote: out.stopVote?.vote || "none",
    });
    if (out.stance === "ready_to_stop") {
      stopVotes.push({
        role: out.role,
        vote: "ready",
        confidence: out.stopVote.confidence,
        reason: out.stopVote.reason,
        semantic_terminal_state: out.stopVote.semantic_terminal_state,
      });
      recordEvent("stop_vote", {
        role: out.role,
        vote: "ready",
        confidence: out.stopVote.confidence,
        semantic_terminal_state: out.stopVote.semantic_terminal_state,
      });
    }
    if (out.stance === "block_stop") {
      stopVotes.push({
        role: out.role,
        vote: "block",
        confidence: out.stopVote.confidence,
        reason: out.stopVote.reason,
        unresolved_refs: out.stopVote.unresolved_refs,
      });
      recordEvent("stop_vote", {
        role: out.role,
        vote: "block",
        confidence: out.stopVote.confidence,
        unresolved_refs: out.stopVote.unresolved_refs,
      });
    }
  }

  const newContributions = [];

  for (const { role, contribs, rationale } of agentOutputs) {
    let roleIdx = 1;
    for (const c of contribs) {
      const id = `${role}-r${nextRound}-${roleIdx}`;
      roleIdx++;
      newContributions.push({
        id,
        type: c.type || "claim",
        summary: (c.summary || "").slice(0, 300),
        confidence: Math.max(1, Math.min(5, parseInt(c.confidence, 10) || 3)),
        references: Array.isArray(c.references) ? c.references : [],
        rationale: rationale || "",
        role,
        round: nextRound,
        status: "active",
        rounds_without_evidence: 0,
      });
    }
  }

  const momentumTracker = {
    confidenceDeltas: [],
    contestedCount: 0,
    demotedCount: 0,
    promotedToConsensus: 0,
    withdrawnCount: 0,
  };

  // P1: a reference that points at no known contribution (neither a prior
  // board entry nor a contribution posted this round) is dangling. We record
  // it and surface a board flag rather than silently ignoring it.
  const knownIds = new Set([
    ...bb.contributions.map((c) => c.id),
    ...newContributions.map((c) => c.id),
  ]);
  const danglingRefs = [];
  for (const nc of newContributions) {
    for (const ref of nc.references) {
      if (!knownIds.has(ref)) {
        danglingRefs.push({ from: nc.id, ref });
        recordEvent("dangling_reference", { from: nc.id, ref, type: nc.type });
      }
    }
  }

  for (const nc of newContributions) {
    if (nc.type === "objection") {
      for (const ref of nc.references) {
        const target = bb.contributions.find((c) => c.id === ref);
        if (!target || target.status !== "active") continue;

        if (nc.confidence > target.confidence) {
          target.status = "contested";
          momentumTracker.contestedCount++;
          recordEvent("contested", { id: target.id, by: nc.id });
        } else if (nc.confidence === target.confidence) {
          const demotionRanks = nc.confidence - 2;
          if (demotionRanks > 0) {
            const before = target.confidence;
            target.confidence = Math.max(1, target.confidence - demotionRanks);
            momentumTracker.confidenceDeltas.push(target.confidence - before);
            momentumTracker.demotedCount++;
            recordEvent("confidence_delta", {
              id: target.id,
              by: nc.id,
              from: before,
              to: target.confidence,
            });
          }
        }
      }
    }

    if (nc.type === "evidence") {
      for (const ref of nc.references) {
        const target = bb.contributions.find((c) => c.id === ref);
        if (!target || (target.status !== "active" && target.status !== "contested")) continue;

        const ranks = nc.confidence - 2;
        if (ranks > 0) {
          const before = target.confidence;
          target.confidence = Math.min(5, target.confidence + ranks);
          momentumTracker.confidenceDeltas.push(target.confidence - before);
          recordEvent("confidence_delta", {
            id: target.id,
            by: nc.id,
            from: before,
            to: target.confidence,
          });
        }
        if (target.status === "contested" && target.confidence >= consensusConfidence) {
          target.status = "active";
          recordEvent("uncontested", { id: target.id, by: nc.id });
        }
        target.rounds_without_evidence = 0;
      }
    }
  }

  for (const c of bb.contributions) {
    if (c.status === "contested") {
      c.rounds_without_evidence = (c.rounds_without_evidence || 0) + 1;
      if (c.rounds_without_evidence >= 2) {
        c.status = "withdrawn";
        momentumTracker.withdrawnCount++;
        recordEvent("withdrawn", { id: c.id, reason: "contested_without_evidence" });
      }
    }
  }

  for (const c of bb.contributions) {
    if (c.type === "objection" && c.status === "active") {
      const hasNewEvidence = newContributions.some(
        (other) =>
          other.type === "evidence" &&
          other.references &&
          other.references.includes(c.id)
      );
      if (!hasNewEvidence) {
        c.rounds_without_evidence = (c.rounds_without_evidence || 0) + 1;
        if (c.rounds_without_evidence >= 3) {
          c.status = "withdrawn";
          momentumTracker.withdrawnCount++;
          recordEvent("withdrawn", { id: c.id, reason: "objection_without_evidence" });
        }
      } else {
        c.rounds_without_evidence = 0;
      }
    }
  }

  for (const c of bb.contributions) {
    if (
      c.status === "active" &&
      (c.type === "claim" || c.type === "proposal") &&
      c.confidence >= consensusConfidence
    ) {
      const hasActiveObjection = bb.contributions.some(
        (other) =>
          other.type === "objection" &&
          other.status === "active" &&
          other.references &&
          other.references.includes(c.id)
      );
      const hasNewObjection = newContributions.some(
        (other) =>
          other.type === "objection" &&
          other.references &&
          other.references.includes(c.id)
      );
      if (!hasActiveObjection && !hasNewObjection) {
        c.status = "consensus";
        momentumTracker.promotedToConsensus++;
        recordEvent("promoted", { id: c.id });
      }
    }
  }

  const priorIds = new Set(bb.contributions.map((c) => c.id));
  const engagementCount = newContributions.filter(
    (nc) => nc.references && nc.references.some((ref) => priorIds.has(ref))
  ).length;

  bb.contributions.push(...newContributions);

  const hasConsensus = bb.contributions.some((c) => c.status === "consensus");

  const stateTransitions =
    momentumTracker.promotedToConsensus +
    momentumTracker.contestedCount +
    momentumTracker.demotedCount +
    momentumTracker.withdrawnCount;
  const roundActivity =
    stateTransitions + momentumTracker.confidenceDeltas.length + engagementCount;

  const readyVotes = agentOutputs.filter((out) => !out.quarantine && out.stance === "ready_to_stop").length;
  const blockVotes = agentOutputs.filter((out) => !out.quarantine && out.stance === "block_stop").length;
  const contributeVotes = agentOutputs.filter((out) => !out.quarantine && out.stance === "contribute").length;
  const quietVotes = agentOutputs.filter((out) => !out.quarantine && out.stance === "quiet").length;
  const blockers = stopVotes
    .filter((vote) => vote.vote === "block")
    .map((vote) => ({
      role: vote.role,
      confidence: vote.confidence,
      reason: vote.reason,
      unresolved_refs: vote.unresolved_refs || [],
    }));
  const terminalStateCounts = {};
  for (const vote of stopVotes) {
    if (vote.vote === "ready" && vote.semantic_terminal_state) {
      terminalStateCounts[vote.semantic_terminal_state] =
        (terminalStateCounts[vote.semantic_terminal_state] || 0) + 1;
    }
  }
  const semanticTerminalState =
    Object.entries(terminalStateCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
  const semanticStopCandidate =
    nextRound >= minRounds &&
    readyVotes >= stopVoteQuorum &&
    blockVotes === 0 &&
    contributeVotes === 0 &&
    quarantined.length === 0 &&
    protocolWarnings.length === 0;
  const previousStopStreak = bb.control?.stop?.semantic_stop_streak || 0;
  const semanticStopStreak = semanticStopCandidate ? previousStopStreak + 1 : 0;
  const semanticStop = semanticStopStreak >= stopPatience;
  const cognitiveActivity = roundActivity + newContributions.length + blockVotes;

  const historyEntry = {
    round: nextRound,
    new_contributions_count: newContributions.length,
    round_activity: roundActivity,
    cognitive_activity: cognitiveActivity,
    semantic_stop_candidate: semanticStopCandidate,
    semantic_stop_streak: semanticStopStreak,
    semantic_stop: semanticStop,
    ready_votes: readyVotes,
    block_votes: blockVotes,
    contribute_votes: contributeVotes,
    quiet_votes: quietVotes,
    quarantined_count: quarantined.length,
    protocol_warning_count: protocolWarnings.length,
  };
  bb.history.push(historyEntry);

  const recent = bb.history.slice(-saturationPatience);
  const isSaturated =
    nextRound >= minRounds &&
    recent.length >= saturationPatience &&
    recent.every((h) => (h.cognitive_activity ?? h.round_activity ?? h.new_contributions_count) <= saturationThreshold);

  bb.round = nextRound;

  recordEvent("round_merged", {
    new_contributions: newContributions.length,
    round_activity: roundActivity,
  });
  bb.events.push(...events);

  const confidenceNet = momentumTracker.confidenceDeltas.reduce((sum, d) => sum + d, 0);
  const confidenceNetDirection = confidenceNet > 0 ? "rising" : confidenceNet < 0 ? "falling" : "stable";

  bb.metrics = {
    has_consensus: hasConsensus,
    is_saturated: isSaturated,
    semantic_stop: semanticStop,
    new_contributions_count: newContributions.length,
    quarantined_agents: quarantined,
    protocol_warnings: protocolWarnings,
    dangling_references: danglingRefs,
    momentum_report: {
      round: nextRound,
      objections_raised: newContributions.filter((c) => c.type === "objection").length,
      evidence_provided: newContributions.filter((c) => c.type === "evidence").length,
      claims_promoted_to_consensus: momentumTracker.promotedToConsensus,
      claims_demoted_or_contested: momentumTracker.demotedCount + momentumTracker.contestedCount,
      confidence_net_direction: confidenceNetDirection,
      round_activity: roundActivity,
      cognitive_activity: cognitiveActivity,
    },
    stop_report: {
      round: nextRound,
      ready_votes: readyVotes,
      block_votes: blockVotes,
      contribute_votes: contributeVotes,
      quiet_votes: quietVotes,
      protocol_warning_count: protocolWarnings.length,
      stop_vote_quorum: stopVoteQuorum,
      semantic_stop_candidate: semanticStopCandidate,
      semantic_stop_streak: semanticStopStreak,
      semantic_stop: semanticStop,
      blockers,
      semantic_terminal_state: semanticTerminalState,
    },
  };
  bb.control = {
    ...(bb.control || {}),
    stop: {
      semantic_stop: semanticStop,
      semantic_stop_candidate: semanticStopCandidate,
      semantic_stop_streak: semanticStopStreak,
      ready_votes: readyVotes,
      block_votes: blockVotes,
      contribute_votes: contributeVotes,
      quiet_votes: quietVotes,
      stop_vote_quorum: stopVoteQuorum,
      stop_patience: stopPatience,
      protocol_warning_count: protocolWarnings.length,
      protocol_warnings: protocolWarnings,
      blockers,
      semantic_terminal_state: semanticTerminalState,
      terminal_state_votes: terminalStateCounts,
    },
  };

  writeFileSync(resolved, JSON.stringify(bb, null, 2), "utf-8");
  const md = generateMarkdown(bb);
  const mdPath = resolved.replace(/blackboard\.json$/, "blackboard.md");
  writeFileSync(mdPath, md, "utf-8");

  return {
    has_consensus: hasConsensus,
    is_saturated: isSaturated,
    semantic_stop: semanticStop,
    new_contributions_count: newContributions.length,
    round: nextRound,
    total_contributions: bb.contributions.length,
    consensus_count: bb.contributions.filter((c) => c.status === "consensus").length,
    quarantined_count: quarantined.length,
    dangling_reference_count: danglingRefs.length,
    blackboard_json_path: resolved,
    blackboard_md_path: mdPath,
    momentum_report: JSON.stringify(bb.metrics.momentum_report),
    stop_report: JSON.stringify(bb.metrics.stop_report),
    semantic_stop_streak: semanticStopStreak,
    ready_votes: readyVotes,
    block_votes: blockVotes,
    contribute_votes: contributeVotes,
    quiet_votes: quietVotes,
    protocol_warning_count: protocolWarnings.length,
    cognitive_activity: cognitiveActivity,
  };
}

function chooseExitReason(bb, maxRounds = 50) {
  if (bb.metrics?.semantic_stop) return "semantic_stop";
  if (bb.metrics?.is_saturated) return "activity_saturation";
  if ((bb.round || 0) >= Math.min(maxRounds, 50)) return "max_rounds";
  return "incomplete";
}

export function finalizeBlackboard({ blackboardJsonPath, maxRounds = 50 }) {
  if (!blackboardJsonPath) {
    throw new Error("Usage: swarm.mjs finalize <blackboard_json_path> <max_rounds>");
  }

  const resolved = resolve(blackboardJsonPath);
  const bb = JSON.parse(readFileSync(resolved, "utf-8"));
  const mdPath = resolved.replace(/blackboard\.json$/, "blackboard.md");
  const stop = bb.control?.stop || {};
  const exitReason = chooseExitReason(bb, maxRounds);
  const consensusCount = bb.contributions.filter((c) => c.status === "consensus").length;
  const output = {
    exit_reason: exitReason,
    rounds_completed: bb.round || 0,
    semantic_stop_round: bb.metrics?.semantic_stop ? bb.round || 0 : 0,
    semantic_stop_streak: stop.semantic_stop_streak || 0,
    semantic_saturation_reached: Boolean(bb.metrics?.semantic_stop),
    activity_saturation_reached: Boolean(bb.metrics?.is_saturated),
    stop_quorum_reached: Boolean(stop.semantic_stop_candidate || stop.semantic_stop),
    content_consensus_reached: Boolean(bb.metrics?.has_consensus),
    semantic_terminal_state: stop.semantic_terminal_state || "inconclusive",
    total_contributions: bb.contributions.length,
    consensus_count: consensusCount,
    ready_votes: stop.ready_votes || 0,
    block_votes: stop.block_votes || 0,
    contribute_votes: stop.contribute_votes || 0,
    quiet_votes: stop.quiet_votes || 0,
    quarantined_count: bb.metrics?.quarantined_agents?.length || 0,
    protocol_warning_count: bb.metrics?.protocol_warnings?.length || 0,
    blackboard_json_path: resolved,
    blackboard_md_path: mdPath,
    control_summary: JSON.stringify({
      exit_reason: exitReason,
      stop: bb.control?.stop || {},
      quarantined_agents: bb.metrics?.quarantined_agents || [],
      protocol_warnings: bb.metrics?.protocol_warnings || [],
    }),
  };

  bb.final = output;
  writeFileSync(resolved, JSON.stringify(bb, null, 2), "utf-8");
  writeFileSync(mdPath, generateMarkdown(bb), "utf-8");
  return output;
}

function printJson(value) {
  console.log(JSON.stringify(value));
}

function main(args) {
  const [command, ...rest] = args;

  switch (command) {
    case "init": {
      const [outputDir, topic, context = ""] = rest;
      printJson(initBlackboard({ outputDir, topic, context }));
      return;
    }
    case "summary": {
      const [blackboardJsonPath, role] = rest;
      printJson(summarizeBlackboard({ blackboardJsonPath, role }));
      return;
    }
    case "attention": {
      const [blackboardJsonPath] = rest;
      printJson(assignAttention({ blackboardJsonPath }));
      return;
    }
    case "merge": {
      const [
        blackboardJsonPath,
        consensusConfStr,
        saturationThresholdStr,
        saturationPatienceStr,
        minRoundsStr,
        stopVoteQuorumStr,
        stopPatienceStr,
        readyConfidenceThresholdStr,
        blockConfidenceThresholdStr,
        ...rolePaths
      ] = rest;
      const consensusConfidence = parseInt(consensusConfStr, 10);
      const saturationThreshold = parseInt(saturationThresholdStr, 10);
      const saturationPatience = parseInt(saturationPatienceStr, 10);
      const minRounds = parseInt(minRoundsStr, 10);
      const stopVoteQuorum = parseInt(stopVoteQuorumStr, 10);
      const stopPatience = parseInt(stopPatienceStr, 10);
      const readyConfidenceThreshold = parseInt(readyConfidenceThresholdStr, 10);
      const blockConfidenceThreshold = parseInt(blockConfidenceThresholdStr, 10);
      printJson(
        mergeContributions({
          blackboardJsonPath,
          consensusConfidence: Number.isNaN(consensusConfidence) ? 4 : consensusConfidence,
          saturationThreshold: Number.isNaN(saturationThreshold) ? 0 : saturationThreshold,
          saturationPatience: Number.isNaN(saturationPatience) ? 2 : saturationPatience,
          minRounds: Number.isNaN(minRounds) ? 3 : minRounds,
          stopVoteQuorum: Number.isNaN(stopVoteQuorum) ? 3 : stopVoteQuorum,
          stopPatience: Number.isNaN(stopPatience) ? 2 : stopPatience,
          readyConfidenceThreshold: Number.isNaN(readyConfidenceThreshold) ? 4 : readyConfidenceThreshold,
          blockConfidenceThreshold: Number.isNaN(blockConfidenceThreshold) ? 4 : blockConfidenceThreshold,
          rolePaths,
        })
      );
      return;
    }
    case "finalize": {
      const [blackboardJsonPath, maxRoundsStr] = rest;
      const maxRounds = parseInt(maxRoundsStr, 10);
      printJson(
        finalizeBlackboard({
          blackboardJsonPath,
          maxRounds: Number.isNaN(maxRounds) ? 50 : maxRounds,
        })
      );
      return;
    }
    default:
      throw new Error(
        "Usage: swarm.mjs <init|summary|attention|merge|finalize> [...args]"
      );
  }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isMain) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
