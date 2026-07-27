import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const webRoot = join(root, "packages", "web");
const typescriptCli = packageBin(createRequire(join(root, "package.json")), "typescript", "tsc");
const viteCli = packageBin(createRequire(join(webRoot, "package.json")), "vite", "vite");

const client = {
  stage: "client",
  file: process.execPath,
  args: [viteCli, "build", "--config", "vite.config.ts"],
  cwd: webRoot,
};
const staticVisualization = {
  stage: "static-viz",
  file: process.execPath,
  args: [join(webRoot, "scripts", "build-static-viz.mjs")],
  cwd: webRoot,
};
const profiles = {
  workspace: {
    foundation: {
      stage: "foundation",
      file: process.execPath,
      args: [typescriptCli, "-b", "tsconfig.build.foundation.json"],
      cwd: root,
    },
    typescript: {
      stage: "typescript",
      file: process.execPath,
      args: [typescriptCli, "-b", "tsconfig.build.json"],
      cwd: root,
    },
  },
  package: {
    typescript: {
      stage: "typescript",
      file: process.execPath,
      args: [typescriptCli, "-b", "tsconfig.build.json"],
      cwd: webRoot,
    },
  },
};

export function createBuildRunner(runStep) {
  return async function runBuild(profile) {
    const plan = profiles[profile];
    if (plan === undefined) throw new Error(`Unknown build profile: ${profile}`);

    if (plan.foundation !== undefined) {
      throwFailures([await start(runStep, plan.foundation)]);
    }

    const clientResult = start(runStep, client);
    const staticVisualizationResult = await start(runStep, staticVisualization);
    if (!staticVisualizationResult.ok) {
      return throwFailures([await clientResult, staticVisualizationResult]);
    }

    const typescriptResult = start(runStep, plan.typescript);
    throwFailures(await Promise.all([clientResult, typescriptResult]));
  };
}

export const runBuild = createBuildRunner(runStep);

function start(execute, step) {
  try {
    return settle(execute(step), step.stage);
  } catch (error) {
    return Promise.resolve({ ok: false, stage: step.stage, error });
  }
}

function settle(promise, stage) {
  return Promise.resolve(promise).then(
    () => ({ ok: true, stage }),
    error => ({ ok: false, stage, error }),
  );
}

function throwFailures(results) {
  const failures = results.filter(result => !result.ok);
  if (failures.length === 1) throw failures[0].error;
  if (failures.length > 1) {
    throw new AggregateError(
      failures.map(failure => failure.error),
      `Build stages failed: ${failures.map(failure => failure.stage).join(", ")}`,
    );
  }
}

function runStep(step) {
  return new Promise((resolve, reject) => {
    const child = spawn(step.file, step.args, { cwd: step.cwd, stdio: "inherit" });
    child.once("error", error => {
      reject(new Error(`${step.stage} build could not start`, { cause: error }));
    });
    child.once("close", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${step.stage} build ${signal ? `terminated by ${signal}` : `exited with ${code}`}`));
    });
  });
}

function packageBin(requireFrom, packageName, binName) {
  const manifestPath = requireFrom.resolve(`${packageName}/package.json`);
  const manifest = requireFrom(manifestPath);
  const bin = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.[binName];
  if (bin === undefined) throw new Error(`${packageName} does not provide the ${binName} executable`);
  return join(dirname(manifestPath), bin);
}
