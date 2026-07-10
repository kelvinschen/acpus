/*
 * Pattern: Plan adversarial lenses, fan out reviews, cross-critique, and synthesize.
 * Nodes: agent, fanout
 */
import { defineWorkflow, z } from "acpus/core";
import { md, template } from "acpus/expression";

const Verdict = z.enum(["pass", "pass-with-nits", "needs-work", "block"]);

export default defineWorkflow({
    name: "adversarial-review",
    inputSchema: z.object({
        subject: z.string().describe(
            "The proposal, design, code change, workflow, plan, or decision to review adversarially.",
        ),
        rubric: z.string().describe(
            "The review standard: what good looks like, what must be true, and which qualities matter most.",
        ),
        criteria: z.string().default("").describe(
            "Optional comma-separated or natural-language review criteria, for example: correctness, DX, runtime safety.",
        ),
        context: z.string().default("").describe(
            "Optional background the agents should consider, such as constraints, prior decisions, known risks, or local workspace context.",
        ),
        maxLenses: z.number().default(4).describe(
            "Maximum number of distinct adversarial review lenses to create.",
        ),
    }),
    agents: {
        planner: {
            use: "pi",
        },
        reviewer: {
            use: "pi",
        },
        critic: {
            use: "claude",
        },
        synthesizer: {
            use: "claude",
        },
    },
}).build(({ input, agents, meta, step }) => {
    const plan = step("plan_lenses").agent({
        outputSchema: z.object({
            lenses: z.array(z.object({
                id: z.string(),
                prompt: z.string(),
            })),
        }),
        run: {
            agent: agents.planner,
            cwd: meta.workspaceDir,
            prompt: md`
                You are planning a dynamic adversarial review.

                Subject:
                ${input.subject}

                Context:
                ${input.context}

                Rubric:
                ${input.rubric}

                Criteria:
                ${input.criteria}

                Maximum lenses:
                ${input.maxLenses}

                Create the smallest useful set of review lenses.

                Rules:
                - Use only the subject, context, rubric, criteria, and readable local workspace context.
                - Prefer 3-5 lenses, but never exceed the maximum.
                - Avoid duplicate lenses.
                - Each lens must represent a distinct way the subject could fail.
                - Each lens id must be short, lowercase, and stable within the review output.
                - Each lens prompt must be a complete natural-language reviewer role, including focus and attack style.
                - Good lenses include correctness, feasibility, risk, edge cases, rubric compliance, maintainability, authoring fit, runtime contract, testing, migration risk, and DX.`,
        },
        timeout: "15m",
    });

    const reviews = step("blind_reviews").fanout({
        over: plan.output.lenses,
        maxConcurrency: 4,
        do({ item }) {
            const review = step("blind_review").agent({
                run: {
                    agent: agents.reviewer,
                    cwd: meta.workspaceDir,
                    prompt: md`
                        You are a blind reviewer.

                        Your lens:
                        ${item.prompt}

                        Subject:
                        ${input.subject}

                        Context:
                        ${input.context}

                        Rubric:
                        ${input.rubric}

                        Criteria:
                        ${input.criteria}

                        Rules:
                        - Work independently.
                        - Do not assume what other reviewers will say.
                        - Judge only from the given subject, context, rubric, criteria, and readable local workspace context.
                        - Be adversarial but fair.
                        - Prefer concrete issues over broad complaints.
                        - Mark uncertainty explicitly.
                        - Do not block on nits.
                        - Do not try to match a JSON schema.

                        Return Markdown with these sections:
                        - Summary
                        - Strengths
                        - Issues
                        - Hidden assumptions
                        - Verdict`,
                },
                timeout: "30m",
            });

            return {
                review: review.output,
            };
        },
    });

    const critiques = step("cross_critiques").fanout({
        over: plan.output.lenses,
        maxConcurrency: 4,
        do({ item }) {
            const critique = step("critique_reviews").agent({
                run: {
                    agent: agents.critic,
                    cwd: meta.workspaceDir,
                    prompt: md`
                        You are now a red-team critic.

                        Your lens:
                        ${item.prompt}

                        Subject:
                        ${input.subject}

                        Rubric:
                        ${input.rubric}

                        Criteria:
                        ${input.criteria}

                        Blind reviews:
                        ${reviews.output}

                        Attack the reviews, not the author.

                        Look for:
                        - Unsupported claims.
                        - Missed risks.
                        - Overconfidence.
                        - Contradictions.
                        - Rubric gaps.
                        - Recommendations that do not follow from the issue.
                        - Issues that are mislabeled as blocking or under-labeled as minor.

                        Rules:
                        - Do not merely summarize.
                        - Concede points that are already strong.
                        - Return only substantial objections.
                        - Do not try to match a JSON schema.

                        Return Markdown with these sections:
                        - Objections
                        - Contradictions
                        - Concessions
                        - Stronger alternatives`,
                },
                timeout: "30m",
            });

            return {
                critique: critique.output,
            };
        },
    });

    const synthesis = step("synthesize_result").agent({
        outputSchema: z.object({
            verdict: Verdict,
            report: z.string(),
        }),
        run: {
            agent: agents.synthesizer,
            cwd: meta.workspaceDir,
            prompt: md`
                You are the judge for a dynamic adversarial review.

                Subject:
                ${input.subject}

                Context:
                ${input.context}

                Rubric:
                ${input.rubric}

                Criteria:
                ${input.criteria}

                Lens plan:
                ${plan.output}

                Blind reviews:
                ${reviews.output}

                Cross critiques:
                ${critiques.output}

                Rules:
                - Do not average opinions mechanically.
                - Weigh concrete basis over reviewer confidence.
                - In the report, separate consensus from unresolved disagreement.
                - Blocking issues must be explicit.
                - Nits must not block approval.
                - Required actions must be concrete and actionable.
                - Nice-to-have items must not be mixed into required actions.
                - If the context is insufficient, say so directly instead of inventing evidence.
                - Do not search the internet.
                - The report should be natural-language Markdown containing: assessment, consensus, blocking issues, non-blocking issues, unresolved disagreements, required actions, and nice-to-have items.
                - Return JSON matching the schema.`,
        },
        timeout: "30m",
    });

    return {
        plan: plan.output,
        reviews: reviews.output,
        critiques: critiques.output,
        synthesis: synthesis.output,
    };
});
