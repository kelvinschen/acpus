#!/usr/bin/env node
// swarm.mjs - Deterministic helper CLI for the swarm-intelligence workflow.
// Usage:
//   node swarm.mjs init <output_dir> <topic> [context]
//   node swarm.mjs summary <blackboard_json_path> [role]
//   node swarm.mjs attention <blackboard_json_path>
//   node swarm.mjs merge <blackboard_json_path> <consensus_confidence> <saturation_threshold> \
//     <challenger_path> <builder_path> <synthesizer_path> <empiricist_path>

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROLES = ["challenger", "builder", "synthesizer", "empiricist"];
const ACTIVE_CLAIM_LIMIT = 8;
const WITHDRAWN_COLLAPSE_THRESHOLD = 5;

export function generateMarkdown(bb) {
  const lines = [];
  lines.push(`# Swarm Blackboard: ${bb.topic}`);
  lines.push("");

  if (bb.context) {
    lines.push("## Context");
    lines.push(bb.context);
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
    `Round: ${bb.round} | Consensus: ${bb.metrics.has_consensus} | Saturated: ${bb.metrics.is_saturated} | New contributions: ${bb.metrics.new_contributions_count}`
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
    metrics: {
      has_consensus: false,
      is_saturated: false,
      new_contributions_count: 0,
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
          `- [${c.id}] [${c.type}] ${c.summary} ${stars}${tag}${refs}`
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
          `- [${c.id}] [${c.type}] ${c.summary} ${stars}${tag}${refs}`
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
            `- [${c.id}] [${c.type}] ${c.summary} ${stars}${tag}${refs}`
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

  if (bb.metrics.momentum_report) {
    const mr = bb.metrics.momentum_report;
    lines.push("");
    lines.push("## Board Momentum");
    lines.push(`Round ${mr.round}: ${mr.objections_raised} objections, ${mr.evidence_provided} evidence`);
    lines.push(`Consensus: +${mr.claims_promoted_to_consensus} promoted | Challenges: ${mr.claims_demoted_or_contested} contested/demoted`);
    lines.push(`Confidence trend: ${mr.confidence_net_direction}`);
  }

  lines.push(
    `Consensus reached: ${bb.metrics.has_consensus} | Saturated: ${bb.metrics.is_saturated}`
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

function readContribs(role, filePath) {
  const resolved = resolve(filePath);
  let data;
  try {
    data = JSON.parse(readFileSync(resolved, "utf-8"));
  } catch (error) {
    throw new Error(`Invalid contribution file for ${role} at ${resolved}: ${error.message}`);
  }

  if (!Array.isArray(data.contributions)) {
    throw new Error(`Invalid contribution file for ${role} at ${resolved}: contributions must be an array`);
  }

  return {
    contribs: data.contributions,
    rationale: data.rationale || "",
  };
}

export function mergeContributions({
  blackboardJsonPath,
  consensusConfidence = 4,
  saturationThreshold = 1,
  rolePaths,
}) {
  if (!blackboardJsonPath || !rolePaths || rolePaths.length < 4) {
    throw new Error(
      "Usage: swarm.mjs merge <bb_json> <consensus_conf> <sat_threshold> " +
        "<chal_path> <build_path> <synth_path> <emp_path>"
    );
  }

  const resolved = resolve(blackboardJsonPath);
  const bb = JSON.parse(readFileSync(resolved, "utf-8"));
  const currentRound = bb.round;
  const nextRound = currentRound + 1;
  const [chalPath, buildPath, synthPath, empPath] = rolePaths;

  const agentOutputs = [
    { role: "chal", ...readContribs("challenger", chalPath) },
    { role: "build", ...readContribs("builder", buildPath) },
    { role: "synth", ...readContribs("synthesizer", synthPath) },
    { role: "emp", ...readContribs("empiricist", empPath) },
  ];

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
  };

  for (const nc of newContributions) {
    if (nc.type === "objection") {
      for (const ref of nc.references) {
        const target = bb.contributions.find((c) => c.id === ref);
        if (!target || target.status !== "active") continue;

        if (nc.confidence > target.confidence) {
          target.status = "contested";
          momentumTracker.contestedCount++;
        } else if (nc.confidence === target.confidence) {
          const demotionRanks = nc.confidence - 2;
          if (demotionRanks > 0) {
            const before = target.confidence;
            target.confidence = Math.max(1, target.confidence - demotionRanks);
            momentumTracker.confidenceDeltas.push(target.confidence - before);
            momentumTracker.demotedCount++;
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
        }
        if (target.status === "contested" && target.confidence >= consensusConfidence) {
          target.status = "active";
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
      if (!hasActiveObjection) {
        c.status = "consensus";
        momentumTracker.promotedToConsensus++;
      }
    }
  }

  bb.contributions.push(...newContributions);

  const hasConsensus = bb.contributions.some((c) => c.status === "consensus");
  const historyEntry = { round: nextRound, new_contributions_count: newContributions.length };
  bb.history.push(historyEntry);

  const recentTwo = bb.history.slice(-2);
  const isSaturated =
    bb.round >= 2 &&
    recentTwo.length >= 2 &&
    recentTwo.every((h) => h.new_contributions_count <= saturationThreshold);

  bb.round = nextRound;

  const confidenceNet = momentumTracker.confidenceDeltas.reduce((sum, d) => sum + d, 0);
  const confidenceNetDirection = confidenceNet > 0 ? "rising" : confidenceNet < 0 ? "falling" : "stable";

  bb.metrics = {
    has_consensus: hasConsensus,
    is_saturated: isSaturated,
    new_contributions_count: newContributions.length,
    momentum_report: {
      round: nextRound,
      objections_raised: newContributions.filter((c) => c.type === "objection").length,
      evidence_provided: newContributions.filter((c) => c.type === "evidence").length,
      claims_promoted_to_consensus: momentumTracker.promotedToConsensus,
      claims_demoted_or_contested: momentumTracker.demotedCount + momentumTracker.contestedCount,
      confidence_net_direction: confidenceNetDirection,
    },
  };

  writeFileSync(resolved, JSON.stringify(bb, null, 2), "utf-8");
  const md = generateMarkdown(bb);
  const mdPath = resolved.replace(/blackboard\.json$/, "blackboard.md");
  writeFileSync(mdPath, md, "utf-8");

  return {
    has_consensus: hasConsensus,
    is_saturated: isSaturated,
    new_contributions_count: newContributions.length,
    round: nextRound,
    total_contributions: bb.contributions.length,
    consensus_count: bb.contributions.filter((c) => c.status === "consensus").length,
    blackboard_json_path: resolved,
    blackboard_md_path: mdPath,
    momentum_report: JSON.stringify(bb.metrics.momentum_report),
  };
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
        ...rolePaths
      ] = rest;
      printJson(
        mergeContributions({
          blackboardJsonPath,
          consensusConfidence: parseInt(consensusConfStr, 10) || 4,
          saturationThreshold: parseInt(saturationThresholdStr, 10) || 1,
          rolePaths,
        })
      );
      return;
    }
    default:
      throw new Error(
        "Usage: swarm.mjs <init|summary|attention|merge> [...args]"
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
