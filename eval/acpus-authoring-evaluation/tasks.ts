import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, readlink, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { task, z } from "acpus/core";

async function digestDirectory(root: string): Promise<string> {
  const hash = createHash("sha256");

  async function visit(directory: string, relativeDirectory = ""): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
      const relativePath = relativeDirectory
        ? `${relativeDirectory}/${entry.name}`
        : entry.name;
      const absolutePath = join(directory, entry.name);
      if (entry.isDirectory()) {
        hash.update(`directory\0${relativePath}\0`);
        await visit(absolutePath, relativePath);
      } else if (entry.isSymbolicLink()) {
        hash.update(`symlink\0${relativePath}\0${await readlink(absolutePath)}\0`);
      } else if (entry.isFile()) {
        hash.update(`file\0${relativePath}\0`);
        hash.update(await readFile(absolutePath));
        hash.update("\0");
      }
    }
  }

  await visit(root);
  return `sha256:${hash.digest("hex")}`;
}

function workspaceInstructions(agentKey: "pi" | "claude" | "traex"): string {
  const authoritativeSkillPath = agentKey === "claude"
    ? ".claude/skills/acpus/SKILL.md"
    : ".agents/skills/acpus/SKILL.md";
  const shadowSkillPath = agentKey === "claude"
    ? ".agents/skills/acpus/SKILL.md"
    : ".claude/skills/acpus/SKILL.md";

  return `# Acpus authoring evaluation workspace

- Work only inside this directory; do not inspect parent or sibling directories.
- Read and follow \`${authoritativeSkillPath}\` as the only authoritative Acpus skill path.
- Do not read the shadow copy at \`${shadowSkillPath}\`; it exists only for workspace-shape parity.
- Create the requested TypeScript workflow and only the minimal supporting files it needs.
- You may run \`acpus workflow check\` while authoring.
- Never run an authored workflow.
- Do not edit the copied skill files.
`;
}

export async function resolveIsolatedWorkspaceRoot(
  workspaceRoot: string,
  workspaceDir: string,
  skillSourcePath: string,
): Promise<string> {
  if (!isAbsolute(workspaceRoot)) {
    throw new Error("workspaceRoot must be an absolute path outside the workflow workspace and skill source.");
  }
  const [physicalRoot, physicalWorkspace, physicalSkillSource] = await Promise.all([
    physicalPath(workspaceRoot),
    physicalPath(workspaceDir),
    physicalPath(skillSourcePath),
  ]);
  if (pathsOverlap(physicalRoot, physicalWorkspace) || pathsOverlap(physicalRoot, physicalSkillSource)) {
    throw new Error("workspaceRoot must not contain or be contained by the workflow workspace or skill source.");
  }
  return physicalRoot;
}

async function physicalPath(path: string): Promise<string> {
  let cursor = resolve(path);
  const missing: string[] = [];
  while (true) {
    try {
      return resolve(await realpath(cursor), ...missing.reverse());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(cursor);
      if (parent === cursor) throw error;
      missing.push(basename(cursor));
      cursor = parent;
    }
  }
}

function pathsOverlap(left: string, right: string): boolean {
  return pathContains(left, right) || pathContains(right, left);
}

function pathContains(parent: string, child: string): boolean {
  const childPath = relative(parent, child);
  return childPath === "" || (childPath !== ".." && !childPath.startsWith(`..${sep}`) && !isAbsolute(childPath));
}

export const prepareEvaluationWorkspace = task.define({
  inputSchema: z.object({
    workspaceRoot: z.string(),
    workspaceDir: z.string(),
    skillSourcePath: z.string(),
    runId: z.string(),
    requirementId: z.string(),
    agentKey: z.enum(["pi", "claude", "traex"]),
    trial: z.number().int().positive(),
  }),
  exec: async ({ input }) => {
    const skillSourcePath = resolve(input.skillSourcePath);
    const workspaceRoot = await resolveIsolatedWorkspaceRoot(
      input.workspaceRoot,
      input.workspaceDir,
      skillSourcePath,
    );
    const workspacePath = resolve(
      workspaceRoot,
      input.runId,
      input.requirementId,
      input.agentKey,
      `trial-${input.trial}`,
    );
    await mkdir(dirname(workspacePath), { recursive: true });
    await mkdir(workspacePath);

    const agentsSkillRoot = join(workspacePath, ".agents", "skills");
    const claudeSkillRoot = join(workspacePath, ".claude", "skills");
    await mkdir(agentsSkillRoot, { recursive: true });
    await mkdir(claudeSkillRoot, { recursive: true });
    await cp(skillSourcePath, join(agentsSkillRoot, "acpus"), {
      recursive: true,
      force: false,
      errorOnExist: true,
      verbatimSymlinks: true,
    });
    await cp(skillSourcePath, join(claudeSkillRoot, "acpus"), {
      recursive: true,
      force: false,
      errorOnExist: true,
      verbatimSymlinks: true,
    });
    const instructions = workspaceInstructions(input.agentKey);
    await writeFile(join(workspacePath, "AGENTS.md"), instructions);
    await writeFile(join(workspacePath, "CLAUDE.md"), instructions);

    const agentsSkillPath = join(agentsSkillRoot, "acpus");
    const claudeSkillPath = join(claudeSkillRoot, "acpus");
    const [
      sourceDigest,
      agentsDigest,
      claudeDigest,
      skillFile,
      authoringFile,
      advancedAuthoringFile,
      signalAuthoringFile,
    ] = await Promise.all([
      digestDirectory(skillSourcePath),
      digestDirectory(agentsSkillPath),
      digestDirectory(claudeSkillPath),
      readFile(join(skillSourcePath, "SKILL.md"), "utf8"),
      readFile(join(skillSourcePath, "references", "authoring.md"), "utf8"),
      readFile(join(skillSourcePath, "references", "advanced-authoring.md"), "utf8"),
      readFile(join(skillSourcePath, "references", "signal-authoring.md"), "utf8"),
    ]);
    if (sourceDigest !== agentsDigest || sourceDigest !== claudeDigest) {
      throw new Error("Copied Acpus skill digests do not match the source skill.");
    }

    const skillVersion = /^\s*acpus-version:\s*["']?([^\s"']+)["']?\s*$/mu.exec(skillFile)?.[1] ?? null;
    const authoritativeSkillPath = input.agentKey === "claude"
      ? ".claude/skills/acpus/SKILL.md"
      : ".agents/skills/acpus/SKILL.md";
    const contextSize = (text: string) => ({
      bytes: Buffer.byteLength(text),
      words: text.trim().split(/\s+/u).length,
    });
    const skillContext = contextSize(skillFile);
    const authoringContext = contextSize(authoringFile);

    return {
      workspacePath,
      workspaceSeed: `${input.runId}:${input.requirementId}:${input.agentKey}:${input.trial}`,
      authoritativeSkillPath,
      skillVersion,
      skillCopies: {
        source: sourceDigest,
        agents: agentsDigest,
        claude: claudeDigest,
        identical: true,
      },
      defaultRouteContext: {
        bytes: skillContext.bytes + authoringContext.bytes,
        words: skillContext.words + authoringContext.words,
      },
      gatedRouteIncrements: {
        advancedAuthoring: contextSize(advancedAuthoringFile),
        signalAuthoring: contextSize(signalAuthoringFile),
      },
    };
  },
});
