#!/usr/bin/env node
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

function readJson(path, fallback) {
  if (!existsSync(path)) return fallback;
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function git(cwd, args, options = {}) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...options }).trim();
}

function append(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, { encoding: "utf8", flag: "a" });
}

function lineCount(path) {
  if (!existsSync(path)) return 0;
  const text = readFileSync(path, "utf8");
  return text.length === 0 ? 0 : text.split(/\r?\n/).length - (text.endsWith("\n") ? 1 : 0);
}

function lineBudget(lines) {
  return Math.min(Math.ceil(lines + 15 * Math.log(lines + 1)), 500);
}

function clampScore(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(10, n));
}

function arrayOfStrings(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item)).filter(Boolean);
}

function normalizeStringArray(value) {
  if (Array.isArray(value)) return value.map((item) => String(item)).filter(Boolean);
  return value ? [String(value)] : [];
}

function normalizeCheck(check) {
  if (!check || typeof check !== "object") return null;
  const type = String(check.type || check.kind || "").trim();
  if (!type) return null;
  return {
    type,
    text: String(check.text || check.description || type),
    value: check.value ?? check.text ?? check.needle ?? check.expected ?? "",
    path: check.path ? String(check.path) : "",
    field: check.field ? String(check.field) : "",
    expected: check.expected,
    dimension: check.dimension ? String(check.dimension) : checkDimension(type),
  };
}

function checkDimension(type) {
  if (type === "max_tool_calls") return "efficiency";
  if (type === "result_exists" || type === "file_exists" || type === "json_field_equals") return "correctness";
  if (type === "result_contains_text" || type === "result_not_contains_text") return "correctness";
  return "correctness";
}

function normalizeEvalCase(test, index, split = "") {
  const id = String(test?.id ?? test?.name ?? `case-${index + 1}`);
  const prompt = String(test?.prompt ?? test?.query ?? `Use the skill for test case ${index + 1}.`);
  const expected = [
    ...normalizeStringArray(test?.expected_behavior),
    ...normalizeStringArray(test?.expected_output),
    ...normalizeStringArray(test?.expectations),
  ];
  const shouldTrigger = test?.should_trigger === false ? false : true;
  const checks = arrayOfObjects(test?.checks).map(normalizeCheck).filter(Boolean);
  return {
    id,
    key: safeKey(id, index),
    prompt,
    should_trigger: shouldTrigger,
    expected_behavior: expected,
    checks: checks.length || !shouldTrigger ? checks : [normalizeCheck({ type: "result_exists", text: "A primary result artifact exists" })],
    files: normalizeStringArray(test?.files),
    split,
  };
}

function arrayOfObjects(value) {
  return Array.isArray(value) ? value.filter((item) => item && typeof item === "object") : [];
}

function assignSplits(testCases) {
  if (testCases.length < 4) return testCases.map((test) => ({ ...test, split: test.split || "train" }));
  if (testCases.some((test) => test.split === "train" || test.split === "holdout")) {
    return testCases.map((test) => ({ ...test, split: test.split === "holdout" ? "holdout" : "train" }));
  }
  const holdoutCount = Math.max(1, Math.ceil(testCases.length * 0.3));
  const firstHoldout = testCases.length - holdoutCount;
  return testCases.map((test, index) => ({ ...test, split: index >= firstHoldout ? "holdout" : "train" }));
}

function average(values) {
  const nums = values.map(Number).filter(Number.isFinite);
  return nums.length ? Math.round((nums.reduce((sum, n) => sum + n, 0) / nums.length) * 100) / 100 : 0;
}

function passRate(results) {
  return results.length ? Math.round((results.filter((item) => item.passed).length / results.length) * 100) / 100 : 1;
}

function readText(path) {
  return path && existsSync(path) ? readFileSync(path, "utf8") : "";
}

function resolveCheckPath(basePath, checkPath) {
  if (!checkPath) return basePath;
  return resolve(dirname(basePath || "."), checkPath);
}

function getJsonField(value, path) {
  return String(path || "")
    .split(".")
    .filter(Boolean)
    .reduce((current, key) => current?.[key], value);
}

function dimensionDefaults(value = 0) {
  return {
    correctness_score: value,
    process_score: value,
    compliance_score: value,
    efficiency_score: value,
    triggering_score: value,
  };
}

function focusWeights(focus) {
  const map = {
    speed: { correctness_score: 0.3, process_score: 0.15, compliance_score: 0.1, efficiency_score: 0.35, triggering_score: 0.1 },
    compliance: { correctness_score: 0.3, process_score: 0.1, compliance_score: 0.35, efficiency_score: 0.1, triggering_score: 0.15 },
    recall: { correctness_score: 0.15, process_score: 0.05, compliance_score: 0.05, efficiency_score: 0.05, triggering_score: 0.7 },
    format: { correctness_score: 0.3, process_score: 0.25, compliance_score: 0.2, efficiency_score: 0.1, triggering_score: 0.15 },
    conciseness: { correctness_score: 0.3, process_score: 0.2, compliance_score: 0.1, efficiency_score: 0.3, triggering_score: 0.1 },
  };
  return map[String(focus || "").toLowerCase()] || {
    correctness_score: 0.45,
    process_score: 0.2,
    compliance_score: 0.15,
    efficiency_score: 0.1,
    triggering_score: 0.1,
  };
}

function weightedScore(dimensions, focus) {
  const weights = focusWeights(focus);
  const score = Object.entries(weights).reduce((sum, [key, weight]) => sum + clampScore(dimensions[key]) * weight, 0);
  return Math.round(score * 100) / 100;
}

function dimensionAverages(evaluations) {
  return {
    correctness_score: average(evaluations.map((item) => item.dimension_scores?.correctness_score)),
    process_score: average(evaluations.map((item) => item.dimension_scores?.process_score)),
    compliance_score: average(evaluations.map((item) => item.dimension_scores?.compliance_score)),
    efficiency_score: average(evaluations.map((item) => item.dimension_scores?.efficiency_score)),
    triggering_score: average(evaluations.map((item) => item.dimension_scores?.triggering_score)),
  };
}

function weakestDimension(dimensions) {
  const entries = Object.entries(dimensions);
  if (!entries.length) return "none";
  return entries.reduce((min, item) => (Number(item[1]) < Number(min[1]) ? item : min), entries[0])[0];
}

function triggerMetrics(evaluations) {
  const rows = evaluations.filter((item) => typeof item.used_target_skill === "boolean");
  const tp = rows.filter((item) => item.expected_trigger && item.used_target_skill).length;
  const fn = rows.filter((item) => item.expected_trigger && !item.used_target_skill).length;
  const fp = rows.filter((item) => !item.expected_trigger && item.used_target_skill).length;
  const tn = rows.filter((item) => !item.expected_trigger && !item.used_target_skill).length;
  const total = tp + tn + fp + fn;
  return {
    true_positive: tp,
    false_negative: fn,
    false_positive: fp,
    true_negative: tn,
    accuracy: total ? round2((tp + tn) / total) : 1,
    precision: tp + fp ? round2(tp / (tp + fp)) : 1,
    recall: tp + fn ? round2(tp / (tp + fn)) : 1,
  };
}

function round2(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

function safeKey(value, index = 0) {
  const base = String(value || `case-${index + 1}`)
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return `${index}-${base || "case"}`;
}

function parseInteger(value, name) {
  const n = Number(value);
  if (!Number.isInteger(n)) throw new Error(`${name} must be an integer`);
  return n;
}

function parseJsonObjectText(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) throw new Error("empty JSON text");
  try {
    return JSON.parse(trimmed);
  } catch {}

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    try {
      return JSON.parse(fenced[1].trim());
    } catch {}
  }

  const start = trimmed.indexOf("{");
  if (start < 0) throw new Error("no JSON object found");
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === "\"") {
        inString = false;
      }
      continue;
    }
    if (ch === "\"") inString = true;
    if (ch === "{") depth++;
    if (ch === "}") depth--;
    if (depth === 0) return JSON.parse(trimmed.slice(start, i + 1));
  }
  throw new Error("unterminated JSON object");
}

function parseSkillName(skillFile, fallback) {
  const text = readFileSync(skillFile, "utf8");
  const match = text.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!match) return fallback;
  const name = match[1].match(/^name:\s*["']?([^"'\n]+)["']?\s*$/m);
  return name ? name[1].trim() : fallback;
}

function normalizePathPart(path) {
  return String(path || "").replaceAll("\\", "/");
}

function validateSkillLocation(repoRoot, skillDir) {
  const rel = normalizePathPart(relative(repoRoot, skillDir));
  const parts = rel.split("/").filter(Boolean);
  const valid =
    parts.length >= 3 &&
    ((parts[0] === ".agents" && parts[1] === "skills") ||
      (parts[0] === ".claude" && parts[1] === "skills"));
  if (!valid || rel.startsWith("..")) {
    throw new Error("skill_path must be under .agents/skills or .claude/skills in the repository");
  }
  return rel;
}

const GIT_IDENTITY = [
  "-c",
  "user.name=Skill Optimizer",
  "-c",
  "user.email=skill-optimizer@example.invalid",
];

function commitSkill(worktreePath, skillRelPath, message) {
  git(worktreePath, ["add", "--", skillRelPath]);
  git(worktreePath, [...GIT_IDENTITY, "commit", "--allow-empty", "-m", message]);
  return git(worktreePath, ["rev-parse", "HEAD"]);
}

function createWorktree({ repoRoot, outputDir, runId, skillDir, skillRelPath }) {
  const worktreePath = join(outputDir, "worktree");
  const patchPath = join(outputDir, "skill.patch");
  mkdirSync(outputDir, { recursive: true });
  rmSync(worktreePath, { recursive: true, force: true });

  const baseSha = git(repoRoot, ["rev-parse", "--verify", "HEAD^{commit}"]);
  try {
    git(repoRoot, ["worktree", "remove", "--force", worktreePath]);
  } catch {}
  git(repoRoot, ["worktree", "add", "--detach", worktreePath, baseSha]);

  const worktreeSkillDir = join(worktreePath, ...skillRelPath.split("/"));
  rmSync(worktreeSkillDir, { recursive: true, force: true });
  mkdirSync(dirname(worktreeSkillDir), { recursive: true });
  cpSync(skillDir, worktreeSkillDir, { recursive: true, force: true });
  const baselineSha = commitSkill(worktreePath, skillRelPath, `skill optimizer baseline ${runId}`);
  return { worktreePath, patchPath, baseSha, baselineSha, worktreeSkillDir };
}

function isRecallFocus(focus) {
  return String(focus || "").toLowerCase() === "recall";
}

function executionPrompt(state, test, resultPath) {
  if (isRecallFocus(state.focus)) return String(test.prompt || "");
  const lines = [
    "This is an evaluation task. Complete the user request below as faithfully as possible.",
    "Treat the task text as the full user request; use the listed input files when helpful.",
    "",
    "Task:",
  ];
  if (!isRecallFocus(state.focus) && test.should_trigger !== false) {
    lines.push(`- Skill path: ${state.skill_rel_path}`);
  }
  lines.push(
    `- Task: ${String(test.prompt || "")}`,
    `- Input files: ${inputFiles(test.files)}`,
    `- Save primary output to: ${resultPath}`,
  );
  return lines.join("\n");
}

function runsPerTest(state) {
  return isRecallFocus(state.focus) ? Number(state.recall_runs_per_query || 3) : 1;
}

function testJobs(state, tests, dirRoot) {
  return tests.flatMap((test) => {
    const runs = runsPerTest(state);
    return Array.from({ length: runs }, (_, index) => {
      const runIndex = index + 1;
      const key = runs === 1 ? test.key : `${test.key}-run-${runIndex}`;
      const dir = join(dirRoot, key);
      mkdirSync(dir, { recursive: true });
      return {
        key,
        test_key: test.key,
        test_id: test.id,
        prompt: test.prompt,
        should_trigger: Boolean(test.should_trigger),
        split: test.split || "train",
        files: test.files || [],
        run_index: runIndex,
        result_path: join(dir, "result.md"),
        case_context_path: join(dir, "case-context.md"),
        checks_path: join(dir, "checks.json"),
        used_skills_path: join(dir, "used-skills.json"),
        raw_eval_path: join(dir, "raw-evaluation.json"),
        normalized_eval_path: join(dir, "evaluation.json"),
        trigger_result_path: join(dir, "trigger-evaluation.json"),
        execution_prompt: executionPrompt(state, test, join(dir, "result.md")),
      };
    });
  });
}

function inputFiles(files) {
  const values = normalizeStringArray(files);
  return values.length ? values.join(", ") : "none";
}

function parseUsedSkills(value) {
  if (Array.isArray(value)) return value.map((item) => String(item)).filter(Boolean);
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map((item) => String(item)).filter(Boolean) : [];
  } catch {
    return [String(value)];
  }
}

function skillAliases(state) {
  return [
    state.skill_name,
    state.skill_dir_name,
    state.skill_rel_path,
    state.worktree_skill_dir,
  ].filter(Boolean);
}

function usedTargetSkill(usedSkills, state) {
  const aliases = skillAliases(state).map((item) => normalizePathPart(item).toLowerCase());
  return usedSkills.some((raw) => {
    const value = normalizePathPart(raw).toLowerCase().trim();
    const base = value.split("/").filter(Boolean).at(-1) || value;
    return aliases.some((alias) => {
      if (value === alias || base === alias) return true;
      if (alias.includes("/") && (value.endsWith(alias) || value.includes(alias))) return true;
      return new RegExp(`(^|[^a-z0-9_-])${escapeRegExp(alias)}([^a-z0-9_-]|$)`, "i").test(value);
    });
  });
}

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function writeFinalPatch(state, targetSha) {
  const patch = git(state.worktree_path, ["diff", "--binary", state.baseline_sha, targetSha, "--", state.skill_rel_path]);
  writeFileSync(state.patch_path, patch ? `${patch}\n` : "", "utf8");
}

function stateFrom(path) {
  return readJson(path, {});
}

function saveState(state) {
  writeJson(state.state_path, state);
}

function latestAttemptFile(dir, suffix) {
  if (!dir || !existsSync(dir)) return "";
  return readdirSync(dir)
    .filter((name) => name.startsWith("attempt-") && name.endsWith(suffix))
    .sort()
    .map((name) => join(dir, name))
    .at(-1) ?? "";
}

function artifactDir(workspace, runId, stepId, round, key, laneIndex) {
  const root = resolve(workspace || ".", ".acpus/state/runs", runId, "artifacts");
  const exactPaths = [
    `workflow:optimize:$do:round_eval:$case_1:run_trigger_cases:$do:${stepId}:round:${round}:item:${key}:lane:${laneIndex}`,
    `workflow:optimize:$do:round_eval:$default:run_cases:$do:${stepId}:round:${round}:item:${key}:lane:${laneIndex}`,
    `workflow:optimize:$do:run_cases:$do:${stepId}:round:${round}:item:${key}:lane:${laneIndex}`,
  ].map((name) => join(root, name));
  const exact = exactPaths.find((path) => existsSync(path));
  if (exact) return exact;
  if (!existsSync(root)) return "";
  const paths = readdirSync(root).map((name) => join(root, name));
  const required = [`:${stepId}:`, `:item:${key}:`, `:lane:${laneIndex}`, `:round:${round}:`];
  return paths.find((path) => required.every((part) => basename(path).includes(part))) ?? "";
}

function transcriptPathFromTelemetry(telemetryPath) {
  if (!telemetryPath || !existsSync(telemetryPath)) return "";
  try {
    const telemetry = readJson(telemetryPath, {});
    const id = telemetry.acpxRecordId;
    return id ? join(homedir(), ".acpx", "sessions", `${id}.json`) : "";
  } catch {
    return "";
  }
}

function toolCallCountFromTelemetry(telemetryPath) {
  if (!telemetryPath || !existsSync(telemetryPath)) return 0;
  try {
    const telemetry = readJson(telemetryPath, {});
    return Number(telemetry.tools?.totalToolCallCount ?? telemetry.toolCallCount ?? 0) || 0;
  } catch {
    return 0;
  }
}

function init([skillPath, outputRoot, runId, focus, maxIterationsRaw, testCaseCountRaw, evalCasesPathRaw = "", triggerThresholdRaw = "0.5", recallRunsRaw = "3"]) {
  const requestedSkillDir = resolve(skillPath);
  const requestedSkillFile = join(requestedSkillDir, "SKILL.md");
  if (!existsSync(requestedSkillFile)) throw new Error(`skill_path must contain SKILL.md: ${requestedSkillDir}`);
  const skillDir = realpathSync(requestedSkillDir);
  const skillFile = join(skillDir, "SKILL.md");
  const repoRoot = realpathSync(git(skillDir, ["rev-parse", "--show-toplevel"]));
  const skillRelPath = validateSkillLocation(repoRoot, skillDir);
  const skillDirName = basename(skillDir);
  const skillName = parseSkillName(skillFile, skillDirName);

  const maxIterations = parseInteger(maxIterationsRaw, "max_iterations");
  if (maxIterations < 1 || maxIterations > 50) {
    throw new Error("max_iterations must be between 1 and 50");
  }
  const testCaseCount = parseInteger(testCaseCountRaw, "test_case_count");
  if (testCaseCount < 1 || testCaseCount > 25) {
    throw new Error("test_case_count must be between 1 and 25");
  }
  const triggerThreshold = Number(triggerThresholdRaw || 0.5);
  if (!Number.isFinite(triggerThreshold) || triggerThreshold <= 0 || triggerThreshold >= 1) {
    throw new Error("trigger_threshold must be greater than 0 and less than 1");
  }
  const recallRuns = parseInteger(recallRunsRaw, "recall_runs_per_query");
  if (recallRuns < 1 || recallRuns > 10) {
    throw new Error("recall_runs_per_query must be between 1 and 10");
  }

  const outputDir = resolve(outputRoot, runId);
  const roundsDir = join(outputDir, "rounds");
  mkdirSync(roundsDir, { recursive: true });
  const worktree = createWorktree({ repoRoot, outputDir, runId, skillDir, skillRelPath });
  const originalLineCount = lineCount(skillFile);
  const budget = lineBudget(originalLineCount);
  const state = {
    run_id: runId,
    workspace: repoRoot,
    original_skill_dir: skillDir,
    skill_path: skillDir,
    skill_rel_path: skillRelPath,
    skill_name: skillName,
    skill_dir_name: skillDirName,
    worktree_skill_dir: worktree.worktreeSkillDir,
    worktree_path: worktree.worktreePath,
    patch_path: worktree.patchPath,
    base_sha: worktree.baseSha,
    baseline_sha: worktree.baselineSha,
    candidate_shas: [],
    evaluated: [],
    last_evaluated_sha: worktree.baselineSha,
    best_evaluated_sha: worktree.baselineSha,
    output_dir: outputDir,
    rounds_dir: roundsDir,
    report_path: join(outputDir, "report.md"),
    state_path: join(outputDir, "state.json"),
    focus: String(focus || "quality"),
    max_iterations: maxIterations,
    test_case_count: testCaseCount,
    trigger_threshold: triggerThreshold,
    recall_runs_per_query: recallRuns,
    original_line_count: originalLineCount,
    line_budget: budget,
    best_score: 0,
    stagnation_rounds: 0,
    rounds: [],
    stop_reason: "not-started",
    eval_cases_path: evalCasesPathRaw ? resolve(evalCasesPathRaw) : "",
  };
  saveState(state);
  writeFileSync(
    state.report_path,
    [
      "# Skill Optimizer Report",
      "",
      `- Skill: ${skillDir}`,
      `- Worktree skill: ${worktree.worktreeSkillDir}`,
      `- Focus: ${state.focus}`,
      `- Max iterations: ${maxIterations}`,
      `- Test cases: ${testCaseCount}`,
      `- Recall runs per query: ${recallRuns}`,
      `- Trigger threshold: ${triggerThreshold}`,
      `- Eval cases path: ${state.eval_cases_path || "auto-generated"}`,
      `- Original lines: ${originalLineCount}`,
      `- Line budget: ${budget}`,
      "",
    ].join("\n"),
    "utf8",
  );

  return {
    output_dir: outputDir,
    state_path: state.state_path,
    report_path: state.report_path,
    skill_dir: worktree.worktreeSkillDir,
    skill_name: skillName,
    skill_rel_path: skillRelPath,
    worktree_path: worktree.worktreePath,
    patch_path: worktree.patchPath,
    original_line_count: originalLineCount,
    line_budget: budget,
    max_iterations: maxIterations,
    test_case_count: testCaseCount,
    trigger_threshold: triggerThreshold,
    recall_runs_per_query: recallRuns,
    eval_cases_path: state.eval_cases_path,
    focus: state.focus,
  };
}

function normalizeTests([statePath], env = process.env) {
  const state = stateFrom(statePath);
  let raw = [];
  let source = "generated";
  if (state.eval_cases_path && existsSync(state.eval_cases_path)) {
    const parsed = readJson(state.eval_cases_path, []);
    raw = Array.isArray(parsed) ? parsed : parsed?.test_cases ?? parsed?.evals ?? [];
    source = "file";
  } else {
    try {
      const parsed = JSON.parse(env.TEST_CASES || "[]");
      raw = Array.isArray(parsed) ? parsed : parsed?.test_cases;
    } catch {
      raw = [];
    }
  }
  if (!Array.isArray(raw) || raw.length === 0) {
    raw = [{ id: "default", prompt: "Carry out the skill's primary documented task." }];
  }
  const used = new Set();
  const limit = source === "file" ? 25 : state.test_case_count;
  const testCases = assignSplits(raw.slice(0, limit).map((test, index) => {
    const normalized = normalizeEvalCase(test, index, test?.split);
    let key = normalized.key;
    while (used.has(key)) key = `${key}-${used.size}`;
    used.add(key);
    return { ...normalized, key };
  }));
  const testsPath = join(state.output_dir, "test-cases.json");
  writeJson(testsPath, testCases);
  state.test_cases = testCases;
  state.tests_path = testsPath;
  state.test_source = source;
  saveState(state);
  return {
    tests_path: testsPath,
    test_count: testCases.length,
    test_cases: testCases.map((test) => ({
      id: test.id,
      key: test.key,
      prompt: test.prompt,
      should_trigger: test.should_trigger,
      split: test.split,
      files: test.files,
    })),
  };
}

function prepareRound([statePath, roundRaw]) {
  const state = stateFrom(statePath);
  const round = parseInteger(roundRaw, "round");
  const roundDir = join(state.rounds_dir, `round-${round}`);
  mkdirSync(roundDir, { recursive: true });
  const casesDir = join(roundDir, "cases");
  const caseJobs = testJobs(state, state.test_cases || [], casesDir);
  const currentRound = {
    round,
    round_dir: roundDir,
    skill_dir: state.worktree_skill_dir,
    worktree_path: state.worktree_path,
    improvement_manifest_path: join(roundDir, "improvement-manifest.json"),
    summary_path: join(roundDir, "evaluation-summary.json"),
    improvement_summary_path: join(roundDir, "improvement-summary.json"),
    case_jobs: caseJobs,
  };
  state.current_round = currentRound;
  saveState(state);
  writeJson(join(roundDir, "case-jobs.json"), caseJobs);
  return currentRound;
}

function collectCase([statePath, roundRaw, key, resultPathRaw, contextPath, usedSkillsPath, runId, laneIndexRaw], env = process.env) {
  const state = stateFrom(statePath);
  const round = parseInteger(roundRaw, "round");
  const laneIndex = parseInteger(laneIndexRaw, "lane_index");
  const test = (state.test_cases || []).find((item) => item.key === key) ?? {};
  const resultPath = resultPathRaw === "none" ? "" : resolve(resultPathRaw);
  const dir = artifactDir(state.workspace, runId, "executor", round, key, laneIndex);
  const telemetryPath = latestAttemptFile(dir, ".telemetry.json");
  const responsePath = latestAttemptFile(dir, ".response.md");
  const transcriptPath = transcriptPathFromTelemetry(telemetryPath);
  const toolCallCount = toolCallCountFromTelemetry(telemetryPath);
  const hadResult = Boolean(resultPath && existsSync(resultPath) && statSync(resultPath).size > 0);
  const usedSkills = parseUsedSkills(env.USED_SKILLS);
  const usedTarget = usedTargetSkill(usedSkills, state);
  writeJson(usedSkillsPath, {
    test_id: test.id || key,
    key,
    should_trigger: test.should_trigger !== false,
    used_skills: usedSkills,
    used_target_skill: usedTarget,
    target_skill: state.skill_name,
  });
  const context = [
    `# Skill Optimizer Case Context`,
    "",
    `- Test id: ${test.id || key}`,
    `- Should trigger: ${test.should_trigger !== false}`,
    `- Split: ${test.split || "train"}`,
    `- Focus: ${state.focus}`,
    `- Skill directory: ${state.worktree_skill_dir}`,
    `- Input files: ${inputFiles(test.files)}`,
    `- Used target skill: ${usedTarget}`,
    `- Used skills record: ${usedSkillsPath}`,
    `- Result path: ${resultPath || "none"}`,
    `- Result exists: ${hadResult}`,
    `- Executor response artifact: ${responsePath || "none"}`,
    `- Executor telemetry: ${telemetryPath || "none"}`,
    `- Executor transcript: ${transcriptPath || "none"}`,
    `- Executor tool calls: ${toolCallCount}`,
    "",
    `## Test Prompt`,
    "",
    String(test.prompt || ""),
    "",
    `## Expected Behavior`,
    "",
    arrayOfStrings(test.expected_behavior).map((item) => `- ${item}`).join("\n") || "No explicit expected behavior was provided.",
    "",
    `## Deterministic Checks`,
    "",
    arrayOfObjects(test.checks).map((check) => `- ${check.text || check.type}`).join("\n") || "No deterministic checks were provided.",
    "",
  ];
  if (resultPath && existsSync(resultPath)) {
    context.push("## Result Preview", "", readFileSync(resultPath, "utf8").slice(0, 8000), "");
  }
  if (responsePath && existsSync(responsePath)) {
    context.push("## Executor Final Response", "", readFileSync(responsePath, "utf8").slice(0, 8000), "");
  }
  mkdirSync(dirname(contextPath), { recursive: true });
  writeFileSync(contextPath, context.join("\n"), "utf8");
  return {
    result_path: resultPath || "none",
    case_context_path: contextPath,
    used_skills_path: usedSkillsPath,
    used_target_skill: usedTarget,
    telemetry_path: telemetryPath || "none",
    transcript_path: transcriptPath || "none",
    tool_call_count: toolCallCount,
    had_result: hadResult,
  };
}

function collectTriggerReport([statePath, testKey, jobKey, triggerResultPath], env = process.env) {
  const state = stateFrom(statePath);
  const test = (state.test_cases || []).find((item) => item.key === testKey) ?? {};
  const usedSkills = parseUsedSkills(env.USED_SKILLS);
  const usedTarget = usedTargetSkill(usedSkills, state);
  const reason = String(env.REASON || "").trim();
  const result = {
    test_id: test.id || testKey,
    test_key: testKey,
    key: jobKey,
    split: test.split || "train",
    should_trigger: test.should_trigger !== false,
    run_index: Number(jobKey.match(/-run-(\d+)$/)?.[1] || 1),
    triggered: usedTarget,
    used_target_skill: usedTarget,
    used_skills: usedSkills,
    reason,
  };
  writeJson(triggerResultPath, result);
  return {
    test_id: result.test_id,
    test_key: testKey,
    key: jobKey,
    triggered: usedTarget,
    used_target_skill: usedTarget,
    trigger_result_path: triggerResultPath,
  };
}

function evaluateCheck(check, resultPath, toolCallCount) {
  const resultText = readText(resultPath);
  const type = check.type;
  try {
    if (type === "result_exists") {
      return { passed: Boolean(resultPath && existsSync(resultPath) && statSync(resultPath).size > 0), evidence: resultPath || "none" };
    }
    if (type === "result_contains_text") {
      const needle = String(check.value || "");
      return { passed: resultText.includes(needle), evidence: needle ? `searched for ${needle}` : "missing text value" };
    }
    if (type === "result_not_contains_text") {
      const needle = String(check.value || "");
      return { passed: needle ? !resultText.includes(needle) : true, evidence: needle ? `searched for absence of ${needle}` : "missing text value" };
    }
    if (type === "file_exists") {
      const path = resolveCheckPath(resultPath, check.path || String(check.value || ""));
      return { passed: existsSync(path), evidence: path };
    }
    if (type === "json_field_equals") {
      const jsonPath = resolveCheckPath(resultPath, check.path);
      const data = readJson(jsonPath, null);
      const actual = getJsonField(data, check.field);
      return { passed: JSON.stringify(actual) === JSON.stringify(check.expected), evidence: `${check.field}: ${JSON.stringify(actual)}` };
    }
    if (type === "max_tool_calls") {
      const max = Number(check.value || check.expected || 0);
      return { passed: Number(toolCallCount || 0) <= max, evidence: `${toolCallCount} <= ${max}` };
    }
    return { passed: false, evidence: `unsupported check type: ${type}` };
  } catch (error) {
    return { passed: false, evidence: error instanceof Error ? error.message : String(error) };
  }
}

function runChecks([statePath, _roundRaw, key, resultPathRaw, checksPath, toolCallCountRaw]) {
  const state = stateFrom(statePath);
  const test = (state.test_cases || []).find((item) => item.key === key) ?? {};
  const resultPath = resultPathRaw === "none" ? "" : resolve(resultPathRaw);
  const checks = arrayOfObjects(test.checks);
  const toolCallCount = Number(toolCallCountRaw || 0);
  const results = checks.map((check) => {
    const normalized = normalizeCheck(check);
    const outcome = evaluateCheck(normalized, resultPath, toolCallCount);
    return {
      type: normalized.type,
      text: normalized.text,
      dimension: normalized.dimension,
      passed: Boolean(outcome.passed),
      evidence: String(outcome.evidence || ""),
    };
  });
  const summary = {
    test_id: test.id || key,
    key,
    split: test.split || "train",
    checks_total: results.length,
    checks_passed: results.filter((item) => item.passed).length,
    check_pass_rate: passRate(results),
    checks: results,
  };
  writeJson(checksPath, summary);
  return {
    key,
    checks_path: checksPath,
    checks_total: summary.checks_total,
    checks_passed: summary.checks_passed,
    check_pass_rate: summary.check_pass_rate,
  };
}

function triggerSummaryRows(state, outputs) {
  const runs = outputs.map((item) => readJson(item.trigger_result_path, item)).filter((item) => item.test_key || item.key);
  return (state.test_cases || []).map((test) => {
    const testRuns = runs.filter((item) => item.test_key === test.key || item.key === test.key);
    const triggeredRuns = testRuns.filter((item) => item.triggered).length;
    const totalRuns = testRuns.length || runsPerTest(state);
    const triggerRate = totalRuns ? round2(triggeredRuns / totalRuns) : 0;
    const predictedTrigger = triggerRate >= state.trigger_threshold;
    const expectedTrigger = test.should_trigger !== false;
    const passed = expectedTrigger ? predictedTrigger : !predictedTrigger;
    const triggerScore = passed ? 10 : 0;
    const label = expectedTrigger && predictedTrigger ? "true_positive"
      : expectedTrigger && !predictedTrigger ? "false_negative"
        : !expectedTrigger && predictedTrigger ? "false_positive"
          : "true_negative";
    const reasons = testRuns.map((item) => String(item.reason || "").trim()).filter(Boolean);
    return {
      test_id: test.id || test.key,
      key: test.key,
      split: test.split || "train",
      should_trigger: expectedTrigger,
      runs: totalRuns,
      triggered_runs: triggeredRuns,
      trigger_rate: triggerRate,
      trigger_threshold: state.trigger_threshold,
      predicted_trigger: predictedTrigger,
      pass: passed,
      label,
      score: triggerScore,
      dimension_scores: dimensionDefaults(triggerScore),
      check_pass_rate: passed ? 1 : 0,
      can_improve: !passed,
      strengths: passed ? ["Trigger behavior matched the expected recall label."] : [],
      weaknesses: passed ? [] : [`Trigger behavior was ${label.replace("_", " ")} at rate ${triggerRate}.`],
      suggestions: expectedTrigger
        ? ["Improve frontmatter description so the skill naturally triggers for this class of request."]
        : ["Narrow frontmatter description so near-miss requests do not trigger the skill."],
      violated_rules: [],
      rubric_notes: reasons,
      reasons,
      trigger_runs: testRuns,
      valid: true,
    };
  });
}

function triggerClassificationMetrics(rows) {
  const tp = rows.filter((item) => item.label === "true_positive").length;
  const fp = rows.filter((item) => item.label === "false_positive").length;
  const fn = rows.filter((item) => item.label === "false_negative").length;
  const tn = rows.filter((item) => item.label === "true_negative").length;
  return {
    precision: tp + fp ? round2(tp / (tp + fp)) : 0,
    recall: tp + fn ? round2(tp / (tp + fn)) : 0,
    accuracy: rows.length ? round2((tp + tn) / rows.length) : 0,
    false_positives: fp,
    false_negatives: fn,
    true_positives: tp,
    true_negatives: tn,
  };
}

function aggregateTriggerEval([statePath, roundRaw], env = process.env) {
  const state = stateFrom(statePath);
  const round = parseInteger(roundRaw, "round");
  const isBaseline = round === 0;
  let laneOutputs = [];
  try {
    const parsed = JSON.parse(env.TRIGGER_RESULTS || "[]");
    laneOutputs = Array.isArray(parsed) ? parsed : [];
  } catch {
    laneOutputs = [];
  }
  const full = triggerSummaryRows(state, laneOutputs);
  const train = full.filter((item) => item.split !== "holdout");
  const holdout = full.filter((item) => item.split === "holdout");
  const avgScore = average(full.map((item) => item.score));
  const trainAvgScore = average(train.map((item) => item.score));
  const holdoutAvgScore = average(holdout.map((item) => item.score));
  const currentBestScore = train.length ? trainAvgScore : avgScore;
  const previousBest = Number(state.best_score || 0);
  const bestScore = Math.max(previousBest, currentBestScore);
  const stagnationRounds = currentBestScore > previousBest ? 0 : Number(state.stagnation_rounds || 0) + 1;
  const metrics = triggerClassificationMetrics(full);
  const improvementSet = train.length ? train : full;
  const weakest = improvementSet.find((item) => !item.pass) || improvementSet[0] || { test_id: "none", score: 0 };
  const summaryPath = state.current_round?.summary_path ?? join(state.output_dir, `round-${round}-summary.json`);
  const improvementSummaryPath = state.current_round?.improvement_summary_path ?? join(state.output_dir, `round-${round}-improvement-summary.json`);
  const baselineScore = isBaseline ? avgScore : Number(state.baseline_summary?.baseline_score || 0);
  const summary = {
    round,
    avg_score: avgScore,
    train_avg_score: trainAvgScore,
    holdout_avg_score: holdoutAvgScore,
    best_score: bestScore,
    current_best_score: currentBestScore,
    can_improve: full.length === 0 || full.some((item) => !item.pass),
    evaluation_count: full.length,
    train_count: train.length,
    holdout_count: holdout.length,
    weakest_test: String(weakest.test_id || weakest.key || "none"),
    weakest_score: clampScore(weakest.score),
    weakest_dimension: "triggering_score",
    stagnation_rounds: stagnationRounds,
    skill_line_count: lineCount(join(state.worktree_skill_dir, "SKILL.md")),
    original_line_count: state.original_line_count,
    line_budget: state.line_budget,
    violation_count: 0,
    check_pass_rate: metrics.accuracy,
    trigger_metrics: metrics,
    dimension_scores: dimensionAverages(full),
    train_dimension_scores: dimensionAverages(improvementSet),
    baseline_score: baselineScore,
    baseline_delta: isBaseline ? 0 : round2(avgScore - baselineScore),
    score_by_test: Object.fromEntries(full.map((item) => [item.test_id || item.key, clampScore(item.score)])),
    evaluations: full,
  };
  const improvementSummary = {
    round,
    focus: state.focus,
    train_avg_score: trainAvgScore,
    train_dimension_scores: summary.train_dimension_scores,
    weakest_test: summary.weakest_test,
    weakest_score: summary.weakest_score,
    weakest_dimension: summary.weakest_dimension,
    trigger_metrics: metrics,
    evaluations: improvementSet,
  };
  writeJson(summaryPath, summary);
  writeJson(improvementSummaryPath, improvementSummary);
  if (isBaseline) {
    state.baseline_summary = { ...summary, baseline_score: avgScore, baseline_count: full.length, summary_path: summaryPath };
  }
  state.best_score = bestScore;
  state.stagnation_rounds = stagnationRounds;
  state.last_aggregate = { ...summary, summary_path: summaryPath, improvement_summary_path: improvementSummaryPath };
  saveState(state);
  append(
    state.report_path,
    [
      `## Round ${round}${isBaseline ? " (baseline)" : ""}`,
      "",
      `- Recall trigger score: ${avgScore}`,
      `- Trigger accuracy: ${metrics.accuracy}`,
      `- Trigger precision: ${metrics.precision}`,
      `- Trigger recall: ${metrics.recall}`,
      `- False positives: ${metrics.false_positives}`,
      `- False negatives: ${metrics.false_negatives}`,
      `- Baseline delta: ${summary.baseline_delta}`,
      `- Weakest test: ${summary.weakest_test} (${summary.weakest_score})`,
      `- Evaluation summary: ${summaryPath}`,
      `- Improvement summary: ${improvementSummaryPath}`,
      "",
    ].join("\n"),
  );
  return {
    round,
    avg_score: summary.avg_score,
    train_avg_score: summary.train_avg_score,
    holdout_avg_score: summary.holdout_avg_score,
    best_score: summary.best_score,
    current_best_score: summary.current_best_score,
    can_improve: summary.can_improve,
    evaluation_count: summary.evaluation_count,
    train_count: summary.train_count,
    holdout_count: summary.holdout_count,
    weakest_test: summary.weakest_test,
    weakest_score: summary.weakest_score,
    weakest_dimension: summary.weakest_dimension,
    stagnation_rounds: summary.stagnation_rounds,
    skill_line_count: summary.skill_line_count,
    original_line_count: summary.original_line_count,
    line_budget: summary.line_budget,
    violation_count: summary.violation_count,
    check_pass_rate: summary.check_pass_rate,
    summary_path: summaryPath,
    improvement_summary_path: improvementSummaryPath,
  };
}

function normalizeEval([statePath, roundRaw, key, rawEvalPath, normalizedPath, checksPath, usedSkillsPath, runId, laneIndexRaw]) {
  const state = stateFrom(statePath);
  const round = parseInteger(roundRaw, "round");
  const laneIndex = parseInteger(laneIndexRaw, "lane_index");
  const test = (state.test_cases || []).find((item) => item.key === key) ?? {};
  const checkSummary = readJson(checksPath, { checks: [], check_pass_rate: 1 });
  const usage = readJson(usedSkillsPath, { used_skills: [], used_target_skill: false });
  const expectedTrigger = test.should_trigger !== false;
  const usedTarget = Boolean(usage.used_target_skill);
  const triggerPassed = usedTarget === expectedTrigger;
  const deterministicTriggerScore = triggerPassed ? 10 : 0;
  let text = existsSync(rawEvalPath) ? readFileSync(rawEvalPath, "utf8") : "";
  if (!text.trim()) {
    const dir = artifactDir(state.workspace, runId, "evaluator", round, key, laneIndex);
    const responsePath = latestAttemptFile(dir, ".response.md");
    if (responsePath) text = readFileSync(responsePath, "utf8");
  }

  let parsed = {};
  let valid = true;
  let parseError = "";
  try {
    parsed = parseJsonObjectText(text);
  } catch (error) {
    valid = false;
    parseError = error instanceof Error ? error.message : String(error);
  }

  const rubricBase = valid ? clampScore(parsed.score) : 0;
  const rubric = valid ? {
    correctness_score: clampScore(parsed.correctness_score ?? rubricBase),
    process_score: clampScore(parsed.process_score ?? rubricBase),
    compliance_score: clampScore(parsed.compliance_score ?? rubricBase),
    efficiency_score: clampScore(parsed.efficiency_score ?? rubricBase),
    triggering_score: isRecallFocus(state.focus) ? deterministicTriggerScore : clampScore(parsed.triggering_score ?? (test.should_trigger === false ? 10 : rubricBase)),
  } : dimensionDefaults(0);
  const checkRows = arrayOfObjects(checkSummary.checks);
  const checkDimensions = Object.fromEntries(Object.keys(dimensionDefaults()).map((dimensionKey) => {
    const dimension = dimensionKey.replace(/_score$/, "");
    const rows = checkRows.filter((item) => item.dimension === dimension);
    return [dimensionKey, rows.length ? passRate(rows) * 10 : rubric[dimensionKey]];
  }));
  const dimensionScores = Object.fromEntries(Object.keys(dimensionDefaults()).map((keyName) => [
    keyName,
    keyName === "triggering_score" && isRecallFocus(state.focus)
      ? deterministicTriggerScore
      : round2(rubric[keyName] * 0.7 + checkDimensions[keyName] * 0.3),
  ]));
  const score = weightedScore(dimensionScores, state.focus);
  const evaluation = {
    test_id: String(parsed.test_id || test.id || key),
    key,
    split: test.split || "train",
    score,
    dimension_scores: dimensionScores,
    check_pass_rate: Number(checkSummary.check_pass_rate ?? 1),
    checks_path: checksPath,
    checks: checkRows,
    used_skills_path: usedSkillsPath,
    used_skills: arrayOfStrings(usage.used_skills),
    used_target_skill: usedTarget,
    expected_trigger: expectedTrigger,
    trigger_passed: triggerPassed,
    expected_behavior: arrayOfStrings(test.expected_behavior),
    can_improve: typeof parsed.can_improve === "boolean" ? parsed.can_improve : score < 8.5,
    strengths: arrayOfStrings(parsed.strengths),
    weaknesses: valid ? arrayOfStrings(parsed.weaknesses) : [`Evaluation JSON could not be parsed: ${parseError}`],
    suggestions: arrayOfStrings(parsed.suggestions),
    violated_rules: arrayOfStrings(parsed.violated_rules),
    rubric_notes: arrayOfStrings(parsed.rubric_notes),
    valid,
    raw_eval_path: rawEvalPath,
    parse_error: parseError,
  };
  writeJson(normalizedPath, evaluation);
  return {
    test_id: evaluation.test_id,
    key,
    score: evaluation.score,
    can_improve: evaluation.can_improve,
    valid,
    evaluation_path: normalizedPath,
  };
}

function aggregateRound([statePath, roundRaw], env = process.env) {
  const state = stateFrom(statePath);
  const round = parseInteger(roundRaw, "round");
  let laneOutputs = [];
  try {
    const parsed = JSON.parse(env.EVALUATIONS || "[]");
    laneOutputs = Array.isArray(parsed) ? parsed : [];
  } catch {
    laneOutputs = [];
  }

  const full = laneOutputs.map((item) => readJson(item.evaluation_path, item));
  const train = full.filter((item) => item.split !== "holdout");
  const holdout = full.filter((item) => item.split === "holdout");
  const scores = full.map((item) => clampScore(item.score));
  const trainScores = train.map((item) => clampScore(item.score));
  const evaluationCount = scores.length;
  const avgScore = average(scores);
  const trainAvgScore = average(trainScores);
  const holdoutAvgScore = average(holdout.map((item) => clampScore(item.score)));
  const currentBestScore = trainScores.length ? Math.max(...trainScores) : evaluationCount ? Math.max(...scores) : 0;
  const previousBest = Number(state.best_score || 0);
  const bestScore = Math.max(previousBest, currentBestScore);
  const stagnationRounds = currentBestScore > previousBest ? 0 : Number(state.stagnation_rounds || 0) + 1;
  const improvementSet = train.length ? train : full;
  const weakest = improvementSet.reduce((min, item) => (clampScore(item.score) < clampScore(min.score) ? item : min), improvementSet[0] || {
    test_id: "none",
    score: 0,
  });
  const scoreByTest = Object.fromEntries(full.map((item) => [item.test_id || item.key, clampScore(item.score)]));
  const violationCount = full.reduce((sum, item) => sum + arrayOfStrings(item.violated_rules).length, 0);
  const checkPassRate = average(full.map((item) => item.check_pass_rate));
  const dimensions = dimensionAverages(full);
  const trainDimensions = dimensionAverages(improvementSet);
  const trigger = triggerMetrics(full);
  const isBaseline = round === 0;
  const baselineScore = isBaseline ? avgScore : Number(state.baseline_summary?.baseline_score || 0);
  const canImprove = evaluationCount === 0 || improvementSet.some((item) => item.can_improve !== false) || trainAvgScore < 8.5;
  const skillLineCount = lineCount(join(state.worktree_skill_dir, "SKILL.md"));
  const summaryPath = state.current_round?.summary_path ?? join(state.output_dir, `round-${round}-summary.json`);
  const improvementSummaryPath = state.current_round?.improvement_summary_path ?? join(state.output_dir, `round-${round}-improvement-summary.json`);
  const summary = {
    round,
    avg_score: avgScore,
    train_avg_score: trainAvgScore,
    holdout_avg_score: holdoutAvgScore,
    best_score: bestScore,
    current_best_score: currentBestScore,
    can_improve: canImprove,
    evaluation_count: evaluationCount,
    train_count: train.length,
    holdout_count: holdout.length,
    weakest_test: String(weakest.test_id || weakest.key || "none"),
    weakest_score: clampScore(weakest.score),
    weakest_dimension: weakestDimension(trainDimensions),
    stagnation_rounds: stagnationRounds,
    skill_line_count: skillLineCount,
    original_line_count: state.original_line_count,
    line_budget: state.line_budget,
    violation_count: violationCount,
    check_pass_rate: checkPassRate,
    trigger_metrics: trigger,
    dimension_scores: dimensions,
    train_dimension_scores: trainDimensions,
    baseline_score: baselineScore,
    baseline_delta: isBaseline ? 0 : round2(avgScore - baselineScore),
    baseline_summary_path: state.baseline_summary?.summary_path || "",
    score_by_test: scoreByTest,
    evaluations: full,
  };
  const improvementSummary = {
    round,
    focus: state.focus,
    train_avg_score: trainAvgScore,
    train_dimension_scores: trainDimensions,
    weakest_test: summary.weakest_test,
    weakest_score: summary.weakest_score,
    weakest_dimension: summary.weakest_dimension,
    check_failures: improvementSet.flatMap((item) => arrayOfObjects(item.checks).filter((check) => !check.passed).map((check) => ({
      test_id: item.test_id,
      type: check.type,
      text: check.text,
      evidence: check.evidence,
    }))),
    evaluations: improvementSet,
  };
  writeJson(summaryPath, summary);
  writeJson(improvementSummaryPath, improvementSummary);
  if (isBaseline) {
    state.baseline_summary = { ...summary, baseline_score: avgScore, baseline_count: evaluationCount, summary_path: summaryPath };
  }
  state.best_score = bestScore;
  state.stagnation_rounds = stagnationRounds;
  state.last_aggregate = { ...summary, summary_path: summaryPath, improvement_summary_path: improvementSummaryPath };
  saveState(state);
  append(
    state.report_path,
    [
      `## Round ${round}${isBaseline ? " (baseline)" : ""}`,
      "",
      `- Average score: ${avgScore}`,
      `- Train average score: ${trainAvgScore}`,
      `- Holdout average score: ${holdout.length ? holdoutAvgScore : "n/a"}`,
      `- Current best: ${currentBestScore}`,
      `- Best so far: ${bestScore}`,
    `- Check pass rate: ${checkPassRate}`,
      `- Trigger accuracy: ${trigger.accuracy}`,
      `- Trigger precision: ${trigger.precision}`,
      `- Trigger recall: ${trigger.recall}`,
      `- Weakest dimension: ${summary.weakest_dimension}`,
      `- Baseline delta: ${summary.baseline_delta}`,
      `- Stagnation rounds: ${stagnationRounds}`,
      `- Weakest test: ${summary.weakest_test} (${summary.weakest_score})`,
      `- Evaluation summary: ${summaryPath}`,
      `- Improvement summary: ${improvementSummaryPath}`,
      "",
    ].join("\n"),
  );
  return {
    round,
    avg_score: avgScore,
    train_avg_score: trainAvgScore,
    holdout_avg_score: holdoutAvgScore,
    best_score: bestScore,
    current_best_score: currentBestScore,
    can_improve: canImprove,
    evaluation_count: evaluationCount,
    train_count: train.length,
    holdout_count: holdout.length,
    weakest_test: summary.weakest_test,
    weakest_score: summary.weakest_score,
    weakest_dimension: summary.weakest_dimension,
    stagnation_rounds: stagnationRounds,
    skill_line_count: skillLineCount,
    original_line_count: state.original_line_count,
    line_budget: state.line_budget,
    violation_count: violationCount,
    check_pass_rate: checkPassRate,
    summary_path: summaryPath,
    improvement_summary_path: improvementSummaryPath,
  };
}

function recordEvaluated([statePath]) {
  const state = stateFrom(statePath);
  const round = Number(state.current_round?.round ?? 0);
  const aggregate = state.last_aggregate || {};
  const trainScore = Number(aggregate.train_avg_score ?? aggregate.avg_score ?? 0);
  const sha = git(state.worktree_path, ["rev-parse", "HEAD"]);
  // Clear the prior round's commit marker so a skipped improve (terminal round)
  // does not leave a stale candidate on this round's record.
  state.last_commit = { round, committed: false, sha: "" };
  if (round === 0) {
    state.best_evaluated_score = trainScore;
    state.best_evaluated_sha = sha;
    state.last_evaluated_sha = sha;
    saveState(state);
    return { round, baseline: true, evaluated_sha: sha, best_evaluated_sha: sha, best_evaluated_score: trainScore };
  }
  state.evaluated = [...(state.evaluated || []), { round, sha, train_score: trainScore }];
  state.last_evaluated_sha = sha;
  if (trainScore > Number(state.best_evaluated_score ?? 0)) {
    state.best_evaluated_sha = sha;
    state.best_evaluated_score = trainScore;
  }
  saveState(state);
  return {
    round,
    baseline: false,
    evaluated_sha: sha,
    best_evaluated_sha: state.best_evaluated_sha,
    best_evaluated_score: Number(state.best_evaluated_score ?? 0),
  };
}

function commitCandidate([statePath]) {
  const state = stateFrom(statePath);
  const round = Number(state.current_round?.round ?? 0);
  git(state.worktree_path, ["add", "--", state.skill_rel_path]);
  const staged = git(state.worktree_path, ["diff", "--cached", "--", state.skill_rel_path]);
  if (!staged) {
    state.last_commit = { round, committed: false, sha: "" };
    saveState(state);
    return { round, committed: false, sha: "" };
  }
  git(state.worktree_path, [...GIT_IDENTITY, "commit", "-m", `skill optimizer candidate round ${round + 1}`]);
  const sha = git(state.worktree_path, ["rev-parse", "HEAD"]);
  state.candidate_shas = [...(state.candidate_shas || []), sha];
  state.last_commit = { round, committed: true, sha };
  saveState(state);
  return { round, committed: true, sha };
}

function finishRound([statePath, roundRaw]) {
  const state = stateFrom(statePath);
  const round = parseInteger(roundRaw, "round");
  const aggregate = state.last_aggregate || {};
  const manifest = readJson(state.current_round?.improvement_manifest_path || "", {});
  const commit = state.last_commit || {};
  const changed = Boolean(commit.committed);
  const highQuality =
    Number(aggregate.train_avg_score || aggregate.avg_score || 0) >= 8.5 &&
    Number(aggregate.stagnation_rounds || 0) >= 2 &&
    Number(aggregate.weakest_score || 0) >= 7 &&
    Number(aggregate.violation_count || 0) === 0;

  let done = false;
  let stopReason = "continue";
  if (round >= state.max_iterations) {
    done = true;
    stopReason = "max_iterations";
  } else if (!changed) {
    done = true;
    stopReason = "improver_no_change";
  } else if (round >= 1 && highQuality) {
    done = true;
    stopReason = "quality_converged";
  } else if (round >= 1 && (aggregate.can_improve === false || manifest.can_improve === false)) {
    done = true;
    stopReason = "no_improvement_needed";
  }

  state.stop_reason = stopReason;
  state.rounds = (state.rounds || []).filter((item) => Number(item.round) !== round);
  const roundRecord = {
    round,
    baseline: round === 0,
    evaluated_sha: state.last_evaluated_sha || state.baseline_sha,
    candidate_sha: changed ? commit.sha : "",
    avg_score: Number(aggregate.avg_score || 0),
    train_avg_score: Number(aggregate.train_avg_score || 0),
    holdout_avg_score: Number(aggregate.holdout_avg_score || 0),
    best_score: Number(aggregate.best_score || 0),
    stagnation_rounds: Number(aggregate.stagnation_rounds || 0),
    weakest_dimension: aggregate.weakest_dimension || "none",
    check_pass_rate: Number(aggregate.check_pass_rate || 0),
    summary_path: aggregate.summary_path || "",
    improvement_summary_path: aggregate.improvement_summary_path || "",
    manifest_path: state.current_round?.improvement_manifest_path || "",
    stop_reason: stopReason,
    done,
    changed,
  };
  state.rounds.push(roundRecord);
  saveState(state);
  append(
    state.report_path,
    [
      `- Evaluated: ${roundRecord.evaluated_sha}${round === 0 ? " (baseline)" : ""}`,
      `- New candidate: ${changed ? commit.sha : "none"}`,
      `- Stop reason: ${stopReason}`,
      "",
    ].join("\n"),
  );

  return {
    round,
    done,
    can_improve: !done && aggregate.can_improve !== false,
    skill_dir: state.worktree_skill_dir,
    avg_score: Number(aggregate.avg_score || 0),
    train_avg_score: Number(aggregate.train_avg_score || 0),
    holdout_avg_score: Number(aggregate.holdout_avg_score || 0),
    best_score: Number(aggregate.best_score || 0),
    stagnation_rounds: Number(aggregate.stagnation_rounds || 0),
    stop_reason: stopReason,
    summary_path: aggregate.summary_path || "",
    report_path: state.report_path,
  };
}

function finalize([statePath]) {
  const state = stateFrom(statePath);
  const targetSha = state.best_evaluated_sha || state.baseline_sha;
  rmSync(state.worktree_skill_dir, { recursive: true, force: true });
  git(state.worktree_path, ["checkout", "--force", targetSha, "--", state.skill_rel_path]);
  writeFinalPatch(state, targetSha);
  const rounds = state.rounds || [];
  const completedRounds = (state.evaluated || []).length;
  const result = {
    skill_dir: state.worktree_skill_dir,
    final_score: Number(state.best_evaluated_score ?? 0),
    best_score: Number(state.best_score || 0),
    rounds_completed: completedRounds,
    report_path: state.report_path,
    state_path: state.state_path,
    output_dir: state.output_dir,
    worktree_path: state.worktree_path,
    patch_path: state.patch_path,
    stop_reason: state.stop_reason || "not-started",
  };
  append(
    state.report_path,
    [
      "## Final State",
      "",
      `- Shipped candidate: ${targetSha}${targetSha === state.baseline_sha ? " (baseline)" : ""}`,
      `- Skill dir: ${result.skill_dir}`,
      `- Final score: ${result.final_score}`,
      `- Best score: ${result.best_score}`,
      `- Optimized candidates evaluated: ${result.rounds_completed}`,
      `- Stop reason: ${result.stop_reason}`,
      `- Worktree: ${result.worktree_path}`,
      `- Patch: ${result.patch_path}`,
      "",
    ].join("\n"),
  );
  return result;
}

export const commands = {
  init,
  "normalize-tests": normalizeTests,
  "prepare-round": prepareRound,
  "collect-case": collectCase,
  "collect-trigger-report": collectTriggerReport,
  "run-checks": runChecks,
  "aggregate-trigger-eval": aggregateTriggerEval,
  "normalize-eval": normalizeEval,
  "aggregate-round": aggregateRound,
  "record-evaluated": recordEvaluated,
  "commit-candidate": commitCandidate,
  "finish-round": finishRound,
  finalize,
};

function main() {
  const [command, ...args] = process.argv.slice(2);
  try {
    if (!commands[command]) throw new Error(`Unknown command: ${command || "(missing)"}`);
    process.stdout.write(`${JSON.stringify(commands[command](args))}\n`);
  } catch (error) {
    process.stderr.write(`${basename(process.argv[1])}: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
