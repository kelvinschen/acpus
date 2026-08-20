# Legacy Deletion Map

A migration work package is incomplete when it adds the Effect path but leaves
the superseded architecture alive without a named downstream dependency.

This map gives the expected deletion owner. Exact symbols are verified when the
Master compiles the execution packet.

| WP | Legacy expected to disappear when boundary is complete |
| --- | --- |
| A02 | neverthrow `Result` in migrated pure core/shared value code; replace with direct value/domain ADT/Effect `Either` or `Option` only where useful |
| A03 | `ResultAsync`/neverthrow in frozen runtime API/error vocabulary owned by A03 |
| A04 | `ResultAsync`/neverthrow in ACP/agent API/error vocabulary owned by A04 |
| A05 | peripheral neverthrow imports and dependencies in completed packages |
| B01 | store-facing Result wrappers whose sole purpose was effectful error transport; duplicate open/close adapter helpers made obsolete by RuntimeStore Effect boundary |
| B02 | duplicated raw process/AbortSignal bridge helpers superseded by the process adapter |
| B03 | duplicated ACP SDK Promise/callback/AbortSignal wrappers superseded by ACP adapter |
| C01 | hook timer/listener/manual process cleanup state superseded by scoped lifecycle |
| C02 | ProcessCapsule ready/closed deferred-Promise plumbing, cleanup Promise/timer registries and raw lifecycle helpers that no longer own semantics |
| C03 | ACP session/reverse-RPC manual close/drain/pending-resource lifetime plumbing superseded by Scope ownership |
| C04 | supervisor Promise guard/drain ownership structures superseded by structured session ownership |
| C05 | Workspace `closePromise`, active tick/heartbeat Promise fields, timer ownership and duplicate cleanup graph superseded by Workspace Scope |
| D01 | hand-rolled scheduler deferred/version wait implementation if native design fully preserves wake semantics; Promise-tail mutation serializer |
| D02 | active execution settlement Promise registry and per-attempt application AbortController ownership superseded by scoped Fibers/adapter bridge |
| D03 | application scheduler `setTimeout`/`setInterval` timing and manual Promise races superseded by Effect time/concurrency |
| D04 | shutdown/control Promise drain/abort glue superseded by structured interruption + durable control bridge |
| E01 | remaining public/internal ResultAsync and transitional Promise adapters not intentionally at plain-JS boundaries |
| E02 | neverthrow package entries/lockfile records; unused compatibility helpers; migration-only duplicate services/errors; obsolete timeout/deferred utilities |

## Deletion discipline

- Delete in the same WP when no downstream consumer requires the legacy symbol.
- If a downstream WP still requires it, name that WP in the execution packet and
  delete at the earliest shared boundary completion.
- Do not rename legacy code to `legacy*`, hide it behind a facade, or leave
  commented copies.
- Do not add compatibility tests for abstractions whose intended state is
  deletion.
- E02 is a safety net, not permission to defer obvious cleanup from earlier WPs.

Final repository searches must show zero `neverthrow` and `ResultAsync`, and all
remaining raw Promise/timer/Abort/process occurrences must be intentional
adapter/entrypoint/platform cases reviewed under the quality gates.
