import { lstat, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { officialAuthoringEnvironment } from "@acpus/loader";
import type { JsonValue } from "@acpus/expression/ir";
import { getCliPackageInfo } from "./package-info.js";
import { existingSkillRootTargets, readAcpusSkillMetadata, type SkillAgent, type SkillScope } from "./skill-installation.js";

type HealthStatus = "ok" | "warn" | "fail";

export type AuthoringHealthCheck = {
  area: "authoring" | "skill";
  status: HealthStatus;
  message: string;
  details?: Record<string, JsonValue>;
};

type SkillStatus = "aligned" | "stale" | "unversioned" | "invalid";
type InstalledSkillStatus = "aligned" | "stale" | "unversioned" | "missing" | "conflict" | "unreadable";

export type InstalledAcpusSkill = {
  scope: SkillScope;
  agent: SkillAgent;
  path: string;
  version?: string;
  status: InstalledSkillStatus;
};

export type AuthoringEnvironment = {
  cli: {
    version: string;
    entry: string;
    packageRoot: string;
  };
  imports: ReturnType<typeof officialAuthoringEnvironment>["imports"];
  skills: {
    bundled: {
      path: string;
      version?: string;
      status: SkillStatus;
    };
    installed: Array<InstalledAcpusSkill & { remediation?: string }>;
  };
};

export type AuthoringHealth = {
  ok: boolean;
  environment: AuthoringEnvironment;
  checks: AuthoringHealthCheck[];
};

export async function getAuthoringHealth(cwd: string): Promise<AuthoringHealth> {
  const cli = getCliPackageInfo();
  const authority = officialAuthoringEnvironment();
  const checks: AuthoringHealthCheck[] = [];
  const manifest = JSON.parse(await readFile(`${cli.packageRoot}/package.json`, "utf8")) as { dependencies?: Record<string, string> };
  const mismatches = Object.values(authority.imports).flatMap(info => {
    const expected = manifest.dependencies?.[info.package];
    return expected && !expected.startsWith("workspace:") && expected !== info.version
      ? [{ package: info.package, expected, actual: info.version }]
      : [];
  });
  checks.push(mismatches.length === 0
    ? { area: "authoring", status: "ok", message: "Authoring packages resolved." }
    : {
        area: "authoring",
        status: "fail",
        message: "Resolved authoring package versions do not match the acpus package manifest.",
        details: { mismatches },
      });

  const bundledPath = fileURLToPath(new URL("../skills/acpus", import.meta.url));
  const bundled = await bundledSkill(bundledPath, cli.version);
  checks.push({
    area: "skill",
    status: bundled.status === "aligned" ? "ok" : "fail",
    message: bundled.status === "aligned"
      ? `Bundled Acpus skill ${cli.version} is aligned.`
      : `Bundled Acpus skill is ${bundled.status}; expected ${cli.version}.`,
    details: { path: bundled.path, status: bundled.status, ...(bundled.version ? { version: bundled.version } : {}) },
  });

  const installed = await inspectInstalledAcpusSkills(cwd, homedir(), cli.version);
  const doctorInstalled = installed.map(installedSkill => {
    const remediation = `acpus skill install --${installedSkill.scope} --agent ${installedSkill.agent}`;
    const needsRepair = installedSkill.status !== "aligned" && installedSkill.status !== "missing";
    if (needsRepair) {
      checks.push({
        area: "skill",
        status: "warn",
        message: `Installed ${installedSkill.agent} Acpus skill is ${installedSkill.status}; run '${remediation}'.`,
        details: {
          path: installedSkill.path,
          scope: installedSkill.scope,
          agent: installedSkill.agent,
          status: installedSkill.status,
          remediation,
        },
      });
    }
    return {
      ...installedSkill,
      ...(needsRepair ? { remediation } : {}),
    };
  });

  return {
    ok: checks.every(check => check.status !== "fail"),
    environment: {
      cli: { version: cli.version, entry: cli.entry, packageRoot: cli.packageRoot },
      imports: authority.imports,
      skills: { bundled, installed: doctorInstalled },
    },
    checks,
  };
}

export async function inspectInstalledAcpusSkills(
  cwd: string,
  home: string,
  expectedVersion: string,
): Promise<InstalledAcpusSkill[]> {
  const targets = await existingSkillRootTargets(cwd, home, ["project", "global"]);
  return Promise.all(targets.map(async target => ({
    scope: target.scope,
    agent: target.agent,
    path: target.targetPath,
    ...(await installedSkill(target.targetPath, expectedVersion)),
  })));
}

async function bundledSkill(path: string, expectedVersion: string): Promise<AuthoringEnvironment["skills"]["bundled"]> {
  try {
    const metadata = await readAcpusSkillMetadata(path);
    const status: SkillStatus = metadata.name !== "acpus"
      ? "invalid"
      : metadata.version === undefined
        ? "unversioned"
        : metadata.version === expectedVersion
          ? "aligned"
          : "stale";
    return { path, ...(metadata.version ? { version: metadata.version } : {}), status };
  } catch {
    return { path, status: "invalid" };
  }
}

async function installedSkill(path: string, expectedVersion: string): Promise<{ version?: string; status: InstalledSkillStatus }> {
  try {
    const stats = await lstat(path);
    if (!stats.isDirectory() && !stats.isSymbolicLink()) return { status: "conflict" };
  } catch (error) {
    return isNotFound(error) ? { status: "missing" } : { status: "unreadable" };
  }
  try {
    const metadata = await readAcpusSkillMetadata(path);
    if (metadata.name !== "acpus") return { status: "conflict" };
    if (metadata.version === undefined) return { status: "unversioned" };
    return { version: metadata.version, status: metadata.version === expectedVersion ? "aligned" : "stale" };
  } catch {
    return { status: "unreadable" };
  }
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error
    && (error.code === "ENOENT" || error.code === "ENOTDIR");
}
