import * as Effect from "effect/Effect";
import { AgentTeamCommandFailure } from "./errors.js";
import { openTeamInspectionStore, type TeamInspectionStore } from "./store.js";
import type { TeamInspection } from "./types.js";

export function inspectAgentTeam(input: Readonly<{
  statePath: string;
  teamId: string;
  limit?: number;
}>): Effect.Effect<TeamInspection, AgentTeamCommandFailure> {
  return Effect.try({
    try: () => withInspectionStore(
      input.statePath,
      store => store.inspect(input.teamId, { limit: input.limit ?? 500 }),
    ),
    catch: cause => new AgentTeamCommandFailure(
      cause instanceof Error ? cause.message : String(cause),
      { cause },
    ),
  });
}

function withInspectionStore<T>(path: string, use: (store: TeamInspectionStore) => T): T {
  const store = openTeamInspectionStore(path);
  try {
    return use(store);
  } finally {
    store.close();
  }
}
