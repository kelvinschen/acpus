# Signal Authoring

Use Signal nodes for external input that may arrive after the run starts. For the `runs signal` command, read `cli-operations.md`.

```ts
const approval = step("approval").signal({
  outputSchema: z.object({ approved: z.boolean(), note: z.string().default("") }),
  prompt: template`Approve ${input.changeId}?`,
  timeout: "2d",
  onTimeout: { message: "approval timed out" },
});
```

## Contracts

| Case | Current behavior |
| --- | --- |
| Schema-backed | `--payload` is JSON validated against `outputSchema`. Invalid input mutates nothing and leaves the same wait open; there is no Agent-style repair turn. |
| Schema-less | Output is a raw string, so `--payload` must itself be a JSON string such as `'"approved"'`. |
| `parallel` all | Independent waits can be open concurrently; the branch group completes only after all succeed. |
| `parallel` race | The first successful branch wins and remaining branches are canceled. |
| Timeout | Expiry closes the wait with `signal_timeout` and fails its ancestors. `onTimeout.message` only changes the failure message; it does not return fallback output. |
| Pause/resume | Pause suspends the remaining Signal timeout budget; resume restores it. |

Concurrent waits do not provide participant identity, access control, confidentiality, sealed answers, commit/reveal fairness, or privacy. Add those guarantees outside Acpus when required.

Durations accept integer milliseconds with optional `ms`, `s`, `m`, `h`, or `d`; omitted units mean milliseconds. Weeks (`w`) are not supported. The shared grammar also applies to Agent/Task timeouts and Task command timeouts.

For a compact checked concurrent-wait pattern, use [`parallel-approvals`](../workflows/examples/parallel-approvals/workflow.ts).
