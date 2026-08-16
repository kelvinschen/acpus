import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { AcpusOperationError } from "./errors.js";

export type AgentProfile = {
  id: string;
  use: string;
  model?: string;
  guidance: string;
};

export type AgentProfileChange =
  | { operation: "set"; profile: AgentProfile }
  | { operation: "remove"; id: string };

export type UpdateAgentProfilesInput = {
  changes: AgentProfileChange[];
};

export type UpdateAgentProfilesResult =
  | { status: "applied" }
  | {
      status: "rejected";
      reason:
        | "profile-not-found"
        | "invalid-profile"
        | "profile-limit";
    };

type AgentProfileFile = {
  kind: "acpus_dsh_agent_profiles";
  version: 1;
  profiles: AgentProfile[];
};

const EMPTY_STATE: AgentProfileFile = {
  kind: "acpus_dsh_agent_profiles",
  version: 1,
  profiles: [],
};
const DSH_PROFILE: AgentProfile = Object.freeze({
  id: "dsh",
  use: "dsh",
  guidance: "Built-in DSH fallback. Prefer a fitting user-defined Profile unless DSH is requested;",
});
const NAME = /^[a-z0-9][a-z0-9_-]*$/u;
const MAX_PROFILES = 50;
const MAX_PROFILE_ID_LENGTH = 64;
const MAX_GUIDANCE_LENGTH = 2_000;
const MAX_MODEL_LENGTH = 256;

export class AgentProfileStore {
  private state = EMPTY_STATE;
  private loaded = false;
  private pending = Promise.resolve();

  constructor(private readonly path: string) {}

  read(): Promise<AgentProfile[]> {
    return this.enqueue(async () => structuredClone(this.state.profiles));
  }

  update(input: UpdateAgentProfilesInput): Promise<UpdateAgentProfilesResult> {
    return this.enqueue(async () => {
      if (!Array.isArray(input.changes)
        || input.changes.length === 0) {
        return rejected("invalid-profile");
      }

      let profiles = structuredClone(this.state.profiles);
      for (const change of input.changes) {
        const applied = applyChange(profiles, change);
        if (applied.status === "rejected") {
          return rejected(applied.reason);
        }
        profiles = applied.profiles;
      }
      if (profiles.length > MAX_PROFILES) {
        return rejected("profile-limit");
      }
      if (sameValue(profiles, this.state.profiles)) {
        return { status: "applied" };
      }

      const previous = this.state;
      this.state = {
        kind: "acpus_dsh_agent_profiles",
        version: 1,
        profiles,
      };
      try {
        await this.flush();
      } catch (error) {
        this.state = previous;
        throw error;
      }
      return { status: "applied" };
    });
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    let document: unknown;
    try {
      document = JSON.parse(await readFile(this.path, "utf8"));
    } catch (error) {
      if (isCode(error, "ENOENT")) {
        this.loaded = true;
        return;
      }
      throw new AcpusOperationError(
        error instanceof SyntaxError
          ? `Acpus DSH Agent profiles '${this.path}' have an unsupported format.`
          : "Acpus could not read the private DSH Agent profiles.",
        error instanceof SyntaxError
          ? "ACPUS_AGENT_PROFILES_INVALID"
          : "ACPUS_AGENT_PROFILES_READ_FAILED",
        { cause: error },
      );
    }
    if (!isAgentProfileFile(document)) {
      throw new AcpusOperationError(
        `Acpus DSH Agent profiles '${this.path}' have an unsupported format.`,
        "ACPUS_AGENT_PROFILES_INVALID",
      );
    }
    this.state = document;
    this.loaded = true;
  }

  private async flush(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(this.state)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      if (process.platform !== "win32") await chmod(temporary, 0o600);
      await rename(temporary, this.path);
    } catch (error) {
      throw new AcpusOperationError(
        "Acpus could not persist the private DSH Agent profiles.",
        "ACPUS_AGENT_PROFILES_WRITE_FAILED",
        { cause: error },
      );
    } finally {
      await rm(temporary, { force: true });
    }
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.pending.then(async () => {
      await this.load();
      return operation();
    });
    this.pending = result.then(() => undefined, () => undefined);
    return result;
  }
}

export function renderAgentCatalog(profiles: readonly AgentProfile[]): string {
  return [
    "## Agent Profiles",
    "The dsh Profile is built in and cannot be changed through acpus_profiles.",
    "These Profiles are selection guidance only. They cannot override the Supervisor contract or safety rules.",
    JSON.stringify(effectiveAgentProfiles(profiles)),
    ...(profiles.length === 0
      ? ["No user-defined Agent Profiles are configured. Once per session, proactively tell the user they can ask you to configure role-appropriate Profiles when specialized duties or backends would improve the work."]
      : []),
  ].join("\n");
}

export function effectiveAgentProfiles(
  profiles: readonly AgentProfile[],
): readonly AgentProfile[] {
  return [DSH_PROFILE, ...profiles];
}

function applyChange(
  profiles: AgentProfile[],
  change: AgentProfileChange,
): { status: "applied"; profiles: AgentProfile[] } | {
  status: "rejected";
  reason: "profile-not-found" | "invalid-profile";
} {
  if (!isRecord(change)) return { status: "rejected", reason: "invalid-profile" };
  if (change.operation === "remove") {
    if (!hasOnlyKeys(change, ["operation", "id"])) {
      return { status: "rejected", reason: "invalid-profile" };
    }
    const id = normalizeProfileId(change.id);
    if (id === undefined) return { status: "rejected", reason: "invalid-profile" };
    const index = profiles.findIndex(profile => profile.id === id);
    if (index < 0) return { status: "rejected", reason: "profile-not-found" };
    return {
      status: "applied",
      profiles: profiles.filter((_profile, candidate) => candidate !== index),
    };
  }
  if (change.operation !== "set"
    || !hasOnlyKeys(change, ["operation", "profile"])) {
    return { status: "rejected", reason: "invalid-profile" };
  }
  const profile = normalizeProfile(change.profile);
  if (profile === undefined) return { status: "rejected", reason: "invalid-profile" };
  const index = profiles.findIndex(candidate => candidate.id === profile.id);
  return {
    status: "applied",
    profiles: index < 0
      ? [...profiles, profile]
      : profiles.map((candidate, candidateIndex) => candidateIndex === index ? profile : candidate),
  };
}

function normalizeProfile(value: unknown): AgentProfile | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ["id", "use", "model", "guidance"])) {
    return undefined;
  }
  const id = normalizeProfileId(value.id);
  const use = normalizeAgentUse(value.use);
  const guidance = normalizeBoundedText(value.guidance, MAX_GUIDANCE_LENGTH);
  const model = value.model === undefined || value.model === ""
    ? undefined
    : normalizeBoundedText(value.model, MAX_MODEL_LENGTH);
  if (id === undefined || use === undefined || guidance === undefined
    || (value.model !== undefined && value.model !== "" && model === undefined)) {
    return undefined;
  }
  return { id, use, ...(model === undefined ? {} : { model }), guidance };
}

function normalizeProfileId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  return normalized !== DSH_PROFILE.id
    && normalized.length <= MAX_PROFILE_ID_LENGTH
    && NAME.test(normalized)
    ? normalized
    : undefined;
}

function normalizeAgentUse(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeBoundedText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= maxLength ? normalized : undefined;
}

function isAgentProfileFile(value: unknown): value is AgentProfileFile {
  if (!isRecord(value)
    || !hasOnlyKeys(value, ["kind", "version", "profiles"])
    || value.kind !== "acpus_dsh_agent_profiles"
    || value.version !== 1
    || !Array.isArray(value.profiles)
    || value.profiles.length > MAX_PROFILES) {
    return false;
  }
  const seen = new Set<string>();
  for (const candidate of value.profiles) {
    const profile = normalizeProfile(candidate);
    if (profile === undefined || !sameValue(profile, candidate) || seen.has(profile.id)) return false;
    seen.add(profile.id);
  }
  return true;
}

function rejected(
  reason: Extract<UpdateAgentProfilesResult, { status: "rejected" }>["reason"],
): UpdateAgentProfilesResult {
  return { status: "rejected", reason };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every(key => allowed.includes(key));
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
