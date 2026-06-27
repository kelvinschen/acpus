#!/usr/bin/env node

import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";

const DEFAULT_OUTPUT = "optimizer-visualization.html";
const MAX_TEXT_BYTES = 256 * 1024;

function usage() {
  return [
    "Usage:",
    "  node generate.mjs <completed_run_output_dir> [output_html]",
    "",
    "Example:",
    "  node generate.mjs .acpus/output/skill-optimizer/<run-id>",
  ].join("\n");
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

async function fileMtime(path) {
  try {
    return (await stat(path)).mtimeMs;
  } catch {
    return 0;
  }
}

function gitOut(worktree, args) {
  return execFileSync("git", args, { cwd: worktree, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
}

// Reconstruct the skill directory contents at a given commit SHA. Candidates are
// frozen as git commits in the worktree, so each round's evaluated skill is read
// from its SHA rather than a per-round directory snapshot.
function readSkillFilesAtSha(worktree, skillRelPath, sha) {
  const files = new Map();
  if (!worktree || !sha || !existsSync(worktree)) return files;
  let listing = "";
  try {
    listing = gitOut(worktree, ["ls-tree", "-r", "-z", "--name-only", sha, "--", skillRelPath]);
  } catch {
    return files;
  }
  for (const full of listing.split("\0").filter(Boolean)) {
    const rel = full.startsWith(`${skillRelPath}/`) ? full.slice(skillRelPath.length + 1) : full;
    let buffer;
    try {
      buffer = execFileSync("git", ["show", `${sha}:${full}`], { cwd: worktree, maxBuffer: MAX_TEXT_BYTES * 4 });
    } catch {
      continue;
    }
    const binary = buffer.includes(0);
    const truncated = buffer.length > MAX_TEXT_BYTES;
    files.set(rel, {
      absPath: `${sha.slice(0, 8)}:${full}`,
      content: binary ? "" : buffer.subarray(0, MAX_TEXT_BYTES).toString("utf8"),
      binary,
      truncated,
    });
  }
  return files;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function number(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function scoreText(value) {
  const n = number(value);
  return n == null ? "n/a" : n.toFixed(2).replace(/\.00$/, "");
}

function pct(value) {
  const n = number(value);
  return n == null ? 0 : Math.max(0, Math.min(100, n * 10));
}

function scoreClass(value) {
  const n = number(value);
  if (n == null) return "score-unknown";
  if (n >= 8) return "score-high";
  if (n < 5) return "score-low";
  return "score-mid";
}

function fileStatus(before, after) {
  if (!before && after) return "added";
  if (before && !after) return "deleted";
  if (!before || !after) return "missing";
  if (before.binary || after.binary) return before.binary === after.binary ? "binary" : "modified";
  return before.content === after.content ? "unchanged" : "modified";
}

function languageForPath(path) {
  const lower = path.toLowerCase();
  if (lower.endsWith(".md") || lower.endsWith(".markdown")) return "markdown";
  if (lower.endsWith(".json")) return "json";
  if (lower.endsWith(".yaml") || lower.endsWith(".yml")) return "yaml";
  if (lower.endsWith(".js") || lower.endsWith(".mjs") || lower.endsWith(".cjs")) return "javascript";
  if (lower.endsWith(".ts") || lower.endsWith(".tsx")) return "typescript";
  if (lower.endsWith(".py")) return "python";
  if (lower.endsWith(".sh") || lower.endsWith(".bash") || lower.endsWith(".zsh")) return "shell";
  return "plaintext";
}

function buildDiffFiles(beforeFiles, afterFiles) {
  const paths = [...new Set([...beforeFiles.keys(), ...afterFiles.keys()])].sort();
  return paths.map((path) => {
    const before = beforeFiles.get(path);
    const after = afterFiles.get(path);
    const status = fileStatus(before, after);
    return {
      path,
      status,
      before,
      after,
    };
  });
}

async function roundNumbersFromDisk(roundsDir) {
  try {
    const names = await readdir(roundsDir);
    return names
      .map((name) => /^round-(\d+)$/.exec(name)?.[1])
      .filter(Boolean)
      .map(Number)
      .sort((a, b) => a - b);
  } catch {
    return [];
  }
}

function roundNumbersFromState(state) {
  return asArray(state.rounds)
    .map((round) => number(round.round))
    .filter((round) => round != null)
    .sort((a, b) => a - b);
}

function pathIfExists(path) {
  return path && existsSync(path) ? path : "";
}

async function loadRounds(runDir, state) {
  const roundsDir = state.rounds_dir || join(runDir, "rounds");
  const worktree = state.worktree_path || "";
  const skillRel = state.skill_rel_path || "";
  const stateRounds = new Map(asArray(state.rounds).map((round) => [round.round, round]));
  const numbers = roundNumbersFromState(state).length
    ? roundNumbersFromState(state)
    : await roundNumbersFromDisk(roundsDir);

  const rounds = [];
  // Candidates are frozen as git commits; walk each round's produced skill
  // (the committed candidate, else the evaluated SHA) and diff against the
  // previous round's produced skill, starting from the original baseline.
  let previousFiles = readSkillFilesAtSha(worktree, skillRel, state.baseline_sha);
  for (const round of numbers) {
    const roundDir = join(roundsDir, `round-${round}`);
    const roundState = stateRounds.get(round) || {};
    const summaryPath = pathIfExists(roundState.summary_path) || join(roundDir, "evaluation-summary.json");
    const manifestPath = pathIfExists(roundState.manifest_path) || join(roundDir, "improvement-manifest.json");
    // Each round's panel shows the skill that round actually evaluated, so the
    // metrics and the skill files match. round 0 = baseline; round N = the
    // candidate produced (and committed) in round N-1.
    const evaluatedSha = roundState.evaluated_sha || state.baseline_sha;
    const skillFiles = readSkillFilesAtSha(worktree, skillRel, evaluatedSha);

    const [summary, manifest, summaryMtime, manifestMtime] = await Promise.all([
      readJson(summaryPath),
      readJson(manifestPath),
      fileMtime(summaryPath),
      fileMtime(manifestPath),
    ]);

    rounds.push({
      round,
      dir: roundDir,
      summaryPath,
      manifestPath,
      evaluatedSha,
      candidateSha: roundState.candidate_sha || "",
      producedSha: evaluatedSha,
      summary: summary || {},
      manifest: manifest || {},
      skillFiles: [...skillFiles.entries()].map(([path, file]) => ({ path, ...file })),
      diffFiles: buildDiffFiles(previousFiles, skillFiles),
      state: roundState,
      mtimes: { summary: summaryMtime, manifest: manifestMtime },
    });
    previousFiles = skillFiles;
  }

  return rounds;
}

async function loadRun(runDirArg) {
  const runDir = resolve(runDirArg || "");
  const statePath = join(runDir, "state.json");
  const state = await readJson(statePath);
  if (!state) throw new Error(`Missing or invalid state.json in ${runDir}`);

  const rounds = await loadRounds(runDir, state);
  const last = rounds.at(-1);
  const completed = Boolean(last?.state?.done) || Boolean(state.stop_reason && state.stop_reason !== "continue");
  if (!completed) throw new Error("Run is not complete yet; this generator only supports completed skill-optimizer runs.");

  return { runDir, statePath, state, rounds, generatedAt: new Date().toISOString() };
}

function roundValue(round, key) {
  return round.summary[key] ?? round.state[key] ?? "";
}

function finalScore(run) {
  const last = run.rounds.at(-1);
  return last ? roundValue(last, "avg_score") : run.state.best_score;
}

function scoreDelta(run) {
  const first = number(roundValue(run.rounds.at(0) || {}, "avg_score"));
  const last = number(finalScore(run));
  if (first == null || last == null) return null;
  return last - first;
}

function summaryList(items, emptyText) {
  const list = asArray(items);
  if (!list.length) return `<p class="empty">${escapeHtml(emptyText)}</p>`;
  return `<ul>${list.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`;
}

function scoreBar(label, value) {
  return `
    <div class="score-row">
      <div class="score-row-label">${escapeHtml(label)}</div>
      <div class="score-track"><span style="width:${pct(value)}%"></span></div>
      <div class="score-row-value ${scoreClass(value)}">${scoreText(value)}</div>
    </div>`;
}

function renderScoreMap(scoreByTest) {
  const entries = Object.entries(scoreByTest || {});
  if (!entries.length) return `<p class="empty">No score map was recorded for this round.</p>`;
  return `<div class="score-map">${entries.map(([test, score]) => scoreBar(test, score)).join("")}</div>`;
}

function renderManifest(manifest) {
  const changes = asArray(manifest.changes_summary);
  const changed = manifest.changed === true ? "yes" : manifest.changed === false ? "no" : "n/a";
  return `
    <div class="manifest">
      <div class="manifest-meta">
        <span><strong>Changed</strong> ${escapeHtml(changed)}</span>
        <span><strong>Can improve</strong> ${escapeHtml(manifest.can_improve ?? "n/a")}</span>
      </div>
      ${summaryList(changes, "No improvement manifest changes were recorded.")}
    </div>`;
}

function renderTriggerBlock(test) {
  if (test.label === undefined && test.trigger_rate === undefined) return "";
  const passed = test.pass === true;
  const expected = test.should_trigger === false ? "should NOT trigger" : "should trigger";
  return `
      <section class="note-block ${passed ? "" : "danger"}">
        <h5>Recall Trigger</h5>
        <div class="manifest-meta">
          <span><strong>Expected</strong> ${escapeHtml(expected)}</span>
          <span><strong>Label</strong> ${escapeHtml(labelText(test.label || "n/a"))}</span>
          <span><strong>Trigger rate</strong> ${escapeHtml(scoreText((number(test.trigger_rate) ?? 0) * 10) === "n/a" ? "n/a" : (number(test.trigger_rate) ?? 0).toFixed(2))}</span>
          <span><strong>Predicted</strong> ${escapeHtml(test.predicted_trigger === true ? "trigger" : "no trigger")}</span>
        </div>
        <h5>Self-reported reasons</h5>
        ${summaryList(test.reasons, "No self-reported reasons recorded.")}
      </section>`;
}

function renderEvaluation(test) {
  return `
    <article class="test-card">
      <header>
        <div>
          <div class="eyebrow">Test Case</div>
          <h4>${escapeHtml(test.test_id || test.key || "unknown")}</h4>
        </div>
        <div class="test-score ${scoreClass(test.score)}">${scoreText(test.score)} / 10</div>
      </header>
      ${renderTriggerBlock(test)}
      <div class="feedback-grid">
        <section>
          <h5>Strengths</h5>
          ${summaryList(test.strengths, "No strengths recorded.")}
        </section>
        <section>
          <h5>Weaknesses</h5>
          ${summaryList(test.weaknesses, "No weaknesses recorded.")}
        </section>
      </div>
      <section class="note-block">
        <h5>Suggestions</h5>
        ${summaryList(test.suggestions, "No suggestions recorded.")}
      </section>
      <section class="note-block danger">
        <h5>Violated Rules</h5>
        ${summaryList(test.violated_rules, "No violated rules recorded.")}
      </section>
    </article>`;
}

function statusLabel(status) {
  return {
    added: "Added",
    deleted: "Deleted",
    modified: "Modified",
    unchanged: "Unchanged",
    binary: "Binary",
    missing: "Missing",
  }[status] || status;
}

function labelText(value) {
  return String(value ?? "n/a")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function renderFileOptions(files) {
  return files.map((file, index) => `
    <option value="${escapeHtml(file.path)}" ${index === 0 ? "selected" : ""}>
      ${escapeHtml(file.path)} (${escapeHtml(statusLabel(file.status || "current"))})
    </option>`).join("");
}

function scriptJson(data) {
  return JSON.stringify(data).replace(/</g, "\\u003c");
}

function renderSideBySideDiff(diffFile, round) {
  if (diffFile.before?.binary || diffFile.after?.binary) {
    return `<p class="empty">Binary file diff is not rendered.</p>`;
  }
  if (diffFile.status === "unchanged") return `<p class="empty">No changes for this file.</p>`;
  const payload = {
    language: languageForPath(diffFile.path),
    oldContent: diffFile.before?.content || "",
    newContent: diffFile.after?.content || "",
  };
  return `
    <script type="application/json" class="diff-data">${scriptJson(payload)}</script>
    <div class="monaco-diff-target"><p class="empty">Loading diff...</p></div>`;
}

function shaShort(sha) {
  return sha ? String(sha).slice(0, 8) : "";
}

function renderSkillFiles(round) {
  const diffFiles = round.diffFiles || [];
  const contentFiles = round.skillFiles || [];
  if (!diffFiles.length && !contentFiles.length) return `<p class="empty">No skill files were found for this round.</p>`;

  const producedSha = shaShort(round.producedSha);
  const caption = round.round === 0
    ? `Baseline skill — the original, unedited (${contentFiles.length} files${producedSha ? `, ${producedSha}` : ""}). Round 0 evaluates this; the candidate it produces is evaluated in Round 1.`
    : `Skill evaluated in Round ${round.round} (${contentFiles.length} files${producedSha ? `, ${producedSha}` : ""}) — the candidate produced in Round ${round.round - 1}. Diff is against the skill evaluated in Round ${round.round - 1}.`;

  return `
    <article class="panel skill-files">
      <div class="file-toolbar">
        <div>
          <h3>Skill Files</h3>
          <p>${escapeHtml(caption)}</p>
        </div>
        <label>
          <span>File</span>
          <select class="file-select" data-round="${escapeHtml(round.round)}">
            ${renderFileOptions(diffFiles)}
          </select>
        </label>
      </div>
      <div class="file-tree">
        ${contentFiles.map((file) => `<span>${escapeHtml(file.path)}</span>`).join("")}
      </div>
      <div class="file-panes">
        ${diffFiles.map((diffFile, index) => {
          return `
            <section class="file-pane ${index === 0 ? "is-active" : ""}" data-round="${escapeHtml(round.round)}" data-file="${escapeHtml(diffFile.path)}">
              <header class="file-pane-header">
                <div>
                  <strong>${escapeHtml(diffFile.path)}</strong>
                  <span class="status-pill status-${escapeHtml(diffFile.status)}">${escapeHtml(statusLabel(diffFile.status))}</span>
                </div>
              </header>
              <div class="split-section">
                <div>
                  <h4>Side-by-side diff</h4>
                  ${renderSideBySideDiff(diffFile, round)}
                </div>
              </div>
            </section>`;
        }).join("")}
      </div>
    </article>`;
}

function renderTriggerMetrics(summary) {
  const m = summary.trigger_metrics;
  if (!m || typeof m !== "object") return "";
  return `
        <article class="panel">
          <h3>Recall Metrics</h3>
          <dl class="facts">
            <dt>Precision</dt><dd>${escapeHtml(scoreText((number(m.precision) ?? 0) * 10) === "n/a" ? "n/a" : (number(m.precision) ?? 0).toFixed(2))}</dd>
            <dt>Recall</dt><dd>${escapeHtml((number(m.recall) ?? 0).toFixed(2))}</dd>
            <dt>Accuracy</dt><dd>${escapeHtml((number(m.accuracy) ?? 0).toFixed(2))}</dd>
            <dt>True pos</dt><dd>${escapeHtml(m.true_positives ?? 0)}</dd>
            <dt>False pos</dt><dd>${escapeHtml(m.false_positives ?? 0)}</dd>
            <dt>False neg</dt><dd>${escapeHtml(m.false_negatives ?? 0)}</dd>
            <dt>True neg</dt><dd>${escapeHtml(m.true_negatives ?? 0)}</dd>
          </dl>
        </article>`;
}

function renderRound(round) {
  const evaluations = asArray(round.summary.evaluations);
  const title = `Round ${round.round}`;
  const weakest = roundValue(round, "weakest_test");
  const stopReason = roundValue(round, "stop_reason");

  return `
    <section class="round-panel" id="panel-round-${round.round}">
      <header class="round-header">
        <div>
          <div class="eyebrow">${escapeHtml(title)}</div>
          <h2>${escapeHtml(title)} Results</h2>
        </div>
        <div class="round-stats">
          <span><strong>${scoreText(roundValue(round, "avg_score"))}</strong> avg</span>
          <span><strong>${scoreText(roundValue(round, "best_score"))}</strong> best</span>
          <span><strong>${escapeHtml(roundValue(round, "skill_line_count") || "n/a")}</strong> lines</span>
        </div>
      </header>

      <div class="panel-grid">
        <article class="panel">
          <h3>Scores</h3>
          ${renderScoreMap(round.summary.score_by_test)}
        </article>
        <article class="panel">
          <h3>Round Control</h3>
          <dl class="facts">
            <dt>Stop reason</dt><dd>${escapeHtml(labelText(stopReason || "n/a"))}</dd>
            <dt>Weakest test</dt><dd>${escapeHtml(weakest || "n/a")}</dd>
            <dt>Weakest score</dt><dd>${escapeHtml(scoreText(roundValue(round, "weakest_score")))}</dd>
            <dt>Stagnation rounds</dt><dd>${escapeHtml(roundValue(round, "stagnation_rounds") || 0)}</dd>
          </dl>
        </article>
        ${renderTriggerMetrics(round.summary)}
      </div>

      <article class="panel">
        <h3>Improvement Manifest</h3>
        ${renderManifest(round.manifest)}
      </article>

      <article class="panel">
        <h3>Evaluations</h3>
        ${evaluations.length ? evaluations.map(renderEvaluation).join("") : `<p class="empty">No evaluations recorded.</p>`}
      </article>

      ${renderSkillFiles(round)}
    </section>`;
}

function renderRoundOverview(run) {
  return `
    <table>
      <thead><tr><th>Round</th><th>Avg</th><th>Best</th><th>Weakest test</th><th>Stop</th><th>Changed</th></tr></thead>
      <tbody>
        ${run.rounds.map((round) => `
          <tr>
            <td>Round ${escapeHtml(round.round)}</td>
            <td class="${scoreClass(roundValue(round, "avg_score"))}">${escapeHtml(scoreText(roundValue(round, "avg_score")))}</td>
            <td class="${scoreClass(roundValue(round, "best_score"))}">${escapeHtml(scoreText(roundValue(round, "best_score")))}</td>
            <td>${escapeHtml(roundValue(round, "weakest_test") || "n/a")}</td>
            <td>${escapeHtml(labelText(roundValue(round, "stop_reason") || "continue"))}</td>
            <td>${escapeHtml(round.manifest.changed ?? "n/a")}</td>
          </tr>`).join("")}
      </tbody>
    </table>`;
}

function renderRoundTabs(run) {
  const inputs = run.rounds.map((round, index) => `
    <input class="tab-input" type="radio" name="round-tab" id="tab-round-${round.round}" ${index === run.rounds.length - 1 ? "checked" : ""}>`).join("");
  const labels = run.rounds.map((round) => {
    const avg = scoreText(roundValue(round, "avg_score"));
    const best = scoreText(roundValue(round, "best_score"));
    const stop = labelText(roundValue(round, "stop_reason") || "continue");
    return `
      <label class="tab-label" for="tab-round-${round.round}">
        <span>Round ${escapeHtml(round.round)}</span>
        <strong>${escapeHtml(avg)}</strong>
        <small>best ${escapeHtml(best)} / ${escapeHtml(stop)}</small>
      </label>`;
  }).join("");

  return `
    <section class="round-tabs">
      ${inputs}
      <div class="tab-list" role="tablist" aria-label="Rounds">${labels}</div>
      <div class="round-panels">${run.rounds.map(renderRound).join("")}</div>
    </section>`;
}

function renderTabRules(run) {
  return run.rounds.map((round) => `
#tab-round-${round.round}:checked ~ .tab-list label[for="tab-round-${round.round}"] {
  background: var(--teal);
  border-color: var(--teal);
  color: var(--paper);
  box-shadow: inset 0 -4px 0 rgba(255, 255, 255, .28), 0 8px 18px rgba(19, 111, 99, .16);
}
#tab-round-${round.round}:checked ~ .tab-list label[for="tab-round-${round.round}"] small,
#tab-round-${round.round}:checked ~ .tab-list label[for="tab-round-${round.round}"] strong {
  color: var(--paper);
}
#tab-round-${round.round}:checked ~ .round-panels #panel-round-${round.round} {
  display: grid;
}`).join("\n");
}

function renderTestCases(state) {
  const tests = asArray(state.test_cases);
  if (!tests.length) return `<p class="empty">No test cases were embedded in state.json.</p>`;
  return `
    <table>
      <thead><tr><th>ID</th><th>Key</th><th>Should trigger</th></tr></thead>
      <tbody>
        ${tests.map((test) => `
          <tr>
            <td>${escapeHtml(test.id)}</td>
            <td>${escapeHtml(test.key)}</td>
            <td>${escapeHtml(test.should_trigger ?? "n/a")}</td>
          </tr>`).join("")}
      </tbody>
    </table>`;
}

function renderHtml(run) {
  const { state } = run;
  const runId = state.run_id || run.runDir.split("/").at(-1);
  const stopReason = state.stop_reason || run.rounds.at(-1)?.state?.stop_reason || "n/a";
  const stopReasonLabel = labelText(stopReason);
  const reportPath = state.report_path || join(run.runDir, "report.md");
  const delta = scoreDelta(run);
  const deltaText = delta == null ? "n/a" : `${delta >= 0 ? "+" : ""}${scoreText(delta)}`;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Skill Optimizer Run ${escapeHtml(runId)}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Noto+Sans:wght@400;500;600;700;800&family=Noto+Sans+SC:wght@400;500;600;700;800&family=Noto+Serif:wght@400;500;600;700&family=Noto+Serif+SC:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>${CSS}
${renderTabRules(run)}</style>
</head>
<body>
  <header class="hero">
    <div>
      <p class="eyebrow">Skill Optimizer</p>
      <h1>Optimization Run</h1>
      <p class="subtitle">${escapeHtml(state.skill_path || "unknown skill")}</p>
      <p class="run-id">${escapeHtml(runId)}</p>
    </div>
    <div class="hero-stats">
      <div class="primary-metric"><strong>${scoreText(finalScore(run))}</strong><span>Final avg</span></div>
      <div><strong>${scoreText(state.best_score)}</strong><span>Best score</span></div>
      <div><strong>${escapeHtml(deltaText)}</strong><span>Avg delta</span></div>
      <div class="compact-metric"><strong>${escapeHtml(stopReasonLabel)}</strong><span>Stop reason</span></div>
    </div>
  </header>

  <main>
    <section class="summary-grid">
      <article class="panel outcome-panel">
        <h2>Outcome</h2>
        <p class="outcome-score ${scoreClass(finalScore(run))}">${scoreText(finalScore(run))}</p>
        <p class="outcome-copy">Completed ${escapeHtml(run.rounds.length)} rounds with best score ${escapeHtml(scoreText(state.best_score))} and stopped on ${escapeHtml(stopReasonLabel)}.</p>
      </article>
      <article class="panel">
        <h2>Run Facts</h2>
        <dl class="facts">
          <dt>Focus</dt><dd>${escapeHtml(state.focus || "n/a")}</dd>
          <dt>Max iterations</dt><dd>${escapeHtml(state.max_iterations ?? "n/a")}</dd>
          <dt>Test count</dt><dd>${escapeHtml(state.test_case_count ?? "n/a")}</dd>
          <dt>Line budget</dt><dd>${escapeHtml(state.line_budget ?? "n/a")}</dd>
          <dt>Report</dt><dd>${escapeHtml(reportPath)}</dd>
        </dl>
      </article>
      <article class="panel round-overview">
        <h2>Round Overview</h2>
        ${renderRoundOverview(run)}
      </article>
    </section>

    <section class="content">
      <section class="overview">
        <article class="panel">
          <h2>Test Cases</h2>
          ${renderTestCases(state)}
        </article>
      </section>
      ${renderRoundTabs(run)}
    </section>
  </main>

  <footer>
    Generated at ${escapeHtml(run.generatedAt)} from ${escapeHtml(run.runDir)}
  </footer>
  <script src="https://cdn.jsdelivr.net/npm/monaco-editor@0.49.0/min/vs/loader.js"></script>
  <script>
    let monacoReady;
    function loadMonaco() {
      if (monacoReady) return monacoReady;
      monacoReady = new Promise((resolve, reject) => {
        if (!window.require) {
          reject(new Error("Monaco loader failed"));
          return;
        }
        require.config({ paths: { vs: "https://cdn.jsdelivr.net/npm/monaco-editor@0.49.0/min/vs" } });
        require(["vs/editor/editor.main"], () => resolve(window.monaco), reject);
      });
      return monacoReady;
    }
    function editorHeight(data) {
      const lines = Math.max(
        data.oldContent.split("\\n").length,
        data.newContent.split("\\n").length
      );
      return Math.max(420, Math.min(900, lines * 24 + 80));
    }
    async function renderDiffs() {
      let monaco;
      try {
        monaco = await loadMonaco();
      } catch {
        for (const target of document.querySelectorAll(".monaco-diff-target")) {
          target.innerHTML = '<p class="empty">Diff editor failed to load.</p>';
        }
        return;
      }
      for (const pane of document.querySelectorAll(".file-pane.is-active")) {
        const dataNode = pane.querySelector(".diff-data");
        const target = pane.querySelector(".monaco-diff-target");
        if (!dataNode || !target || target.dataset.rendered === "true") continue;
        const data = JSON.parse(dataNode.textContent);
        target.textContent = "";
        target.style.height = editorHeight(data) + "px";
        const editor = monaco.editor.createDiffEditor(target, {
          automaticLayout: true,
          readOnly: true,
          renderSideBySide: true,
          wordWrap: "on",
          wrappingStrategy: "advanced",
          minimap: { enabled: false },
          scrollBeyondLastLine: false,
          renderOverviewRuler: true,
          originalEditable: false,
          lineNumbersMinChars: 3,
          fontFamily: 'Menlo, Monaco, Consolas, "Liberation Mono", monospace',
          fontSize: 12,
          lineHeight: 20
        });
        const original = monaco.editor.createModel(data.oldContent, data.language);
        const modified = monaco.editor.createModel(data.newContent, data.language);
        editor.setModel({ original, modified });
        window.__skillOptimizerDiffEditors ||= [];
        window.__skillOptimizerDiffEditors.push(editor);
        target.dataset.rendered = "true";
      }
    }
    document.addEventListener("change", (event) => {
      if (!event.target.classList.contains("file-select")) return;
      const round = event.target.dataset.round;
      for (const pane of document.querySelectorAll('.file-pane[data-round="' + round + '"]')) {
        pane.classList.toggle("is-active", pane.dataset.file === event.target.value);
      }
      renderDiffs();
    });
    renderDiffs();
  </script>
</body>
</html>`;
}

const CSS = `
:root {
  --paper: #f7f2e8;
  --surface: #fffaf0;
  --ink: #211f1a;
  --muted: #686357;
  --faint: #9b927f;
  --line: #d7cdb7;
  --line-strong: #29251f;
  --green: #1f7a4a;
  --red: #b3332b;
  --amber: #9b6b0d;
  --violet: #5f4b8b;
  --mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
  --sans: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  --serif: Georgia, "Times New Roman", serif;
}
* { box-sizing: border-box; }
html { scroll-behavior: smooth; }
body {
  margin: 0;
  background: var(--paper);
  color: var(--ink);
  font-family: var(--sans);
  line-height: 1.5;
}
.hero {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 32px;
  align-items: end;
  border-bottom: 2px solid var(--line-strong);
  padding: 34px 42px 28px;
}
.eyebrow {
  margin: 0 0 8px;
  color: var(--muted);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: .16em;
  text-transform: uppercase;
}
h1, h2, h3, h4, h5, p { margin-top: 0; }
h1 {
  margin-bottom: 8px;
  font-family: var(--serif);
  font-size: 36px;
  font-weight: 500;
}
.subtitle {
  margin: 0;
  max-width: 1000px;
  color: var(--muted);
  font-family: var(--mono);
  font-size: 12px;
  overflow-wrap: anywhere;
}
.hero-stats {
  display: grid;
  grid-template-columns: repeat(4, minmax(96px, auto));
  gap: 10px;
}
.hero-stats div {
  min-height: 78px;
  border: 1px solid var(--line);
  background: var(--surface);
  padding: 12px;
}
.hero-stats strong {
  display: block;
  color: var(--ink);
  font-family: var(--serif);
  font-size: 26px;
  font-weight: 500;
  line-height: 1.1;
}
.hero-stats span {
  display: block;
  margin-top: 8px;
  color: var(--muted);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: .08em;
  text-transform: uppercase;
}
main {
  display: grid;
  grid-template-columns: 300px minmax(0, 1fr);
  gap: 32px;
  padding: 32px 42px 44px;
}
aside {
  position: sticky;
  top: 24px;
  align-self: start;
  display: grid;
  gap: 18px;
}
.nav-panel, .panel, .skill-block {
  border: 1px solid var(--line);
  background: var(--surface);
  padding: 18px;
}
.nav-panel h2, .panel h2, .panel h3 {
  margin-bottom: 14px;
  font-size: 13px;
  font-weight: 800;
  letter-spacing: .12em;
  text-transform: uppercase;
}
nav {
  display: grid;
  gap: 8px;
}
.timeline-item {
  display: grid;
  grid-template-columns: 18px 1fr;
  gap: 10px;
  align-items: start;
  color: inherit;
  text-decoration: none;
}
.timeline-dot {
  width: 10px;
  height: 10px;
  margin-top: 5px;
  border: 2px solid var(--line-strong);
  border-radius: 50%;
  background: var(--paper);
}
.timeline-item strong {
  display: block;
  font-size: 14px;
}
.timeline-item small {
  display: block;
  color: var(--muted);
  font-family: var(--mono);
  font-size: 11px;
}
.facts {
  display: grid;
  grid-template-columns: 110px minmax(0, 1fr);
  gap: 8px 12px;
  margin: 0;
  font-size: 12px;
}
.facts dt {
  color: var(--muted);
  font-weight: 700;
}
.facts dd {
  margin: 0;
  overflow-wrap: anywhere;
}
.content {
  display: grid;
  gap: 34px;
  min-width: 0;
}
.overview { display: grid; gap: 18px; }
.round-section {
  display: grid;
  gap: 18px;
  scroll-margin-top: 24px;
}
.round-header {
  display: flex;
  justify-content: space-between;
  gap: 18px;
  align-items: end;
  border-bottom: 1px solid var(--line-strong);
  padding-bottom: 14px;
}
.round-header h2 {
  margin: 0;
  font-family: var(--serif);
  font-size: 30px;
  font-weight: 500;
}
.round-stats {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 10px;
}
.round-stats span {
  border: 1px solid var(--line);
  background: var(--surface);
  padding: 8px 10px;
  color: var(--muted);
  font-size: 12px;
  text-transform: uppercase;
}
.round-stats strong {
  color: var(--ink);
  font-family: var(--mono);
}
.panel-grid {
  display: grid;
  grid-template-columns: minmax(0, 1.25fr) minmax(260px, .75fr);
  gap: 18px;
}
.score-map {
  display: grid;
  gap: 10px;
}
.score-row {
  display: grid;
  grid-template-columns: minmax(120px, 220px) minmax(120px, 1fr) 52px;
  gap: 12px;
  align-items: center;
  font-size: 12px;
}
.score-row-label {
  overflow-wrap: anywhere;
  font-family: var(--mono);
}
.score-track {
  height: 10px;
  border: 1px solid var(--line);
  background: var(--paper);
}
.score-track span {
  display: block;
  height: 100%;
  background: var(--violet);
}
.score-row-value {
  text-align: right;
  font-family: var(--mono);
  font-weight: 700;
}
.score-high { color: var(--green); }
.score-mid { color: var(--amber); }
.score-low { color: var(--red); }
.score-unknown { color: var(--faint); }
.manifest-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  margin-bottom: 12px;
  color: var(--muted);
  font-size: 12px;
}
ul {
  margin: 0;
  padding-left: 20px;
}
li + li { margin-top: 6px; }
.empty {
  margin: 0;
  color: var(--faint);
  font-style: italic;
}
.test-card {
  border-top: 1px solid var(--line);
  padding: 18px 0;
}
.test-card:first-of-type { border-top: 0; padding-top: 0; }
.test-card header {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  align-items: start;
  margin-bottom: 14px;
}
.test-card h4 {
  margin: 0;
  font-size: 18px;
  overflow-wrap: anywhere;
}
.test-score {
  flex: 0 0 auto;
  border: 1px solid currentColor;
  padding: 6px 8px;
  font-family: var(--mono);
  font-weight: 800;
}
.feedback-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
}
h5 {
  margin-bottom: 8px;
  color: var(--muted);
  font-size: 11px;
  font-weight: 800;
  letter-spacing: .12em;
  text-transform: uppercase;
}
.note-block {
  margin-top: 14px;
  border-left: 3px solid var(--violet);
  padding-left: 12px;
}
.note-block.danger { border-left-color: var(--red); }
.skill-block {
  padding: 0;
}
.skill-block summary {
  cursor: pointer;
  padding: 14px 18px;
  font-weight: 800;
  letter-spacing: .08em;
  text-transform: uppercase;
}
pre {
  margin: 0;
  max-height: 520px;
  overflow: auto;
  border-top: 1px solid var(--line);
  padding: 18px;
  background: #fffdf7;
  font-family: var(--mono);
  font-size: 12px;
  line-height: 1.55;
  white-space: pre-wrap;
}
table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}
th, td {
  border-bottom: 1px solid var(--line);
  padding: 8px 6px;
  text-align: left;
  vertical-align: top;
}
th {
  color: var(--muted);
  font-size: 11px;
  letter-spacing: .08em;
  text-transform: uppercase;
}
td { overflow-wrap: anywhere; }
footer {
  border-top: 1px solid var(--line);
  padding: 18px 42px 28px;
  color: var(--muted);
  font-family: var(--mono);
  font-size: 11px;
  overflow-wrap: anywhere;
}
@media (max-width: 980px) {
  .hero, main { grid-template-columns: 1fr; }
  .hero-stats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  aside { position: static; }
  .panel-grid, .feedback-grid { grid-template-columns: 1fr; }
}
@media (max-width: 620px) {
  .hero, main, footer { padding-left: 18px; padding-right: 18px; }
  .hero-stats { grid-template-columns: 1fr; }
  .round-header, .test-card header { display: block; }
  .round-stats { justify-content: flex-start; margin-top: 12px; }
  .test-score { display: inline-block; margin-top: 12px; }
  .score-row { grid-template-columns: 1fr 52px; }
  .score-row-label { grid-column: 1 / -1; }
}

:root {
  --paper: #f5f5f1;
  --surface: #ffffff;
  --surface-soft: #f0f4f1;
  --ink: #1f2421;
  --muted: #5e6760;
  --faint: #879088;
  --line: #d7ddd7;
  --line-strong: #222922;
  --green: #187047;
  --red: #b43d36;
  --amber: #9a6a11;
  --violet: #6a4c93;
  --teal: #136f63;
  --sans: "Noto Sans", "Noto Sans SC", ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  --serif: "Noto Serif", "Noto Serif SC", Georgia, "Times New Roman", serif;
}
body {
  background: var(--paper);
  font-family: var(--sans);
  font-size: 15px;
  line-height: 1.58;
}
.hero {
  grid-template-columns: minmax(0, 1fr) minmax(360px, 560px);
  gap: 38px;
  background: linear-gradient(180deg, #ffffff 0%, var(--paper) 100%);
  padding: 42px 48px 30px;
}
.eyebrow {
  color: var(--teal);
  font-size: 12px;
}
h1 {
  margin-bottom: 10px;
  font-size: 44px;
  font-weight: 600;
  line-height: 1.08;
}
.run-id {
  margin: 14px 0 0;
  color: var(--faint);
  font-family: var(--mono);
  font-size: 12px;
}
.hero-stats {
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 12px;
}
.hero-stats div {
  min-height: 92px;
  background: var(--surface);
  padding: 14px;
}
.hero-stats .primary-metric {
  grid-column: span 2;
  border-color: var(--teal);
  background: #f0faf5;
}
.hero-stats strong {
  font-size: 30px;
  font-weight: 700;
}
.hero-stats .primary-metric strong { font-size: 42px; }
.hero-stats .compact-metric strong {
  font-size: 22px;
  line-height: 1.16;
  overflow-wrap: anywhere;
}
.hero-stats .compact-metric {
  grid-column: span 2;
}
.hero-stats span { font-size: 12px; }
main {
  display: grid;
  grid-template-columns: 1fr;
  gap: 28px;
  padding: 30px 48px 46px;
}
.summary-grid {
  display: grid;
  grid-template-columns: minmax(220px, .7fr) minmax(300px, .9fr) minmax(420px, 1.4fr);
  gap: 16px;
}
.panel, .skill-block {
  background: var(--surface);
  padding: 20px;
}
.panel h2, .panel h3 {
  margin-bottom: 16px;
  color: var(--ink);
}
.outcome-panel {
  background: var(--surface-soft);
  border-color: #b9c8be;
}
.outcome-score {
  margin: 2px 0 10px;
  font-family: var(--serif);
  font-size: 58px;
  font-weight: 700;
  line-height: 1;
}
.outcome-copy {
  margin: 0;
  color: var(--muted);
  font-family: var(--serif);
  font-size: 17px;
  line-height: 1.55;
}
.facts {
  gap: 9px 12px;
  font-size: 13px;
}
.facts dt { font-weight: 800; }
.content {
  gap: 22px;
}
.round-tabs {
  position: relative;
  display: grid;
  gap: 18px;
}
.tab-input {
  position: absolute;
  opacity: 0;
  pointer-events: none;
}
.tab-list {
  position: sticky;
  top: 0;
  z-index: 2;
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
  gap: 10px;
  border-bottom: 1px solid var(--line-strong);
  background: color-mix(in srgb, var(--paper) 92%, transparent);
  padding: 0 0 12px;
  backdrop-filter: blur(8px);
}
.tab-label {
  display: grid;
  gap: 2px;
  min-height: 80px;
  border: 1px solid var(--line);
  background: var(--surface);
  color: var(--ink);
  cursor: pointer;
  padding: 13px 14px;
}
.tab-label:hover { border-color: var(--teal); }
.tab-label span {
  color: inherit;
  font-size: 12px;
  font-weight: 800;
  letter-spacing: .11em;
  text-transform: uppercase;
}
.tab-label strong {
  color: var(--ink);
  font-family: var(--serif);
  font-size: 28px;
  line-height: 1;
}
.tab-label small {
  color: var(--muted);
  font-family: var(--mono);
  font-size: 11px;
}
.round-panels { min-width: 0; }
.round-panel {
  display: none;
  gap: 18px;
  scroll-margin-top: 24px;
}
.round-header {
  padding: 4px 0 16px;
}
.round-header h2 {
  font-size: 34px;
  font-weight: 600;
}
.score-row {
  grid-template-columns: minmax(150px, 260px) minmax(120px, 1fr) 52px;
  font-size: 13px;
}
.score-track { height: 12px; }
.score-track span {
  background: linear-gradient(90deg, var(--teal), var(--violet));
}
.manifest-meta {
  margin-bottom: 14px;
  font-size: 13px;
}
.test-card {
  padding: 20px 0;
}
.test-card h4 {
  font-family: var(--serif);
  font-size: 20px;
  font-weight: 600;
}
.test-score {
  padding: 7px 9px;
}
h5 { font-size: 12px; }
.skill-block summary {
  font-size: 13px;
}
pre {
  background: #fbfcfb;
}
table { font-size: 13px; }
th, td { padding: 9px 7px; }
footer {
  padding: 18px 48px 28px;
}
@media (max-width: 1180px) {
  .hero, .summary-grid { grid-template-columns: 1fr; }
  .hero-stats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .panel-grid, .feedback-grid { grid-template-columns: 1fr; }
}
@media (max-width: 620px) {
  .hero, main, footer { padding-left: 18px; padding-right: 18px; }
  h1 { font-size: 34px; }
  .hero-stats { grid-template-columns: 1fr; }
  .hero-stats .primary-metric { grid-column: auto; }
  .outcome-score { font-size: 46px; }
.tab-list { position: static; grid-template-columns: 1fr; }
}

.skill-files {
  display: grid;
  gap: 16px;
}
.file-toolbar {
  display: flex;
  justify-content: space-between;
  gap: 18px;
  align-items: end;
}
.file-toolbar h3 {
  margin-bottom: 6px;
}
.file-toolbar p {
  margin: 0;
  color: var(--muted);
  font-family: var(--serif);
  font-size: 15px;
}
.file-toolbar label {
  display: grid;
  gap: 6px;
  min-width: min(440px, 100%);
}
.file-toolbar label span {
  color: var(--muted);
  font-size: 11px;
  font-weight: 800;
  letter-spacing: .12em;
  text-transform: uppercase;
}
.file-select {
  width: 100%;
  border: 1px solid var(--line);
  background: var(--surface);
  color: var(--ink);
  font: 13px var(--mono);
  padding: 9px 10px;
}
.file-tree {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.file-tree span {
  border: 1px solid var(--line);
  background: var(--surface-soft);
  color: var(--muted);
  font-family: var(--mono);
  font-size: 12px;
  padding: 5px 7px;
}
.file-pane {
  display: none;
}
.file-pane.is-active {
  display: grid;
  gap: 14px;
}
.file-pane-header {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  border-top: 1px solid var(--line);
  padding-top: 14px;
}
.file-pane-header strong {
  font-family: var(--mono);
  font-size: 13px;
  overflow-wrap: anywhere;
}
.status-pill {
  display: inline-block;
  margin-left: 8px;
  border: 1px solid currentColor;
  padding: 2px 6px;
  font-size: 10px;
  font-weight: 800;
  letter-spacing: .08em;
  text-transform: uppercase;
}
.status-added { color: var(--green); }
.status-deleted { color: var(--red); }
.status-modified { color: var(--violet); }
.status-unchanged { color: var(--faint); }
.status-binary { color: var(--amber); }
.split-section {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 16px;
}
.split-section h4 {
  margin: 0 0 10px;
  color: var(--muted);
  font-size: 12px;
  font-weight: 800;
  letter-spacing: .12em;
  text-transform: uppercase;
}
.monaco-diff-target {
  border: 1px solid var(--line);
  min-height: 420px;
  overflow: hidden;
}
.monaco-diff-target .empty {
  padding: 20px;
}
.diff-table {
  table-layout: fixed;
  border: 1px solid var(--line);
  font-family: var(--mono);
  font-size: 12px;
}
.diff-table th {
  background: var(--surface-soft);
}
.diff-table td {
  padding: 0;
  border: 1px solid var(--line);
  vertical-align: top;
}
.diff-table .line-no {
  width: 46px;
  padding: 3px 6px;
  color: var(--faint);
  background: #f8faf8;
  text-align: right;
  user-select: none;
}
.diff-table pre,
.file-content {
  max-height: none;
  margin: 0;
  border: 0;
  background: transparent;
  padding: 3px 8px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.file-content {
  max-height: 560px;
  overflow: auto;
  border: 1px solid var(--line);
  background: #fbfcfb;
  padding: 14px;
}
.diff-add td { background: #eef8f1; }
.diff-del td { background: #fbefee; }
.diff-change td { background: #f5f0fb; }
.diff-equal td { background: #ffffff; }
.diff-skip td {
  background: var(--surface-soft);
  color: var(--faint);
  font-family: var(--mono);
  font-size: 12px;
  letter-spacing: .2em;
  padding: 6px 0;
  text-align: center;
}
.diff-change td:nth-child(2),
.diff-del td:nth-child(2) {
  border-left: 3px solid var(--red);
}
.diff-change td:nth-child(4),
.diff-add td:nth-child(4) {
  border-left: 3px solid var(--green);
}
.file-note {
  margin: 0 0 8px;
  color: var(--amber);
  font-family: var(--mono);
  font-size: 12px;
}
@media (max-width: 980px) {
  .file-toolbar { display: grid; }
  .split-section { grid-template-columns: 1fr; }
}
`;

async function main() {
  const [runDirArg, outputArg] = process.argv.slice(2);
  if (!runDirArg || runDirArg === "-h" || runDirArg === "--help") {
    console.log(usage());
    return;
  }

  const run = await loadRun(runDirArg);
  const outputPath = resolve(outputArg || join(run.runDir, DEFAULT_OUTPUT));
  await writeFile(outputPath, renderHtml(run), "utf8");
  console.log(JSON.stringify({
    output_html: outputPath,
    output_dir: run.runDir,
    run_id: run.state.run_id || "",
    rounds: run.rounds.length,
    final_score: finalScore(run),
    best_score: run.state.best_score ?? "",
    stop_reason: run.state.stop_reason || "",
  }));
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
