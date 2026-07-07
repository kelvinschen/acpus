import { defineWorkflow, z } from "acpus/core";
import {
  and,
  coalesce,
  filter,
  gte,
  head,
  includes,
  len,
  map,
  md,
  not,
  or,
  template,
  where,
} from "acpus/expression";

const Candidate = z.object({
  id: z.string(),
  kind: z.enum(["feature", "fix", "research"]),
  priority: z.number(),
  score: z.number(),
  tags: z.array(z.string()),
});

const ReviewOut = z.object({
  approved: z.boolean(),
  risk: z.number(),
  summary: z.string(),
});

const Approval = z.object({
  approved: z.boolean(),
  notes: z.string().default(""),
});

export default defineWorkflow({
  name: "advanced-boundary",
  inputSchema: z.object({
    candidates: z.array(Candidate),
    minScore: z.number().default(70),
    requireHuman: z.boolean().default(false),
  }),
  agents: {
    reviewer: { use: "codex", permissionMode: "approve-reads" },
  },
}).build(({ input, agents, meta, step }) => {
  const readyCandidates = filter(input.candidates, item =>
    and(
      where(item, { score: { gte: input.minScore }, tags: { contains: "ready" } }),
      not(includes(item.tags, "blocked")),
    ));
  const readyLabels = map(readyCandidates, item => template`${item.id}:${item.kind}:${item.score}`);

  const inventory = step("inventory").task({
    run: {
      input: {
        candidates: input.candidates,
        readyCount: len(readyCandidates),
        readyLabels,
      },
      exec: async ({ input }) => ({
        totalCount: input.candidates.length,
        readyCount: input.readyCount,
        readyLabelsText: input.readyLabels.join(", "),
      }),
    },
  });

  const lanes = step("candidate_lanes").fanout({
    over: input.candidates,
    key: ({ item }) => template`candidate-${item.id}`,
    maxConcurrency: 3,
    do: ({ item, itemIndex, step }) => {
      const routed = step("route_candidate").switch({
        cases: [
          {
            when: and(
              where(item, { score: { gte: input.minScore }, tags: { contains: "ready" } }),
              not(includes(item.tags, "blocked")),
            ),
            then: ({ step }) => {
              const reviewed = step("review_parallel").parallel({
                branches: {
                  static_score: {
                    do: ({ step }) => {
                      const score = step("score_candidate").task({
                        run: {
                          input: {
                            itemIndex,
                            priority: item.priority,
                            score: item.score,
                          },
                          exec: async ({ input }) => ({
                            effectiveScore: input.score + input.priority - input.itemIndex,
                            summary: `score=${input.score} priority=${input.priority}`,
                          }),
                        },
                      });
                      return {
                        effectiveScore: score.output.effectiveScore,
                        summary: score.output.summary,
                      };
                    },
                  },
                  ai_review: {
                    do: ({ step }) => {
                      const review = step("review_candidate").agent({
                        outputSchema: ReviewOut,
                        run: {
                          agent: agents.reviewer,
                          prompt: md`
                            Review candidate ${item.id}.
                            Kind: ${item.kind}
                            Tags: ${item.tags}
                            Score: ${item.score}

                            Return exactly one JSON object matching the schema.
                          `,
                        },
                        retry: { max: 1 },
                        timeout: "20m",
                      });
                      return {
                        approved: review.output.approved,
                        risk: review.output.risk,
                        summary: review.output.summary,
                      };
                    },
                  },
                },
              });

              return {
                approved: reviewed.output.ai_review.approved,
                route: "review",
                risk: reviewed.output.ai_review.risk,
                summary: reviewed.output.ai_review.summary,
                score: reviewed.output.static_score.effectiveScore,
              };
            },
          },
        ],
        default: ({ step }) => {
          const skipped = step("skip_candidate").task({
            run: {
              input: { id: item.id },
              exec: async ({ input }) => ({
                approved: false,
                route: "skip",
                risk: 0,
                summary: `skipped ${input.id}`,
                score: 0,
              }),
            },
          });
          return {
            approved: skipped.output.approved,
            route: skipped.output.route,
            risk: skipped.output.risk,
            summary: skipped.output.summary,
            score: skipped.output.score,
          };
        },
      });

      const remediation = step("remediation_loop").loop({
        initial: { done: false, round: 0, summary: "seed" },
        maxIterations: 2,
        do: ({ iter, previous, step }) => {
          const plan = step("plan_remediation").task({
            run: {
              input: {
                id: item.id,
                iter,
                minScore: input.minScore,
                previous: previous.summary,
                score: item.score,
              },
              exec: async ({ input }) => ({
                done: input.score + input.iter * 10 >= input.minScore,
                round: input.iter + 1,
                summary: `${input.id} round ${input.iter}: ${input.previous}`,
              }),
            },
          });
          return {
            done: plan.output.done,
            round: plan.output.round,
            summary: plan.output.summary,
          };
        },
        stopWhen: ({ result }) => result.done,
        onExhausted: "returnLast",
      });

      return {
        id: item.id,
        approved: routed.output.approved,
        route: routed.output.route,
        summary: routed.output.summary,
        needsFollowup: or(not(routed.output.approved), gte(routed.output.risk, 4)),
        remediation: remediation.output.summary,
      };
    },
  });

  const approval = step("approval").if({
    condition: input.requireHuman,
    then: ({ step }) => {
      const human = step("human_approval").signal({
        outputSchema: Approval,
        run: {
          prompt: template`Approve ${inventory.output.readyCount} ready candidates: ${lanes.output}`,
        },
        timeout: "24h",
        onTimeout: { action: "fail", message: "approval timed out" },
      });
      return { approved: human.output.approved, notes: human.output.notes };
    },
    else: ({ step }) => {
      const automatic = step("auto_approval").task({
        run: {
          input: { readyCount: inventory.output.readyCount },
          exec: async ({ input }) => ({
            approved: input.readyCount > 0,
            notes: `auto-approved ${input.readyCount} ready candidates`,
          }),
        },
      });
      return { approved: automatic.output.approved, notes: automatic.output.notes };
    },
  });

  step("require_approval").assert({
    condition: approval.output.approved,
    message: template`Approval failed: ${approval.output.notes}`,
  });

  return {
    runId: meta.runId,
    totalCount: inventory.output.totalCount,
    readyCount: inventory.output.readyCount,
    firstRoute: coalesce(head(lanes.output).route, "(none)"),
    firstSummary: coalesce(head(lanes.output).summary, "(none)"),
    readyLabels: inventory.output.readyLabelsText,
  };
});
