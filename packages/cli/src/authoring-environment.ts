import { lstat, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { officialAuthoringEnvironment } from "@acpus/loader";
import { getCliPackageInfo } from "./package-info.js";
import { readAcpusSkillMetadata } from "./skill-content.js";
import { existingSkillRootTargets, type SkillAgent, type SkillScope } from "./skill-installation.js";

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
    const remediation = `acpus skill install --${installedSkill.scope} --agent ${installedSkill.agent}`;
    checks.push({
      area: "skill",
      status: "warn",
      message: `Installed ${installedSkill.agent} Acpus skill is stale; run '${remediation}'.`,
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
  const targets = await existingSkillRootTargets(cwd, home, ["project", "global"]);
  const stale = await Promise.all(targets.map(async target => ({
    target,
    stale: await installedSkillIsStale(target.targetPath, expectedVersion),
  })));
  return stale.flatMap(({ target, stale }) => stale
    ? [{ scope: target.scope, agent: target.agent }]
    : []);
}

async function installedSkillIsStale(path: string, expectedVersion: string): Promise<boolean> {
  try {
    const stats = await lstat(path);
    if (!stats.isDirectory() && !stats.isSymbolicLink()) return false;
    const metadata = await readAcpusSkillMetadata(path);
    return metadata.name === "acpus"
      && metadata.version !== undefined
      && metadata.version !== expectedVersion;
  } catch {
    return false;
  }
}
