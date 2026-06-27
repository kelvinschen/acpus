import { defineWorkflow, z, agent, task, template, type ScopeContext } from "../src/index.js";

const PackageOut = z.object({
  packageName: z.string(),
  version: z.string(),
});

const reusablePackageTask = task.define({
  input: PackageOut,
  output: PackageOut,
}).run(async ({ input }) => ({
  packageName: input.packageName,
  version: input.version,
}));

export default defineWorkflow({
  name: "typed-step-input",
  input: z.object({
    packageName: z.string(),
    version: z.string(),
  }),
  agents: {
    reviewer: agent.define({ provider: "codex", policy: "read" }),
  },
}).build(({ input, step, output }) => {
  const nestedScope = ({ step, output }: ScopeContext) => {
    const first = step.task("nested_first", {
      input: { packageName: input.packageName },
      output: z.object({ packageName: z.string() }),
      run: async ({ input }) => ({ packageName: input.packageName }),
    });

    const branches = step.parallel("nested_parallel", {
      branches: {
        left: ({ output }) => output({ packageName: first.output.packageName }),
        right: ({ output }) => output({ version: input.version }),
      },
    });

    return output({
      packageName: first.output.packageName,
      branches: branches.output,
    });
  };

  const review = step.agent("typed_agent_input", {
    input: {
      packageName: input.packageName,
    },
    output: z.object({ ok: z.boolean() }),
    run: ({ input }) => {
      // @ts-expect-error undeclared step input fields are not available.
      input.version;
      return {
        use: "reviewer",
        prompt: template`Review ${input.packageName}`,
      };
    },
  });

  const inline = step.task("typed_inline_task_input", {
    input: {
      packageName: input.packageName,
      version: input.version,
    },
    output: PackageOut,
    run: async ({ input }) => {
      const version: string = input.version;
      // @ts-expect-error runtime input is unwrapped as string, not number.
      const badVersion: number = input.version;
      void badVersion;
      return {
        packageName: input.packageName,
        version,
      };
    },
  });

  step.task("typed_reusable_task_input", {
    input: {
      packageName: input.packageName,
      version: input.version,
    },
    output: PackageOut,
    run: reusablePackageTask,
  });

  // @ts-expect-error reusable tasks require every declared task input field.
  step.task("typed_reusable_task_missing_input", { input: { packageName: input.packageName }, output: PackageOut, run: reusablePackageTask });

  const nested = step.if("typed_nested_scope", {
    when: review.output.ok,
    then: nestedScope,
    otherwise: ({ output }) => output({ packageName: input.packageName, branches: {} }),
  });

  return output({
    ok: review.output.ok,
    version: inline.output.version,
    nested: nested.output,
  });
});
