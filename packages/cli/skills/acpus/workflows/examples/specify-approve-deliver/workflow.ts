/*
 * Pattern: Specify a change, approve its contract, then deliver verified work.
 * Run from the clean target Git repository; the only workflow input is the request.
 * Nodes: agent, task, signal, assert, if, loop
 */
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineWorkflow, z } from "acpus/core";
import { and, gte, md, or, template } from "acpus/expression";
import { createWorktree } from "acpus/tasks/git";

const Contract = z.object({
  summary: z.string(),
  evidence: z.string(),
});

const Review = z.object({
  approved: z.boolean(),
  feedback: z.string(),
});

const worktreeRoot = join(tmpdir(), "acpus-specify-approve-deliver");

export default defineWorkflow({
  name: "specify-approve-deliver",
  description: "Specify and approve a contract, then implement and publish verified work.",
  inputSchema: z.object({
    request: z.string().describe("The software change to make in the current repository."),
  }),
  agents: {
    specifier: {},
    implementer: {},
    reviewer: {},
  },
}).build(({ input, agents, meta, step }) => {
  const worktree = step("create_worktree").task({
    task: createWorktree,
    input: {
      repo: meta.workspaceDir,
      path: template`${worktreeRoot}/${meta.runId}`,
      ref: "HEAD",
    },
  });

  const initial = step("specify").agent({
    agent: agents.specifier,
    cwd: worktree.output.worktreePath,
    outputSchema: Contract,
    prompt: md`
      Define the smallest externally observable contract for: ${input.request}

      Follow repository instructions and inspect the real interface. Add acceptance
      tests or documentation when they clarify the contract, but do not change
      production behavior. Return a durable summary without progress claims and a
      concise natural-language account of the evidence that should verify it.
    `,
  });

  const contract = step("contract_approval").loop({
    state: {
      approved: false as boolean,
      summary: initial.output.summary,
      evidence: initial.output.evidence,
      notes: "",
      rounds: 0,
    },
    do({ round, state }) {
      const decision = step("confirm_contract").signal({
        outputSchema: z.object({
          approved: z.boolean(),
          notes: z.string().default(""),
        }),
        prompt: md`
          Confirm this contract before implementation.

          Request: ${input.request}
          Contract: ${state.summary}
          Expected evidence: ${state.evidence}

          Approve, or reject with the concrete mismatch. The Specifier can revise once.
        `,
      });

      const finished = or(decision.output.approved, gte(round, 2));
      const candidate = step("revision_gate").if({
        condition: finished,
        then() {
          return { summary: state.summary, evidence: state.evidence };
        },
        else() {
          return step("revise_contract").agent({
            agent: agents.specifier,
            cwd: worktree.output.worktreePath,
            outputSchema: Contract,
            prompt: md`
              Revise the complete contract for ${input.request}.

              Current contract: ${state.summary}
              Current expected evidence: ${state.evidence}
              Rejection notes: ${decision.output.notes}

              Address only the stated mismatch. Update specification artifacts when
              needed, do not change production behavior, and return the complete durable
              summary and natural-language verification intent.
            `,
          }).output;
        },
      });

      return {
        state: {
          approved: decision.output.approved,
          summary: candidate.output.summary,
          evidence: candidate.output.evidence,
          notes: decision.output.notes,
          rounds: round,
        },
        stop: finished,
      };
    },
  });

  step("require_contract_approval").assert({
    condition: contract.output.approved,
    message: template`Contract was not approved: ${contract.output.notes}`,
  });

  step("implement").agent({
    agent: agents.implementer,
    sessionKey: "delivery:implementer",
    cwd: worktree.output.worktreePath,
    prompt: md`
      Implement the smallest complete change for: ${input.request}

      Approved contract: ${contract.output.summary}
      Expected evidence: ${contract.output.evidence}

      Continue in the Specifier's worktree and take ownership of its changes. Follow
      repository instructions, commit every intended change, and leave the tree clean.
    `,
  });

  const quality = step("quality_cycle").loop({
    state: {
      approved: false as boolean,
      head: worktree.output.baseSha,
      review: "Not reviewed.",
      rounds: 0,
    },
    do({ round }) {
      const snapshot = step("snapshot_candidate").task({
        input: {
          worktreePath: worktree.output.worktreePath,
        },
        exec: async ({ input, $ }) => {
          const head = (await $`git -C ${input.worktreePath} rev-parse HEAD`.text()).trim();
          return { head };
        },
      });

      const review = step("review_candidate").agent({
        agent: agents.reviewer,
        cwd: worktree.output.worktreePath,
        outputSchema: Review,
        prompt: md`
          Review the candidate for: ${input.request}

          Approved contract: ${contract.output.summary}
          Expected evidence: ${contract.output.evidence}
          Base: ${worktree.output.baseSha}
          Candidate: ${snapshot.output.head}

          Stay read-only and inspect only this base-to-candidate lineage. Gather the
          evidence appropriate to the contract, including running checks when useful.
          Approve only when the evidence is sufficient and no concrete blocker remains.
        `,
      });

      const admission = step("admit_candidate").task({
        input: {
          worktreePath: worktree.output.worktreePath,
          baseSha: worktree.output.baseSha,
          expectedHead: snapshot.output.head,
        },
        exec: async ({ input, $ }) => {
          const head = (await $`git -C ${input.worktreePath} rev-parse HEAD`.text()).trim();
          const diff = await $`git -C ${input.worktreePath} diff --check ${input.baseSha} ${head}`.nothrow();
          const ancestry = await $`git -C ${input.worktreePath} merge-base --is-ancestor ${input.baseSha} ${head}`.nothrow();
          const status = (await $`git -C ${input.worktreePath} status --porcelain`.text()).trim();
          const diffClean = diff.exitCode === 0;
          const descendant = ancestry.exitCode === 0;
          return {
            admitted: head === input.expectedHead
              && head !== input.baseSha
              && diffClean
              && descendant
              && status === "",
            head,
            status,
            diffClean,
            descendant,
          };
        },
      });

      const accepted = and(admission.output.admitted, review.output.approved);
      const finished = or(accepted, gte(round, 2));
      step("improvement_gate").if({
        condition: finished,
        then() {
          return {};
        },
        else() {
          step("improve_candidate").agent({
            agent: agents.implementer,
            sessionKey: "delivery:implementer",
            cwd: worktree.output.worktreePath,
            prompt: md`
              Continue the implementation for: ${input.request}

              Approved contract: ${contract.output.summary}
              Expected evidence: ${contract.output.evidence}
              Repository admission: ${admission.output}
              Fresh review: ${review.output.feedback}

              Address only the evidenced blockers, commit the smallest complete
              correction, and leave the tree clean.
            `,
          });
          return {};
        },
      });

      return {
        state: {
          approved: accepted,
          head: admission.output.head,
          review: review.output.feedback,
          rounds: round,
        },
        stop: finished,
      };
    },
  });

  step("require_quality_approval").assert({
    condition: quality.output.approved,
    message: template`Quality review failed: ${quality.output.review}`,
  });

  const published = step("publish_result").task({
    input: {
      repoPath: meta.workspaceDir,
      worktreePath: worktree.output.worktreePath,
      baseSha: worktree.output.baseSha,
      expectedHead: quality.output.head,
      branch: template`acpus/change/${meta.runId}`,
    },
    exec: async ({ input, $ }) => {
      const head = (await $`git -C ${input.worktreePath} rev-parse HEAD`.text()).trim();
      const status = (await $`git -C ${input.worktreePath} status --porcelain`.text()).trim();
      if (head !== input.expectedHead || head === input.baseSha || status !== "") {
        throw new Error("Candidate changed after review");
      }
      await $`git -C ${input.repoPath} merge-base --is-ancestor ${input.baseSha} ${head}`;
      await $`git -C ${input.repoPath} check-ref-format --branch ${input.branch}`;
      await $`git -C ${input.repoPath} update-ref ${`refs/heads/${input.branch}`} ${head}`;
      return { branch: input.branch, commit: head };
    },
  });

  return {
    runId: meta.runId,
    branch: published.output.branch,
    commit: published.output.commit,
    contract: contract.output.summary,
    contractRounds: contract.output.rounds,
    qualityRounds: quality.output.rounds,
    review: quality.output.review,
  };
});
