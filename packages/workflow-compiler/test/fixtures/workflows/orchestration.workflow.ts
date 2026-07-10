import {
  defineWorkflow,
  z,
} from "acpus/core";
import {
  fmap,
  lift2,
  template,
} from "acpus/expression";

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
    reviewer: { use: "codex", permissionMode: "approve-reads" },
  },
}).build(({ input, agents, meta, step }) => {
  const lanes = step("lanes").fanout({
    maxConcurrency: 3,
    over: input.lanes,
    key({ item }) { return template`lane-${item.id}`; },
    do({ item }) {
      const laneParallel = step("lane_parallel").parallel({
        maxConcurrency: 3,
        branches: {
          review() {
            const review = step("review_lane").agent({
              outputSchema: LaneReview,
              run: {
                agent: agents.reviewer,
                prompt: template`Review lane ${item.id} in ${item.mode} mode.`,
              },
            });
            return {
              branch: review.output.branch,
              lane: review.output.lane,
              ok: review.output.ok,
            };
          },
          repair() {
            const repairLoop = step("repair_loop").loop({
              state: {
                branch: "",
                round: 0,
                continue: true,
                summary: "",
              },
              do({ state, round }) {
                const repair = step("repair_round").agent({
                  outputSchema: LaneRepair,
                  run: {
                    agent: agents.worker,
                    prompt: template`
                      Repair lane ${item.id}.
                      Round: ${round}
                      Previous summary: ${state.summary}
                    `,
                  },
                });
                const stop = lift2(repair.output.continue, round, (shouldContinue, currentRound) => !shouldContinue || currentRound >= 2);
                return {
                  state: {
                    branch: repair.output.branch,
                    round,
                    continue: repair.output.continue,
                    summary: repair.output.summary,
                  },
                  stop,
                };
              },
            });
            return {
              branch: repairLoop.output.branch,
              round: repairLoop.output.round,
              continue: repairLoop.output.continue,
              summary: repairLoop.output.summary,
            };
          },
          route() {
            const route = step("route_lane").switch({
              cases: [
                {
                  when: fmap(item.mode, mode => mode === "auto"),
                  then() {
                    const auto = step("auto_route").agent({
                      outputSchema: LaneRoute,
                      run: {
                        agent: agents.worker,
                        prompt: template`Choose automatic route for ${item.id}.`,
                      },
                    });
                    return {
                      branch: auto.output.branch,
                      lane: auto.output.lane,
                      route: auto.output.route,
                    };
                  },
                },
              ],
              default() {
                const manual = step("manual_route").agent({
                  outputSchema: LaneRoute,
                  run: {
                    agent: agents.worker,
                    prompt: template`Choose manual route for ${item.id}.`,
                  },
                });
                return {
                  branch: manual.output.branch,
                  lane: manual.output.lane,
                  route: manual.output.route,
                };
              },
            });
            return {
              branch: route.output.branch,
              lane: route.output.lane,
              route: route.output.route,
            };
          },
        },
      });

      return {
        lane: item.id,
        review_ok: laneParallel.output.review.ok,
        route: laneParallel.output.route.route,
        repair_summary: laneParallel.output.repair.summary,
      };
    },
  });

  const approval = step("approval").if({
    condition: input.requireHuman,
    then() {
      const human = step("human_approval").signal({
        outputSchema: Approval,
        run: {
          prompt: template`Approve orchestration result: ${lanes.output}`,
        },
      });
      return { approved: human.output.approved, notes: human.output.notes };
    },
    else() {
      const automatic = step("automatic_approval").task({
        run: {
          input: {},
          exec: async () => ({
            approved: true,
            notes: "auto-approved",
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
    approved: approval.output.approved,
    notes: approval.output.notes,
    first_lane: fmap(lanes.output, lanes => lanes[0]?.lane ?? "(none)"),
    first_route: fmap(lanes.output, lanes => lanes[0]?.route ?? "(none)"),
    first_review_ok: fmap(lanes.output, lanes => lanes[0]?.review_ok === true),
    run_id: meta.runId,
  };
});
