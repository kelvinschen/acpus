/*
 * Pattern: Evaluate workflow authoring across isolated workspaces and collect same-session retrospectives.
 * Nodes: agent, task, parallel, fanout
 */
import { defineWorkflow, z } from "acpus/core";
import { lift, md, template } from "acpus/expression";
import { REQUIREMENTS } from "./requirements.js";
import { prepareEvaluationWorkspace } from "./tasks.js";

const TRIALS = [1, 2, 3] as const;
const AUTHORING_GUIDANCE = `
You are participating in an Acpus authoring evaluation.

Read AGENTS.md, CLAUDE.md, and the Acpus skill installed in this workspace before editing. Starting only from the product request below, design and implement a TypeScript Acpus workflow in this workspace. Make your own authoring decisions; the request intentionally gives no node, schema, or control-flow design.

Work only inside the current workspace. Do not inspect parent or sibling directories, use the internet, or modify the copied skills. You may run acpus workflow check and fix its diagnostics, but never run the authored workflow. Run at most one workflow check command in each shell tool call; do not chain checks.

Focus this turn only on authoring. Do not write a pitfalls retrospective or check-history report yet. Return a concise completion report when finished.
`;
const RETROSPECTIVE_GUIDANCE = `
This is a separate retrospective turn for the authoring work you just completed. Do not edit files, run commands, or run another check now. Use only the preceding session and your memory of the work; do not invent events.

Return Markdown with exactly these sections:

## Outcome
State whether the workflow ended check-passed, check-failed, or not-checked, and list the files you created.

## Check count
Give the exact number of acpus workflow check invocations from the authoring turn.

## Check problems
List every check invocation in order. For each, record the command, pass/fail result, diagnostics or problems encountered, and what you changed afterward. Write "none" when a passing check had no problems.

## Pitfalls
List only concrete friction you encountered. For each pitfall give: area (authoring API, skill documentation, compiler/type diagnostics, CLI/check behavior, runtime contract, evaluation setup, or other), severity, evidence from this session, and why it mattered.

## Improvement directions
For each pitfall, suggest the smallest useful improvement to Acpus authoring, skill documentation, runtime behavior, CLI design, or diagnostics. Separate observed facts from inference and say when you are uncertain.
`;

export default defineWorkflow({
  name: "authoring-evaluation",
  description: "Run 90 isolated two-turn authoring sessions and record Acpus authoring pitfalls.",
  inputSchema: z.object({
    workspaceRoot: z.string().describe(
      "Absolute root physically outside the workflow workspace and skill source, used for per-run evaluation workspaces.",
    ),
    skillSourcePath: z.string().describe("Acpus skill directory copied into both agent skill locations in every workspace."),
    maxConcurrentRequirements: z.number().int().positive().default(1).describe(
      "Number of requirements evaluated concurrently; each requirement can run nine sessions in parallel.",
    ),
  }),
  agents: {
    pi: { use: "pi", trace: true },
    claude: { use: "claude", trace: true },
    traex: { use: "traex", trace: true },
  },
}).build(({ input, agents, meta, step }) => {
  const evaluations = step("evaluate_requirements").fanout({
    over: REQUIREMENTS,
    maxConcurrency: input.maxConcurrentRequirements,
    do({ item: requirement }) {
      const agentRuns = step("agent_runs").parallel({
        maxConcurrency: 3,
        branches: {
          pi() {
            const trials = step("pi_trials").fanout({
              over: TRIALS,
              maxConcurrency: 3,
              do({ item: trial }) {
                const workspace = step("prepare_pi_workspace").task({
                  task: prepareEvaluationWorkspace,
                  input: {
                    workspaceRoot: input.workspaceRoot,
                    workspaceDir: meta.workspaceDir,
                    skillSourcePath: input.skillSourcePath,
                    runId: meta.runId,
                    requirementId: requirement.id,
                    agentKey: "pi",
                    trial,
                  },
                  cwd: meta.workspaceDir,
                  timeout: "5m",
                });
                const sessionKey = template`authoring-evaluation:${requirement.id}:pi:${trial}`;
                const authoring = step("pi_authoring").agent({
                  agent: agents.pi,
                  cwd: workspace.output.workspacePath,
                  sessionKey,
                  prompt: md`
                    ${AUTHORING_GUIDANCE}

                    Product request: ${requirement.title}

                    ${requirement.request}
                  `,
                  timeout: "45m",
                });
                const completed = lift(authoring.output, _output => "The previous authoring turn is complete.");
                const retrospective = step("pi_retrospective").agent({
                  agent: agents.pi,
                  cwd: workspace.output.workspacePath,
                  sessionKey,
                  prompt: md`${completed}\n\n${RETROSPECTIVE_GUIDANCE}`,
                  timeout: "15m",
                });
                return {
                  trial,
                  workspace: workspace.output,
                  authoringReport: authoring.output,
                  retrospective: retrospective.output,
                };
              },
            });
            return trials.output;
          },
          claude() {
            const trials = step("claude_trials").fanout({
              over: TRIALS,
              maxConcurrency: 3,
              do({ item: trial }) {
                const workspace = step("prepare_claude_workspace").task({
                  task: prepareEvaluationWorkspace,
                  input: {
                    workspaceRoot: input.workspaceRoot,
                    workspaceDir: meta.workspaceDir,
                    skillSourcePath: input.skillSourcePath,
                    runId: meta.runId,
                    requirementId: requirement.id,
                    agentKey: "claude",
                    trial,
                  },
                  cwd: meta.workspaceDir,
                  timeout: "5m",
                });
                const sessionKey = template`authoring-evaluation:${meta.runId}:${requirement.id}:claude:${trial}`;
                const authoring = step("claude_authoring").agent({
                  agent: agents.claude,
                  cwd: workspace.output.workspacePath,
                  sessionKey,
                  prompt: md`
                    ${AUTHORING_GUIDANCE}

                    Product request: ${requirement.title}

                    ${requirement.request}
                  `,
                  timeout: "45m",
                });
                const completed = lift(authoring.output, _output => "The previous authoring turn is complete.");
                const retrospective = step("claude_retrospective").agent({
                  agent: agents.claude,
                  cwd: workspace.output.workspacePath,
                  sessionKey,
                  prompt: md`${completed}\n\n${RETROSPECTIVE_GUIDANCE}`,
                  timeout: "15m",
                });
                return {
                  trial,
                  workspace: workspace.output,
                  authoringReport: authoring.output,
                  retrospective: retrospective.output,
                };
              },
            });
            return trials.output;
          },
          traex() {
            const trials = step("traex_trials").fanout({
              over: TRIALS,
              maxConcurrency: 3,
              do({ item: trial }) {
                const workspace = step("prepare_traex_workspace").task({
                  task: prepareEvaluationWorkspace,
                  input: {
                    workspaceRoot: input.workspaceRoot,
                    workspaceDir: meta.workspaceDir,
                    skillSourcePath: input.skillSourcePath,
                    runId: meta.runId,
                    requirementId: requirement.id,
                    agentKey: "traex",
                    trial,
                  },
                  cwd: meta.workspaceDir,
                  timeout: "5m",
                });
                const sessionKey = template`authoring-evaluation:${meta.runId}:${requirement.id}:traex:${trial}`;
                const authoring = step("traex_authoring").agent({
                  agent: agents.traex,
                  cwd: workspace.output.workspacePath,
                  sessionKey,
                  prompt: md`
                    ${AUTHORING_GUIDANCE}

                    Product request: ${requirement.title}

                    ${requirement.request}
                  `,
                  timeout: "45m",
                });
                const completed = lift(authoring.output, _output => "The previous authoring turn is complete.");
                const retrospective = step("traex_retrospective").agent({
                  agent: agents.traex,
                  cwd: workspace.output.workspacePath,
                  sessionKey,
                  prompt: md`${completed}\n\n${RETROSPECTIVE_GUIDANCE}`,
                  timeout: "15m",
                });
                return {
                  trial,
                  workspace: workspace.output,
                  authoringReport: authoring.output,
                  retrospective: retrospective.output,
                };
              },
            });
            return trials.output;
          },
        },
      });

      return {
        requirement: {
          id: requirement.id,
          title: requirement.title,
          request: requirement.request,
        },
        agents: agentRuns.output,
      };
    },
  });

  const recorded = step("record_evaluation").task({
    input: { runId: meta.runId, evaluations: evaluations.output },
    exec: async ({ input, artifact }) => {
      const logicalSessions = input.evaluations.reduce(
        (count, evaluation) => count
          + evaluation.agents.pi.length
          + evaluation.agents.claude.length
          + evaluation.agents.traex.length,
        0,
      );
      const dataset = {
        schemaVersion: 2,
        runId: input.runId,
        design: {
          requirementCount: input.evaluations.length,
          agents: {
            pi: { use: "pi", trace: true, authoritativeSkillRoot: ".agents" },
            claude: { use: "claude", trace: true, authoritativeSkillRoot: ".claude" },
            traex: { use: "traex", trace: true, authoritativeSkillRoot: ".agents" },
          },
          trialsPerAgent: 3,
          turnsPerSession: 2,
          logicalSessions,
          agentNodeExecutions: logicalSessions * 2,
        },
        measurement: {
          formalSource: "authoring Agent trace artifacts: type=tool events only",
          analyzer: "scripts/analyze-traces.mjs",
          retrospectiveRole: "qualitative pitfalls and discrepancy audit only",
        },
        evaluations: input.evaluations,
      };
      const sections = [
        "# Acpus authoring evaluation",
        "",
        `Run: ${input.runId}`,
        `Two-turn sessions: ${logicalSessions}`,
        `Agent node executions: ${logicalSessions * 2}`,
      ];
      const agentKeys = ["pi", "claude", "traex"] as const;
      for (const evaluation of input.evaluations) {
        sections.push("", `# ${evaluation.requirement.title}`, "", evaluation.requirement.request);
        for (const agentKey of agentKeys) {
          for (const trial of evaluation.agents[agentKey]) {
            sections.push(
              "",
              `## ${agentKey} · trial ${trial.trial}`,
              "",
              `Workspace: ${trial.workspace.workspacePath}`,
              `Workspace seed: ${trial.workspace.workspaceSeed}`,
              `Authoritative skill: ${trial.workspace.authoritativeSkillPath}`,
              `Skill digest: ${trial.workspace.skillCopies.source}`,
              "",
              "### Authoring completion report",
              "",
              trial.authoringReport,
              "",
              "### Retrospective",
              "",
              trial.retrospective,
            );
          }
        }
      }
      const datasetArtifact = await artifact.write(
        "authoring-evaluation.json",
        JSON.stringify(dataset, null, 2),
        { mediaType: "application/json" },
      );
      const reportArtifact = await artifact.write(
        "authoring-pitfalls.md",
        sections.join("\n"),
        { mediaType: "text/markdown" },
      );
      return {
        logicalSessions,
        agentNodeExecutions: logicalSessions * 2,
        dataset: datasetArtifact,
        report: reportArtifact,
      };
    },
  });

  return recorded.output;
});
