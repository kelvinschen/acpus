import { lstat, readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { officialAuthoringEnvironment } from "@acpus/loader";
import { getCliPackageInfo } from "../platform/package-info.js";
import { readAcpusSkillMetadata } from "../skill/content.js";

type SkillScope = "project" | "global";
type SkillAgent = "universal" | "claude";

type HealthStatus = "ok" | "warn" | "fail";
const authoringSpecifiers = ["acpus/core", "acpus/expression", "acpus/tasks/git"] as const;

export type AuthoringHealthCheck = {
  area: "authoring" | "skill";
  status: HealthStatus;
  message: string;
};

type InstalledAcpusSkill = {
  scope: SkillScope;
  agent: SkillAgent;
};

export type AuthoringTypeLocation = {
  specifier: keyof ReturnType<typeof officialAuthoringEnvironment>["imports"];
  typesPath: string;
};

type AuthoringHealth = {
  checks: AuthoringHealthCheck[];
  types: AuthoringTypeLocation[];
};

export async function getAuthoringHealth(cwd: string): Promise<AuthoringHealth> {
  const cli = getCliPackageInfo();
  const authority = officialAuthoringEnvironment();
  const checks: AuthoringHealthCheck[] = [];
  const manifest = JSON.parse(await readFile(`${cli.packageRoot}/package.json`, "utf8")) as { dependencies?: Record<string, string> };
  const versionsAligned = Object.values(authority.imports).every(info => {
    const expected = manifest.dependencies?.[info.package];
    return expected === undefined || expected.startsWith("workspace:") || expected === info.version;
  });
  checks.push(versionsAligned
    ? { area: "authoring", status: "ok", message: "Authoring packages resolved." }
    : {
        area: "authoring",
        status: "fail",
        message: "Resolved authoring package versions do not match the acpus package manifest.",
      });

  const installed = await staleInstalledAcpusSkills(cwd, homedir(), cli.version);
  for (const installedSkill of installed) {
    checks.push({
      area: "skill",
      status: "warn",
      message: `Installed ${installedSkill.scope} ${installedSkill.agent} Acpus skill is stale; replace it with the router skill using 'npx skills add kelvinschen/acpus'.`,
    });
  }

  return {
    checks,
    types: authoringSpecifiers.map(specifier => ({
      specifier,
      typesPath: authority.imports[specifier].typesPath,
    })),
  };
}

async function staleInstalledAcpusSkills(
  cwd: string,
  home: string,
  expectedVersion: string,
): Promise<InstalledAcpusSkill[]> {
  const targets = (["project", "global"] as const).flatMap(scope =>
    (["universal", "claude"] as const).map(agent => {
      const base = scope === "project" ? cwd : home;
      return {
        scope,
        agent,
        targetPath: join(base, agent === "universal" ? ".agents" : ".claude", "skills", "acpus"),
      };
    }));
  const checked = await Promise.all(targets.map(async target => ({
    target,
    canonicalPath: await staleInstalledSkillPath(target.targetPath, expectedVersion),
  })));
  const seen = new Set<string>();
  return checked.flatMap(({ target, canonicalPath }) => {
    if (canonicalPath === undefined || seen.has(canonicalPath)) return [];
    seen.add(canonicalPath);
    return [{ scope: target.scope, agent: target.agent }];
  });
}

async function staleInstalledSkillPath(path: string, expectedVersion: string): Promise<string | undefined> {
  try {
    const stats = await lstat(path);
    if (!stats.isDirectory() && !stats.isSymbolicLink()) return undefined;
    const metadata = await readAcpusSkillMetadata(path);
    const stale = metadata.name === "acpus"
      && metadata.version !== undefined
      && metadata.version !== expectedVersion;
    return stale ? await realpath(path) : undefined;
  } catch {
    return undefined;
  }
}
