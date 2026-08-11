import { defineWorkflow, z } from "@acpus/core";
import { lift, template } from "@acpus/expression";
import { ResultAsync } from "neverthrow";
import { beforeEach, vi } from "vitest";
import { advanceFrozenRun as advanceFrozenRunProduction } from "../../src/scheduler/runtime-runner.js";
import { createInlineTaskAttemptHarness, type TaskAttemptRunner } from "./task-attempt-harness.js";

const hoistedTaskMocks = vi.hoisted(() => ({ runTaskAttempt: vi.fn<TaskAttemptRunner>() }));

vi.mock("../../src/execution/task-process.js", async importOriginal => ({
  ...await importOriginal<typeof import("../../src/execution/task-process.js")>(),
  runTaskAttempt: hoistedTaskMocks.runTaskAttempt,
}));

export const taskMocks = {
  get runTaskAttempt() { return hoistedTaskMocks.runTaskAttempt; },
};

let taskAttemptHarness = createInlineTaskAttemptHarness();
beforeEach(() => {
  taskAttemptHarness = createInlineTaskAttemptHarness();
  hoistedTaskMocks.runTaskAttempt.mockReset().mockImplementation(input => taskAttemptHarness.runAttempt(input));
});
export const advanceFrozenRun = advanceFrozenRunProduction;

export function holdFirstTaskAttempt() {
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>(resolve => {
    releaseFirst = resolve;
  });
  let calls = 0;
  let active = 0;
  let peak = 0;
  taskMocks.runTaskAttempt.mockImplementation(input => {
    calls += 1;
    active += 1;
    peak = Math.max(peak, active);
    return ResultAsync.fromSafePromise(calls === 1 ? firstGate : Promise.resolve())
      .andThen(() => taskAttemptHarness.runAttempt(input))
      .map(value => {
        active -= 1;
        return value;
      })
      .mapErr(error => {
        active -= 1;
        return error;
      });
  });
  return { releaseFirst, peak: () => peak };
}

export function failingRootAssertWorkflow() {
  return defineWorkflow({
    name: "scheduler-node-executor-failing-assert",
  }).build(({ step }) => {
    step("fail").assert({ condition: false });
    return {};
  });
}

export function failingExpressionCallbackWorkflow() {
  return defineWorkflow({
    name: "scheduler-node-executor-failing-expression-callback",
  }).build(({ step }) => {
    step("fail").assert({ condition: lift(true, ((_value: boolean) => new Date()) as never) });
    return {};
  });
}

export function rootSignalWorkflow() {
  return defineWorkflow({
    name: "scheduler-node-executor-signal",
  }).build(({ step }) => {
    const approval = step("approve").signal({
      outputSchema: z.object({ ok: z.boolean() }),
      prompt: "approve",
    });
    return { ok: approval.output.ok };
  });
}

export function rootTimedSignalWorkflow() {
  return defineWorkflow({
    name: "scheduler-node-executor-signal-timeout",
    inputSchema: z.object({ timeout: z.string(), prompt: z.string(), timeoutMessage: z.string() }),
  }).build(({ input, step }) => {
    const approval = step("approve").signal({
      outputSchema: z.object({ ok: z.boolean() }),
      timeout: input.timeout,
      onTimeout: { message: input.timeoutMessage },
      prompt: input.prompt,
    });
    return { ok: approval.output.ok };
  });
}

export function signalWakeRefillWorkflow() {
  return defineWorkflow({
    name: "scheduler-run-execution-signal-wake-refill",
  }).build(({ step }) => {
    const work = step("work").parallel({
      maxConcurrency: 2,
      branches: {
        long() {
          const task = step("long_task").task({
            input: null, exec: async () => ({ value: "long" }),
          });
          return { value: task.output.value };
        },
        signaled() {
          const approval = step("approve").signal({
            outputSchema: z.object({ ok: z.boolean() }),
            prompt: "approve",
          });
          const task = step("after_signal_task").task({
            input: { approved: approval.output.ok },
            exec: async ({ input }) => ({ value: input.approved ? "approved" : "rejected" }),
          });
          return { value: task.output.value };
        },
      },
    });
    return { long: work.output.long.value, signaled: work.output.signaled.value };
  });
}

export function sequentialRootTaskWorkflow() {
  return defineWorkflow({
    name: "scheduler-node-executor-root-sequence",
  }).build(({ step }) => {
    const first = step("first_task").task({
      input: null, exec: async () => ({ value: "first" }),
    });
    const second = step("second_task").task({
      input: { value: first.output.value },
      exec: async ({ input }) => ({ value: `${input.value}-second` }),
    });
    return { final: second.output.value };
  });
}

export function rootIfTaskWorkflow() {
  return defineWorkflow({
    name: "scheduler-node-executor-root-if",
    inputSchema: z.object({ shouldRun: z.boolean() }),
  }).build(({ input, step }) => {
    step("require_run").assert({ condition: input.shouldRun });
    const gate = step("gate").if({
      condition: input.shouldRun,
      then() {
        const task = step("then_task").task({
          input: null, exec: async () => ({ value: "then" }),
        });
        return { value: task.output.value };
      },
      else() { return { value: template`else` }; },
    });
    const final = step("final_task").task({
      input: { value: gate.output.value },
      exec: async ({ input }) => ({ final: `${input.value}-final` }),
    });
    return { final: final.output.final };
  });
}

export function rootIfSequentialTaskWorkflow() {
  return defineWorkflow({
    name: "scheduler-node-executor-root-if-sequence",
    inputSchema: z.object({ shouldRun: z.boolean() }),
  }).build(({ input, step }) => {
    const gate = step("gate").if({
      condition: input.shouldRun,
      then() {
        const first = step("then_first").task({
          input: null, exec: async () => ({ value: "first" }),
        });
        const second = step("then_second").task({
          input: { value: first.output.value },
          exec: async ({ input }) => ({ value: `${input.value}-second` }),
        });
        return { value: second.output.value };
      },
      else() { return { value: template`else` }; },
    });
    const final = step("final_task").task({
      input: { value: gate.output.value },
      exec: async ({ input }) => ({ final: `${input.value}-final` }),
    });
    return { final: final.output.final };
  });
}

export function rootSwitchSequentialTaskWorkflow() {
  return defineWorkflow({
    name: "scheduler-node-executor-root-switch-sequence",
    inputSchema: z.object({ mode: z.string() }),
  }).build(({ input, step }) => {
    const route = step("route").switch({
      cases: [
        {
          when: lift(input.mode, mode => mode === "case"),
          then() {
            const first = step("case_first").task({
              input: null, exec: async () => ({ value: "case" }),
            });
            const second = step("case_second").task({
              input: { value: first.output.value },
              exec: async ({ input }) => ({ value: `${input.value}-second` }),
            });
            return { value: second.output.value };
          },
        },
      ],
      default() { return { value: template`default` }; },
    });
    return { value: route.output.value };
  });
}

export function rootParallelTaskWorkflow(options: { maxConcurrency?: number; dynamicMaxConcurrency?: boolean } = {}) {
  return defineWorkflow({
    name: "scheduler-node-executor-root-parallel",
    inputSchema: z.object({ maxConcurrency: z.number().default(options.maxConcurrency ?? 2) }),
  }).build(({ input, step }) => {
    step("race").parallel({
      ...(options.dynamicMaxConcurrency ? { maxConcurrency: input.maxConcurrency } : options.maxConcurrency === undefined ? {} : { maxConcurrency: options.maxConcurrency }),
      branches: {
        left() {
          const task = step("left_task").task({
            input: null, exec: async () => ({ value: "left" }),
          });
          return { value: task.output.value, rootPrefix: "root" };
        },
        right() {
          const task = step("right_task").task({
            input: null, exec: async () => ({ value: "right" }),
          });
          return { value: task.output.value };
        },
      },
    });
    return {};
  });
}

export function sequentialRootParallelWorkflow() {
  return defineWorkflow({
    name: "scheduler-node-executor-root-sequence-parallel",
  }).build(({ step }) => {
    const prepare = step("prepare_task").task({
      input: null, exec: async () => ({ prefix: "root" }),
    });
    const combined = step("combine").parallel({
      branches: {
        left() {
          const task = step("left_task").task({
            input: { prefix: prepare.output.prefix },
            exec: async ({ input }: { input: { prefix: string } }) => ({ value: `${input.prefix}-left` }),
          });
          return { value: task.output.value, rootPrefix: prepare.output.prefix };
        },
        right() {
          const task = step("right_task").task({
            input: { prefix: prepare.output.prefix },
            exec: async ({ input }: { input: { prefix: string } }) => ({ value: `${input.prefix}-right` }),
          });
          return { value: task.output.value, rootPrefix: prepare.output.prefix };
        },
      },
    });
    return { finalValue: combined.output.left.value, finalPrefix: combined.output.left.rootPrefix };
  });
}

export function multiNodeRootParallelWorkflow() {
  return defineWorkflow({
    name: "scheduler-node-executor-root-parallel-multi-node",
  }).build(({ step }) => {
    step("parallel").parallel({
      branches: {
        mixed() {
          step("first_task").task({
            input: null, exec: async () => ({ value: "first" }),
          });
          const second = step("second_task").task({
            input: null, exec: async () => ({ value: "second" }),
          });
          return { value: second.output.value };
        },
      },
    });
    return {};
  });
}

export function multiNodeRootFanoutWorkflow() {
  return defineWorkflow({
    name: "scheduler-node-executor-root-fanout-multi-node",
    inputSchema: z.object({ items: z.array(z.string()) }),
  }).build(({ input, step }) => {
    step("items").fanout({
      over: input.items,
      do({ item }) {
        const first = step("first_task").task({
          input: { item },
          exec: async ({ input }) => ({ value: `${input.item}-first` }),
        });
        const second = step("second_task").task({
          input: { item, first: first.output.value },
          exec: async ({ input }) => ({ item: input.item, value: input.first.replace("first", "second") }),
        });
        return { item: second.output.item, value: second.output.value };
      },
    });
    return {};
  });
}

export function nestedFanoutInParallelWorkflow() {
  return defineWorkflow({
    name: "scheduler-node-executor-nested-fanout",
    inputSchema: z.object({ items: z.array(z.string()), parallelism: z.number() }),
  }).build(({ input, step }) => {
    const prepare = step("prepare").task({
      input: null, exec: async () => ({ prefix: "root" }),
    });
    const combined = step("combine").parallel({
      maxConcurrency: input.parallelism,
      branches: {
        items() {
          const inner = step("inner_items").fanout({
            over: input.items,
            maxConcurrency: input.parallelism,
            do({ item, itemIndex }) {
              const task = step("inner_task").task({
                input: { prefix: prepare.output.prefix, item, itemIndex },
                exec: async ({ input }: { input: { prefix: string; item: string; itemIndex: number } }) => ({ value: `${input.prefix}-${input.item}-${input.itemIndex}` }),
              });
              return { value: task.output.value };
            },
          });
          return { values: inner.output };
        },
        sibling() {
          const task = step("sibling_task").task({
            input: { prefix: prepare.output.prefix },
            exec: async ({ input }: { input: { prefix: string } }) => ({ value: `${input.prefix}-sibling` }),
          });
          return { value: task.output.value };
        },
      },
    });
    return { values: combined.output.items.values, sibling: combined.output.sibling.value };
  });
}

export function parallelSignalConcurrencyWorkflow() {
  return defineWorkflow({
    name: "scheduler-node-executor-signal-local-concurrency",
  }).build(({ step }) => {
    const gate = step("gate").parallel({
      maxConcurrency: 1,
      branches: {
        left() {
          const approval = step("left_signal").signal({
            outputSchema: z.object({ ok: z.boolean() }),
            prompt: "left",
          });
          return { ok: approval.output.ok };
        },
        right() {
          const approval = step("right_signal").signal({
            outputSchema: z.object({ ok: z.boolean() }),
            prompt: "right",
          });
          return { ok: approval.output.ok };
        },
      },
    });
    return { gate: gate.output };
  });
}

export function rootFanoutTaskWorkflow(options: { strategy?: "all" | "quorum"; count?: number; maxConcurrency?: number; abortItem?: string; dynamicLimits?: boolean } = {}) {
  return defineWorkflow({
    name: "scheduler-node-executor-root-fanout",
    inputSchema: z.object({
      items: z.array(z.string()),
      quorum: z.number().default(options.count ?? 1),
      parallelism: z.number().default(options.maxConcurrency ?? 32),
    }),
  }).build(({ input, step }) => {
    if (options.strategy === "quorum") {
      step("items").fanout({
        over: input.items,
        strategy: "quorum",
        count: options.dynamicLimits ? input.quorum : options.count ?? 1,
        ...(options.dynamicLimits ? { maxConcurrency: input.parallelism } : options.maxConcurrency === undefined ? {} : { maxConcurrency: options.maxConcurrency }),
        do({ item, itemIndex }) {
          const task = step("item_task").task({
            input: { item, itemIndex, abortItem: options.abortItem ?? null },
            exec: async ({ input, abortSignal }) => {
              if (input.item !== input.abortItem) return { item: input.item, index: input.itemIndex };
              return await new Promise<{ item: string; index: number }>(resolve => {
                const timer = setTimeout(() => resolve({ item: "not-aborted", index: input.itemIndex }), 1_000);
                abortSignal.addEventListener("abort", () => {
                  clearTimeout(timer);
                  resolve({ item: input.item, index: input.itemIndex });
                }, { once: true });
              });
            },
          });
          return { item: task.output.item, index: task.output.index };
        },
      });
    } else {
      step("items").fanout({
        over: input.items,
        ...(options.dynamicLimits ? { maxConcurrency: input.parallelism } : options.maxConcurrency === undefined ? {} : { maxConcurrency: options.maxConcurrency }),
        do({ item, itemIndex }) {
          const task = step("item_task").task({
            input: { item, itemIndex, abortItem: options.abortItem ?? null },
            exec: async ({ input, abortSignal }) => {
              if (input.item !== input.abortItem) return { item: input.item, index: input.itemIndex };
              return await new Promise<{ item: string; index: number }>(resolve => {
                const timer = setTimeout(() => resolve({ item: "not-aborted", index: input.itemIndex }), 1_000);
                abortSignal.addEventListener("abort", () => {
                  clearTimeout(timer);
                  resolve({ item: input.item, index: input.itemIndex });
                }, { once: true });
              });
            },
          });
          return { item: task.output.item, index: task.output.index };
        },
      });
    }
    return {};
  });
}

export function rootLoopTaskWorkflow() {
  return defineWorkflow({
    name: "scheduler-node-executor-root-loop",
  }).build(({ step }) => {
    step("retry").loop({
      state: { done: false as boolean, iter: -1 },
      do({ index }) {
        const task = step("loop_task").task({
          input: { iter: index },
          exec: async ({ input }) => ({ done: input.iter >= 1, rawIter: input.iter }),
        });
        return {
          state: { done: task.output.done, iter: task.output.rawIter },
          stop: task.output.done,
        };
      },
    });
    return {};
  });
}

export function multiNodeRootLoopWorkflow() {
  return defineWorkflow({
    name: "scheduler-node-executor-root-loop-multi-node",
  }).build(({ step }) => {
    step("retry").loop({
      state: { done: false as boolean, value: "" },
      do({ index }) {
        const first = step("first_task").task({
          input: { iter: index },
          exec: async ({ input }) => ({ value: `first-${input.iter}` }),
        });
        const second = step("second_task").task({
          input: { iter: index, first: first.output.value },
          exec: async ({ input }) => ({ done: true, value: `${input.first}-second-${input.iter}` }),
        });
        return {
          state: { done: second.output.done, value: second.output.value },
          stop: second.output.done,
        };
      },
    });
    return {};
  });
}
