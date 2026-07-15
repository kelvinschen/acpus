/*
 * Pattern: Fan out issue triage, run branch work in parallel, and route by switch.
 * Nodes: agent, task, switch, parallel, fanout
 */
import { defineWorkflow, z } from "acpus/core";
import { eq, lift, md } from "acpus/expression";

export default defineWorkflow({
  name: "issue-triage",
  description: "Triage repository issues with metadata summarization, agent review, and routing decisions.",
  inputSchema: z.object({
    issues: z.array(z.object({
      id: z.string().describe("Issue identifier used in route messages."),
      title: z.string().describe("Issue title to show the triage agent and queue actions."),
      body: z.string().describe("Issue body or description to triage."),
      labels: z.array(z.string()).default([]).describe("Optional issue labels available to metadata and triage steps."),
    })).describe("Issues to triage in parallel."),
    repoPath: z.string().describe("Repository path where the triage agent should inspect context."),
  }),
  agents: {
    triager: { use: "codex" },
  },
}).build(({ input, agents, meta, step }) => {
  const triaged = step("triage_issues").fanout({
    over: input.issues,
    maxConcurrency: 3,
    do({ item }) {
      const lane = step("triage_lane").parallel({
        branches: {
          metadata() {
            const metadata = step("summarize_issue").task({
              input: { id: item.id, title: item.title, labels: item.labels },
              exec: async ({ input }) => ({
                labelCount: input.labels.length,
                titleLine: `${input.id}: ${input.title}`,
              }),
            });
            return metadata.output;
          },
          review() {
            const review = step("review_issue").agent({
              outputSchema: z.object({
                route: z.enum(["now", "later", "escalate"]),
                priority: z.number(),
                summary: z.string(),
              }),
              agent: agents.triager,
              cwd: input.repoPath,
              prompt: md`
                Triage this issue for the current repository.

                ID: ${item.id}
                Title: ${item.title}
                Body: ${item.body}
                Labels: ${item.labels}

                Choose route "now", "later", or "escalate".
              `,
              timeout: "20m",
            });
            const reviewView = lift(review.output, output => ({
              route: output.route,
              priority: output.priority,
              summary: output.summary.trim(),
            }));
            return reviewView;
          },
        },
      });

      const routed = step("route_issue").switch({
        cases: [
          {
            when: eq(lane.output.review.route, "escalate"),
            then() {
              const escalation = step("prepare_escalation").task({
                input: {
                  id: item.id,
                  priority: lane.output.review.priority,
                  summary: lane.output.review.summary,
                },
                exec: async ({ input }) => ({
                  owner: "maintainer",
                  action: `Escalate ${input.id} with priority ${input.priority}: ${input.summary}`,
                }),
              });
              return escalation.output;
            },
          },
          {
            when: eq(lane.output.review.route, "now"),
            then() {
              const queue = step("queue_now").task({
                input: { id: item.id, title: lane.output.metadata.titleLine },
                exec: async ({ input }) => ({
                  owner: "oncall",
                  action: `Queue ${input.title} for this sprint`,
                }),
              });
              return queue.output;
            },
          },
        ],
        default() {
          const backlog = step("backlog_later").task({
            input: { id: item.id, labelCount: lane.output.metadata.labelCount },
            exec: async ({ input }) => ({
              owner: "backlog",
              action: `Backlog ${input.id} with ${input.labelCount} labels`,
            }),
          });
          return backlog.output;
        },
      });

      return {
        id: item.id,
        route: lane.output.review.route,
        priority: lane.output.review.priority,
        owner: routed.output.owner,
        action: routed.output.action,
        summary: lane.output.review.summary,
      };
    },
  });


  return {
    runId: meta.runId,
    triaged: triaged.output,
  };
});
