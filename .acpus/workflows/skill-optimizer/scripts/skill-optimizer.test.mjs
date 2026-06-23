import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { commands } from "./skill-optimizer.mjs";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "skill-optimizer-test-"));
  git(root, ["init"]);
  git(root, ["config", "user.name", "Test"]);
  git(root, ["config", "user.email", "test@example.invalid"]);
  writeFileSync(join(root, "README.md"), "fixture\n");
  git(root, ["add", "README.md"]);
  git(root, ["commit", "-m", "initial"]);
  const skill = join(root, ".agents", "skills", "skill");
  const output = join(root, ".acpus", "output");
  return { root, skill, output };
}

function makeSkill(dir, lines = 6) {
  writeFileSync(
    join(dir, "SKILL.md"),
    [
      "---",
      "name: fixture-skill",
      "description: Fixture skill for tests",
      "---",
      "",
      ...Array.from({ length: lines }, (_, i) => `line ${i + 1}`),
    ].join("\n"),
  );
}

function cleanup(root) {
  rmSync(root, { recursive: true, force: true });
}

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

test("init validates bounds and computes line budget", () => {
  const { root, skill, output } = fixture();
  try {
    commands.init([skill, output, "run-a", "quality", "1", "1"]);
    assert.fail("expected missing skill to fail");
  } catch (error) {
    assert.match(error.message, /SKILL\.md/);
  }
  try {
    mkdirp(skill);
    makeSkill(skill, 10);
    assert.throws(() => commands.init([skill, output, "run-b", "quality", "51", "1"]), /max_iterations/);
    const result = commands.init([skill, output, "run-c", "quality", "3", "2"]);
    assert.equal(result.original_line_count, 15);
    assert.equal(result.line_budget, Math.min(Math.ceil(15 + 15 * Math.log(16)), 500));
    assert.equal(result.max_iterations, 3);
    assert.equal(result.skill_name, "fixture-skill");
    assert.match(result.skill_rel_path, /^\.agents\/skills\/skill$/);
    assert.ok(existsSync(join(result.skill_dir, "SKILL.md")));
    assert.ok(existsSync(join(result.worktree_path, "README.md")));
    assert.ok(existsSync(join(result.worktree_path, ".agents", "skills", "skill", "SKILL.md")));
  } finally {
    cleanup(root);
  }
});

test("init rejects skills outside supported skill roots", () => {
  const { root, output } = fixture();
  const skill = join(root, "other-skill");
  try {
    mkdirp(skill);
    makeSkill(skill);
    assert.throws(() => commands.init([skill, output, "run", "quality", "1", "1"]), /\.agents\/skills or \.claude\/skills/);
  } finally {
    cleanup(root);
  }
});

test("normalize-tests produces safe unique ids and required trigger flags", () => {
  const { root, skill, output } = fixture();
  try {
    mkdirp(skill);
    makeSkill(skill);
    const init = commands.init([skill, output, "run", "recall", "3", "3"]);
    const result = commands["normalize-tests"]([init.state_path], {
      TEST_CASES: JSON.stringify([
        { id: "same/id", prompt: "one" },
        { id: "same id", prompt: "two", should_trigger: false },
      ]),
    });
    assert.equal(result.test_count, 2);
    assert.deepEqual(result.test_cases.map((item) => item.should_trigger), [true, false]);
    assert.equal(new Set(result.test_cases.map((item) => item.key)).size, 2);
    assert.ok(result.test_cases.every((item) => /^[A-Za-z0-9_-]+$/.test(item.key)));
  } finally {
    cleanup(root);
  }
});

test("prepare-round emits clean recall prompts and minimal non-recall skill prompts", () => {
  const { root, skill, output } = fixture();
  try {
    mkdirp(skill);
    makeSkill(skill);
    const recall = commands.init([skill, output, "run-recall", "recall", "1", "1"]);
    commands["normalize-tests"]([recall.state_path], { TEST_CASES: JSON.stringify([{ id: "a", prompt: "please hand this off" }]) });
    const recallJobs = commands["prepare-round"]([recall.state_path, "0"]).case_jobs;
    assert.equal(recallJobs.length, 3);
    assert.equal(recallJobs[0].execution_prompt, "please hand this off");
    assert.doesNotMatch(recallJobs[0].execution_prompt, /Skill path|evaluation task|Save primary output|Test id|Should trigger|Test prompt/i);

    const quality = commands.init([skill, output, "run-quality-prompt", "quality", "1", "1"]);
    commands["normalize-tests"]([quality.state_path], {
      TEST_CASES: JSON.stringify([{ id: "a", prompt: "please hand this off", files: ["docs/input.md"] }]),
    });
    const qualityJob = commands["prepare-round"]([quality.state_path, "0"]).case_jobs[0];
    assert.match(qualityJob.execution_prompt, /- Skill path: \.agents\/skills\/skill/);
    assert.match(qualityJob.execution_prompt, /- Task: please hand this off/);
    assert.match(qualityJob.execution_prompt, /- Input files: docs\/input\.md/);
    assert.doesNotMatch(qualityJob.execution_prompt, /Test id|Should trigger|Test prompt/i);

    const negative = commands.init([skill, output, "run-quality-negative-prompt", "quality", "1", "1"]);
    commands["normalize-tests"]([negative.state_path], {
      TEST_CASES: JSON.stringify([{ id: "a", prompt: "create a normal issue", should_trigger: false }]),
    });
    const negativeJob = commands["prepare-round"]([negative.state_path, "0"]).case_jobs[0];
    assert.match(negativeJob.execution_prompt, /This is an evaluation task/);
    assert.match(negativeJob.execution_prompt, /- Task: create a normal issue/);
    assert.match(negativeJob.execution_prompt, /- Save primary output to:/);
    assert.doesNotMatch(negativeJob.execution_prompt, /Skill path|\.agents\/skills\/skill|Test id|Should trigger|Test prompt/i);
  } finally {
    cleanup(root);
  }
});

test("normalize-tests prefers eval_cases_path and assigns holdout for larger suites", () => {
  const { root, skill, output } = fixture();
  try {
    mkdirp(skill);
    makeSkill(skill);
    const evalsPath = join(root, "evals.json");
    writeFileSync(evalsPath, JSON.stringify({
      evals: [
        { id: "one", prompt: "one", expected_output: "writes ok", checks: [{ type: "result_exists" }] },
        { id: "two", prompt: "two" },
        { id: "three", prompt: "three" },
        { id: "four", prompt: "four", should_trigger: false },
      ],
    }));
    const init = commands.init([skill, output, "run", "quality", "3", "1", evalsPath]);
    const result = commands["normalize-tests"]([init.state_path], {
      TEST_CASES: JSON.stringify([{ id: "ignored", prompt: "ignored" }]),
    });
    assert.equal(result.test_count, 4);
    assert.deepEqual(result.test_cases.map((item) => item.id), ["one", "two", "three", "four"]);
    assert.equal(result.test_cases.filter((item) => item.split === "holdout").length, 2);
    const state = JSON.parse(readFileSync(init.state_path, "utf8"));
    assert.equal(state.test_cases[0].expected_behavior[0], "writes ok");
    assert.equal(state.test_cases[0].checks[0].type, "result_exists");
  } finally {
    cleanup(root);
  }
});

test("run-checks evaluates supported deterministic check types", () => {
  const { root, skill, output } = fixture();
  try {
    mkdirp(skill);
    makeSkill(skill);
    const init = commands.init([skill, output, "run", "quality", "3", "1"]);
    commands["normalize-tests"]([init.state_path], {
      TEST_CASES: JSON.stringify([{
        id: "checks",
        prompt: "prompt",
        checks: [
          { type: "result_exists" },
          { type: "result_contains_text", value: "\"ok\":true" },
          { type: "result_not_contains_text", value: "bad" },
          { type: "file_exists", path: "extra.txt" },
          { type: "json_field_equals", field: "ok", expected: true },
          { type: "max_tool_calls", value: 3 },
        ],
      }]),
    });
    const round = commands["prepare-round"]([init.state_path, "0"]);
    const job = round.case_jobs[0];
    writeFileSync(job.result_path, "{\"ok\":true}");
    writeFileSync(join(dirnameForTest(job.result_path), "extra.txt"), "x");
    const result = commands["run-checks"]([init.state_path, "0", job.key, job.result_path, job.checks_path, "3"]);
    assert.equal(result.checks_total, 6);
    assert.equal(result.checks_passed, 6);
    assert.equal(result.check_pass_rate, 1);
  } finally {
    cleanup(root);
  }
});

test("aggregate-round handles empty evaluations without dynamic output fields", () => {
  const { root, skill, output } = fixture();
  try {
    mkdirp(skill);
    makeSkill(skill);
    const init = commands.init([skill, output, "run", "quality", "3", "1"]);
    commands["normalize-tests"]([init.state_path], { TEST_CASES: "[]" });
    commands["prepare-round"]([init.state_path, "0"]);
    const result = commands["aggregate-round"]([init.state_path, "0"], { EVALUATIONS: "[]" });
    assert.equal(result.avg_score, 0);
    assert.equal(result.evaluation_count, 0);
    assert.equal("score_by_test" in result, false);
    const summary = JSON.parse(readFileSync(result.summary_path, "utf8"));
    assert.deepEqual(summary.score_by_test, {});
  } finally {
    cleanup(root);
  }
});

test("normalize-eval degrades invalid JSON into a valid low-score record", () => {
  const { root, skill, output } = fixture();
  try {
    mkdirp(skill);
    makeSkill(skill);
    const init = commands.init([skill, output, "run", "quality", "3", "1"]);
    const tests = commands["normalize-tests"]([init.state_path], {
      TEST_CASES: JSON.stringify([{ id: "a", prompt: "prompt" }]),
    });
    const round = commands["prepare-round"]([init.state_path, "0"]);
    const job = round.case_jobs[0];
    writeFileSync(job.raw_eval_path, "not json");
    writeFileSync(job.checks_path, JSON.stringify({ checks: [], check_pass_rate: 1 }));
    writeFileSync(job.used_skills_path, JSON.stringify({ used_skills: [], used_target_skill: false }));
    const result = commands["normalize-eval"]([init.state_path, "0", tests.test_cases[0].key, job.raw_eval_path, job.normalized_eval_path, job.checks_path, job.used_skills_path, "missing-run", "0"]);
    assert.equal(result.valid, false);
    assert.equal(result.score, 0);
    assert.ok(existsSync(result.evaluation_path));
  } finally {
    cleanup(root);
  }
});

test("collect-trigger-report treats self-reported target skill as a trigger", () => {
  const { root, skill, output } = fixture();
  try {
    mkdirp(skill);
    makeSkill(skill);
    const init = commands.init([skill, output, "run-report", "recall", "1", "1", "", "0.5", "1"]);
    commands["normalize-tests"]([init.state_path], {
      TEST_CASES: JSON.stringify([{ id: "a", prompt: "prompt", should_trigger: true }]),
    });
    const job = commands["prepare-round"]([init.state_path, "0"]).case_jobs[0];
    const result = commands["collect-trigger-report"]([
      init.state_path,
      job.test_key,
      job.key,
      job.trigger_result_path,
    ], { USED_SKILLS: JSON.stringify([".agents/skills/skill"]), REASON: "the request matched the skill description" });
    assert.equal(result.triggered, true);
    assert.equal(result.used_target_skill, true);
    const record = JSON.parse(readFileSync(result.trigger_result_path, "utf8"));
    assert.deepEqual(record.used_skills, [".agents/skills/skill"]);
    assert.equal(record.reason, "the request matched the skill description");
  } finally {
    cleanup(root);
  }
});

test("collect-trigger-report does not trigger when only other skills are reported", () => {
  const { root, skill, output } = fixture();
  try {
    mkdirp(skill);
    makeSkill(skill);
    const init = commands.init([skill, output, "run-report-miss", "recall", "1", "1", "", "0.5", "1"]);
    commands["normalize-tests"]([init.state_path], {
      TEST_CASES: JSON.stringify([{ id: "a", prompt: "prompt", should_trigger: false }]),
    });
    const job = commands["prepare-round"]([init.state_path, "0"]).case_jobs[0];
    const result = commands["collect-trigger-report"]([
      init.state_path,
      job.test_key,
      job.key,
      job.trigger_result_path,
    ], { USED_SKILLS: JSON.stringify(["some-other-skill"]), REASON: "used an unrelated skill" });
    assert.equal(result.triggered, false);
    assert.equal(result.used_target_skill, false);
  } finally {
    cleanup(root);
  }
});

test("collect-trigger-report treats an empty report as no trigger", () => {
  const { root, skill, output } = fixture();
  try {
    mkdirp(skill);
    makeSkill(skill);
    const init = commands.init([skill, output, "run-report-empty", "recall", "1", "1", "", "0.5", "1"]);
    commands["normalize-tests"]([init.state_path], {
      TEST_CASES: JSON.stringify([{ id: "a", prompt: "prompt", should_trigger: true }]),
    });
    const job = commands["prepare-round"]([init.state_path, "0"]).case_jobs[0];
    const result = commands["collect-trigger-report"]([
      init.state_path,
      job.test_key,
      job.key,
      job.trigger_result_path,
    ], { USED_SKILLS: "[]", REASON: "" });
    assert.equal(result.triggered, false);
    assert.equal(result.used_target_skill, false);
  } finally {
    cleanup(root);
  }
});

test("aggregate-trigger-eval computes trigger rates and false positives", () => {
  const { root, skill, output } = fixture();
  try {
    mkdirp(skill);
    makeSkill(skill);
    const init = commands.init([skill, output, "run-trigger-aggregate", "recall", "1", "2", "", "0.5", "3"]);
    commands["normalize-tests"]([init.state_path], {
      TEST_CASES: JSON.stringify([
        { id: "pos", prompt: "handoff this complex session", should_trigger: true },
        { id: "neg", prompt: "summarize this finished PR without handoff", should_trigger: false },
      ]),
    });
    const jobs = commands["prepare-round"]([init.state_path, "0"]).case_jobs;
    assert.equal(jobs.length, 6);
    assert.deepEqual(jobs.map((job) => job.run_index), [1, 2, 3, 1, 2, 3]);
    assert.ok(jobs.every((job) => /-run-[123]$/.test(job.key)));
    const outputs = jobs.map((job) => {
      const triggered = job.run_index <= 2;
      writeFileSync(job.trigger_result_path, JSON.stringify({
        test_id: job.test_id,
        test_key: job.test_key,
        key: job.key,
        split: job.split,
        should_trigger: job.should_trigger,
        triggered,
      }));
      return { trigger_result_path: job.trigger_result_path };
    });
    const result = commands["aggregate-trigger-eval"]([init.state_path, "0"], {
      TRIGGER_RESULTS: JSON.stringify(outputs),
    });
    const summary = JSON.parse(readFileSync(result.summary_path, "utf8"));
    assert.equal(result.avg_score, 5);
    assert.deepEqual(summary.evaluations.map((item) => item.runs), [3, 3]);
    assert.deepEqual(summary.evaluations.map((item) => item.trigger_rate), [0.67, 0.67]);
    assert.equal(summary.trigger_metrics.false_positives, 1);
    assert.equal(summary.trigger_metrics.false_negatives, 0);
    assert.equal(summary.trigger_metrics.precision, 0.5);
    assert.equal(summary.trigger_metrics.recall, 1);
  } finally {
    cleanup(root);
  }
});

test("aggregate-trigger-eval surfaces self-reported reasons for the improver", () => {
  const { root, skill, output } = fixture();
  try {
    mkdirp(skill);
    makeSkill(skill);
    const init = commands.init([skill, output, "run-trigger-reasons", "recall", "1", "1", "", "0.5", "1"]);
    commands["normalize-tests"]([init.state_path], {
      TEST_CASES: JSON.stringify([{ id: "pos", prompt: "handoff this complex session", should_trigger: true }]),
    });
    const jobs = commands["prepare-round"]([init.state_path, "0"]).case_jobs;
    const outputs = jobs.map((job) => {
      writeFileSync(job.trigger_result_path, JSON.stringify({
        test_id: job.test_id,
        test_key: job.test_key,
        key: job.key,
        split: job.split,
        should_trigger: job.should_trigger,
        triggered: false,
        reason: "description did not mention session handoffs",
      }));
      return { trigger_result_path: job.trigger_result_path };
    });
    const result = commands["aggregate-trigger-eval"]([init.state_path, "0"], {
      TRIGGER_RESULTS: JSON.stringify(outputs),
    });
    const summary = JSON.parse(readFileSync(result.summary_path, "utf8"));
    const row = summary.evaluations.find((item) => item.test_id === "pos");
    assert.equal(row.label, "false_negative");
    assert.deepEqual(row.reasons, ["description did not mention session handoffs"]);
  } finally {
    cleanup(root);
  }
});

test("normalize-eval computes different weighted scores by focus", () => {
  const { root, skill, output } = fixture();
  try {
    mkdirp(skill);
    makeSkill(skill);
    const raw = JSON.stringify({
      test_id: "a",
      correctness_score: 10,
      process_score: 10,
      compliance_score: 10,
      efficiency_score: 0,
      triggering_score: 10,
      can_improve: true,
      strengths: [],
      weaknesses: [],
      suggestions: [],
      violated_rules: [],
    });
    const quality = normalizeScoreForFocus(skill, output, "quality", "run-quality", raw);
    const speed = normalizeScoreForFocus(skill, output, "speed", "run-speed", raw);
    assert.ok(quality > speed);
  } finally {
    cleanup(root);
  }
});

test("finish-round records baseline at round 0 without creating an evaluated candidate", () => {
  const { root, skill, output } = fixture();
  try {
    mkdirp(skill);
    makeSkill(skill);
    const init = commands.init([skill, output, "run", "quality", "3", "1"]);
    commands["normalize-tests"]([init.state_path], {
      TEST_CASES: JSON.stringify([{ id: "a", prompt: "prompt", checks: [{ type: "result_exists" }] }]),
    });
    commands["prepare-round"]([init.state_path, "0"]);
    const aggregate = commands["aggregate-round"]([init.state_path, "0"], {
      EVALUATIONS: JSON.stringify([{ test_id: "a", key: "0-a", score: 6, can_improve: true, valid: true, evaluation_path: "missing" }]),
    });
    assert.equal(aggregate.baseline_delta ?? 0, 0);
    const recorded = commands["record-evaluated"]([init.state_path]);
    assert.equal(recorded.baseline, true);
    const state = JSON.parse(readFileSync(init.state_path, "utf8"));
    assert.deepEqual(state.evaluated, []);
    assert.equal(state.best_evaluated_sha, state.baseline_sha);
    assert.ok(state.baseline_summary);
    assert.equal(state.baseline_summary.baseline_score, 6);
  } finally {
    cleanup(root);
  }
});

test("no-change after baseline exits without pretending a candidate was evaluated", () => {
  const { root, skill, output } = fixture();
  try {
    mkdirp(skill);
    makeSkill(skill);
    const init = commands.init([skill, output, "run", "quality", "3", "1"]);
    commands["normalize-tests"]([init.state_path], { TEST_CASES: JSON.stringify([{ id: "a", prompt: "prompt" }]) });
    commands["prepare-round"]([init.state_path, "0"]);
    commands["aggregate-round"]([init.state_path, "0"], {
      EVALUATIONS: JSON.stringify([{ test_id: "a", key: "0-a", score: 7, can_improve: true, valid: true, evaluation_path: "missing" }]),
    });
    commands["record-evaluated"]([init.state_path]);
    const commit = commands["commit-candidate"]([init.state_path]);
    assert.equal(commit.committed, false);
    const result = commands["finish-round"]([init.state_path, "0"]);
    assert.equal(result.done, true);
    assert.equal(result.stop_reason, "improver_no_change");
    const final = commands.finalize([init.state_path]);
    assert.equal(final.rounds_completed, 0);
    assert.equal(readFileSync(final.patch_path, "utf8"), "");
  } finally {
    cleanup(root);
  }
});

test("finalize ships the evaluated candidate, never an untracked snapshot", () => {
  const { root, skill, output } = fixture();
  try {
    mkdirp(skill);
    makeSkill(skill);
    writeFileSync(join(skill, "untracked-reference.md"), "copied snapshot\n");
    const init = commands.init([skill, output, "run-patch", "quality", "2", "1"]);
    commands["normalize-tests"]([init.state_path], { TEST_CASES: JSON.stringify([{ id: "a", prompt: "prompt" }]) });
    driveRound(init.state_path, init.skill_dir, 0, { score: 6, edit: "new optimized line" });
    driveRound(init.state_path, init.skill_dir, 1, { score: 8, edit: "second optimized line" });
    const final = commands.finalize([init.state_path]);
    const patch = readFileSync(final.patch_path, "utf8");
    assert.match(patch, /new optimized line/);
    assert.match(patch, /\.agents\/skills\/skill\/SKILL\.md/);
    assert.doesNotMatch(patch, /untracked-reference/);
  } finally {
    cleanup(root);
  }
});

test("max_iterations=1 evaluates exactly one optimized candidate after baseline", () => {
  const { root, skill, output } = fixture();
  try {
    mkdirp(skill);
    makeSkill(skill);
    const init = commands.init([skill, output, "run-one", "quality", "1", "1"]);
    commands["normalize-tests"]([init.state_path], { TEST_CASES: JSON.stringify([{ id: "a", prompt: "prompt" }]) });
    const round0 = driveRound(init.state_path, init.skill_dir, 0, { score: 6, edit: "candidate v1" });
    assert.equal(round0.done, false);
    const round1 = driveRound(init.state_path, init.skill_dir, 1, { score: 8, edit: "candidate v2 pending" });
    assert.equal(round1.done, true);
    assert.equal(round1.stop_reason, "max_iterations");
    const state = JSON.parse(readFileSync(init.state_path, "utf8"));
    assert.equal(state.evaluated.length, 1);
    const final = commands.finalize([init.state_path]);
    assert.equal(final.rounds_completed, 1);
    const patch = readFileSync(final.patch_path, "utf8");
    assert.match(patch, /candidate v1/);
    assert.doesNotMatch(patch, /candidate v2 pending/);
  } finally {
    cleanup(root);
  }
});

test("finalize selects the best evaluated candidate, not the last", () => {
  const { root, skill, output } = fixture();
  try {
    mkdirp(skill);
    makeSkill(skill);
    const init = commands.init([skill, output, "run-best", "quality", "3", "1"]);
    commands["normalize-tests"]([init.state_path], { TEST_CASES: JSON.stringify([{ id: "a", prompt: "prompt" }]) });
    driveRound(init.state_path, init.skill_dir, 0, { score: 5, edit: "candidate v1 strong" });
    driveRound(init.state_path, init.skill_dir, 1, { score: 9, edit: "candidate v2 weak" });
    driveRound(init.state_path, init.skill_dir, 2, { score: 4, edit: "candidate v3 pending" });
    const final = commands.finalize([init.state_path]);
    const patch = readFileSync(final.patch_path, "utf8");
    assert.match(patch, /candidate v1 strong/);
    assert.doesNotMatch(patch, /candidate v2 weak/);
    assert.doesNotMatch(patch, /candidate v3 pending/);
  } finally {
    cleanup(root);
  }
});

function mkdirp(path) {
  mkdirSync(path, { recursive: true });
}

function driveRound(statePath, skillDir, round, { score, edit } = {}) {
  commands["prepare-round"]([statePath, String(round)]);
  commands["aggregate-round"]([statePath, String(round)], {
    EVALUATIONS: JSON.stringify([{ test_id: "a", key: "0-a", score, can_improve: true, valid: true, evaluation_path: "missing" }]),
  });
  commands["record-evaluated"]([statePath]);
  if (edit) {
    const skillFile = join(skillDir, "SKILL.md");
    writeFileSync(skillFile, `${readFileSync(skillFile, "utf8")}\n${edit}\n`);
  }
  commands["commit-candidate"]([statePath]);
  return commands["finish-round"]([statePath, String(round)]);
}

function dirnameForTest(path) {
  return path.slice(0, path.lastIndexOf("/"));
}

function normalizeScoreForFocus(skill, output, focus, runId, raw) {
  const init = commands.init([skill, output, runId, focus, "3", "1"]);
  const tests = commands["normalize-tests"]([init.state_path], {
    TEST_CASES: JSON.stringify([{ id: "a", prompt: "prompt" }]),
  });
  const round = commands["prepare-round"]([init.state_path, "0"]);
  const job = round.case_jobs[0];
  writeFileSync(job.raw_eval_path, raw);
  writeFileSync(job.checks_path, JSON.stringify({ checks: [], check_pass_rate: 1 }));
  writeFileSync(job.used_skills_path, JSON.stringify({ used_skills: [], used_target_skill: false }));
  return commands["normalize-eval"]([init.state_path, "0", tests.test_cases[0].key, job.raw_eval_path, job.normalized_eval_path, job.checks_path, job.used_skills_path, "missing-run", "0"]).score;
}

function dimensionPayload(score) {
  return {
    test_id: "a",
    correctness_score: score,
    process_score: score,
    compliance_score: score,
    efficiency_score: score,
    triggering_score: score,
    can_improve: true,
    strengths: [],
    weaknesses: [],
    suggestions: [],
    violated_rules: [],
  };
}
