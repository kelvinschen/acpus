import {
  defineWorkflow,
  z,
} from "@acpus/core";
import {
  eq,
  coalesce,
  head,
  not,
  pick,
  template,
  where,
} from "@acpus/expression";

const Lane = z.object({
  id: z.string(),
  mode: z.enum(["auto", "manual"]),
});

const LaneReview = z.object({
  branch: z.string(),
  lane: z.string(),
  ok: z.boolean(),
});

const LaneRepair = z.object({
  branch: z.string(),
  round: z.number().int(),
  continue: z.boolean(),
  summary: z.string(),
});

const LaneRoute = z.object({
  branch: z.string(),
  lane: z.string(),
  route: z.string(),
});

const LaneResult = z.object({
  lane: z.string(),
  review_ok: z.boolean(),
  route: z.string(),
  repair_summary: z.string(),
});

const Approval = z.object({
  approved: z.boolean(),
  notes: z.string(),
});

export default defineWorkflow({
  name: "orchestration-fixture",
  inputSchema: z.object({
    lanes: z.array(Lane),
    requireHuman: z.boolean(),
  }),
  agents: {
    worker: { use: "codex" },
    reviewer: { use: "codex", policy: "read" },
  },
}).build(({ input, agents, meta, step }) => {
  const lanes = step("lanes").fanout({
    maxConcurrency: 3,
    over: input.lanes,
    key: ({ item }) => template`lane-${item.id}`,
    itemOutputSchema: LaneResult,
    do: ({ item, step }) => {
      const laneParallel = step("lane_parallel").parallel({
        maxConcurrency: 3,
        branches: {
          review: {
            outputSchema: LaneReview,
            do: ({ step }) => {
              const review = step("review_lane").agent({
                outputSchema: LaneReview,
                run: {
                  agent: agents.reviewer,
                  prompt: template`Review lane ${item.id} in ${item.mode} mode.`,
                },
              });
              return pick(review.output, ["branch", "lane", "ok"]);
            },
          },
          repair: {
            outputSchema: LaneRepair,
            do: ({ step }) => {
              const repairLoop = step("repair_loop").loop({
                maxIterations: 2,
                outputSchema: LaneRepair,
                do: ({ iter, previous, step }) => {
                  const repair = step("repair_round").agent({
                    outputSchema: LaneRepair,
                    run: {
                      agent: agents.worker,
                      prompt: template`
                        Repair lane ${item.id}.
                        Round: ${iter}
                        Previous summary: ${coalesce(previous.summary, "(none)")}
                      `,
                    },
                  });
                  return {
                    ...pick(repair.output, ["branch", "continue", "summary"]),
                    round: iter,
                  };
                },
                stopWhen: ({ result }) => not(result.continue),
                onExhausted: "returnLast",
              });
              return pick(repairLoop.output, [
                "branch",
                "round",
                "continue",
                "summary",
              ]);
            },
          },
          route: {
            outputSchema: LaneRoute,
            do: ({ step }) => {
              const route = step("route_lane").switch({
                outputSchema: LaneRoute,
                cases: [
                  {
                    when: eq(item.mode, "auto"),
                    then: ({ step }) => {
                      const auto = step("auto_route").agent({
                        outputSchema: LaneRoute,
                        run: {
                          agent: agents.worker,
                          prompt: template`Choose automatic route for ${item.id}.`,
                        },
                      });
                      return pick(auto.output, ["branch", "lane", "route"]);
                    },
                  },
                ],
                default: ({ step }) => {
                  const manual = step("manual_route").agent({
                    outputSchema: LaneRoute,
                    run: {
                      agent: agents.worker,
                      prompt: template`Choose manual route for ${item.id}.`,
                    },
                  });
                  return pick(manual.output, ["branch", "lane", "route"]);
                },
              });
              return pick(route.output, ["branch", "lane", "route"]);
            },
          },
        },
      });

      return {
        lane: coalesce(item.id, "(none)"),
        review_ok: laneParallel.output.review.ok,
        route: laneParallel.output.route.route,
        repair_summary: laneParallel.output.repair.summary,
      };
    },
  });
  const approval = step("approval").if({
    condition: input.requireHuman,
    outputSchema: Approval,
    then: ({ step }) => {
      const human = step("human_approval").signal({
        outputSchema: Approval,
        run: {
          prompt: template`Approve orchestration result: ${lanes.output}`,
        },
      });
      return pick(human.output, ["approved", "notes"]);
    },
    else: ({ step }) => {
      const automatic = step("automatic_approval").task({
        outputSchema: Approval,
        run: {
          input: {},
          exec: async ({ $ }) => ({
            approved: true,
            notes: "auto-approved",
          }),
        },
      });
      return pick(automatic.output, ["approved", "notes"]);
    },
  });

  step("require_approval").assert({
    condition: approval.output.approved,
    message: template`Approval failed: ${approval.output.notes}`,
  });

  return {
    approved: approval.output.approved,
    notes: approval.output.notes,
    first_lane: coalesce(head(lanes.output).lane, "(none)"),
    first_route: coalesce(head(lanes.output).route, "(none)"),
    first_review_ok: where(head(lanes.output), { review_ok: true }),
    run_id: meta.runId,
  };
});
