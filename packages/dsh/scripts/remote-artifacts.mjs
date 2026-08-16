import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { relative, resolve } from "node:path";

const packageName = "@acpus/dsh";
const workspace = resolve(import.meta.dirname, "../../..");
const packageRoot = resolve(import.meta.dirname, "..");
const sourceRoot = resolve(packageRoot, "src/remote");
const outputRoot = resolve(packageRoot, "dist");
const artifacts = [
  {
    source: "generated.js",
    output: "typert.remote-client.js",
    generated: "js",
  },
  {
    source: "generated.d.ts",
    output: "typert.remote-client.d.ts",
    generated: "dts",
  },
  {
    source: "generated.d.ts.map",
    output: "typert.remote-client.d.ts.map",
    generated: "dtsMap",
  },
];

await main(process.argv[2]);

async function main(mode) {
  if (mode === "publish") {
    await publishArtifacts();
    return;
  }
  if (mode !== "generate" && mode !== "check") {
    console.error("Usage: node scripts/remote-artifacts.mjs <generate|check|publish>");
    process.exitCode = 2;
    return;
  }

  const generated = await generateArtifacts();
  if (mode === "generate") {
    await writeArtifacts(generated);
  } else {
    await checkArtifacts(generated);
  }
}

async function publishArtifacts() {
  const canonical = await Promise.all(artifacts.map(async artifact => ({
    artifact,
    content: await readCanonical(artifact),
  })));
  await mkdir(outputRoot, { recursive: true });
  await Promise.all(canonical.map(({ artifact, content }) =>
    writeFile(resolve(outputRoot, artifact.output), content)));
}

async function writeArtifacts(generated) {
  await mkdir(sourceRoot, { recursive: true });
  const changed = [];
  for (const artifact of artifacts) {
    const path = resolve(sourceRoot, artifact.source);
    const content = generated[artifact.generated];
    if (await readOptional(path) === content) continue;
    await writeFile(path, content);
    changed.push(artifact.source);
  }
  console.log(changed.length === 0
    ? "DSH Remote artifacts are current."
    : `Updated DSH Remote artifacts: ${changed.join(", ")}`);
}

async function checkArtifacts(generated) {
  const stale = [];
  for (const artifact of artifacts) {
    const content = await readOptional(resolve(sourceRoot, artifact.source));
    if (content !== generated[artifact.generated]) stale.push(artifact.source);
  }
  if (stale.length === 0) {
    console.log("DSH Remote artifacts are current.");
    return;
  }
  console.error([
    `DSH Remote artifacts are stale: ${stale.join(", ")}`,
    "Run `pnpm --filter @acpus/dsh remote:generate` and commit the result.",
  ].join("\n"));
  process.exitCode = 1;
}

async function generateArtifacts() {
  const {
    FaceModelEmitter,
    WorkspaceAnalyzer,
  } = await import("@deepseek-ai/dsh-typert-generator");
  const temporaryRoot = await mkdtemp(resolve(workspace, "packages/.dsh-typert-"));
  try {
    const manifest = JSON.parse(await readFile(resolve(packageRoot, "package.json"), "utf8"));
    manifest.exports = Object.fromEntries(
      Object.entries(manifest.exports).map(([subpath, target]) => [
        subpath,
        sourceExport(target),
      ]),
    );
    await Promise.all([
      cp(resolve(packageRoot, "src"), resolve(temporaryRoot, "src"), {
        recursive: true,
      }),
      cp(
        resolve(packageRoot, "tsconfig.json"),
        resolve(temporaryRoot, "tsconfig.json"),
      ),
      symlink(resolve(packageRoot, "node_modules"), resolve(temporaryRoot, "node_modules")),
      writeFile(
        resolve(temporaryRoot, "typert-protocol.d.ts"),
        `declare module "@deepseek-ai/dsh-typert-protocol" {
  import { Service, type Context } from "@deepseek-ai/cordis";

  export interface TypertLookup<Host, Wire> {
    readonly host: Host;
    readonly wire: Wire;
  }
  export interface TypertContext<Wire> {
    readonly wire: Wire;
  }
  export interface TypertLookupMap {}
  export interface TypertContextMap {}
  export interface TypertRemoteMap {}
  export interface TypertRemoteScopeMap {}

  export abstract class TypertRemoteService<T = never> extends Service<T> {
    readonly typertRemote: {
      readonly service: TypertRemoteService<T>;
      readonly serviceKey: string;
      readonly namespace: string;
    };
    protected constructor(
      ctx: Context,
      serviceKey: string,
      options?: { readonly namespace?: string },
    );
  }

  export function Remote<This extends object, Args extends unknown[], Result>(
    method: (this: This, ...args: Args) => Result,
    context: ClassMethodDecoratorContext<This, (this: This, ...args: Args) => Result>,
  ): void;
}
`,
      ),
      writeFile(
        resolve(temporaryRoot, "package.json"),
        `${JSON.stringify(manifest, null, 2)}\n`,
      ),
      writeFile(
        resolve(temporaryRoot, "tsconfig.host.json"),
        `${JSON.stringify({
          extends: "./tsconfig.json",
          files: [],
          references: [{ path: "./tsconfig.json" }],
        }, null, 2)}\n`,
      ),
    ]);
    const temporaryConfigPath = resolve(temporaryRoot, "tsconfig.json");
    const temporaryConfig = JSON.parse(await readFile(temporaryConfigPath, "utf8"));
    temporaryConfig.include = ["src/**/*.ts", "src/**/*.tsx"];
    temporaryConfig.exclude = ["src/client/**", "src/remote/generated.*"];
    temporaryConfig.compilerOptions = {
      ...temporaryConfig.compilerOptions,
      lib: ["ES2022", "DOM"],
      paths: {
        "@deepseek-ai/dsh-typert-protocol": ["./typert-protocol.d.ts"],
      },
    };
    await writeFile(
      temporaryConfigPath,
      `${JSON.stringify(temporaryConfig, null, 2)}\n`,
    );

    const analyzed = new WorkspaceAnalyzer({
      root: workspace,
      hostConfig: relative(workspace, resolve(temporaryRoot, "tsconfig.host.json")),
      faces: ["host"],
      packages: [packageName],
      checkDiagnostics: false,
    }).analyze();
    const host = analyzed.faces.find(face => face.face === "host");
    if (host === undefined) throw new Error("Typert did not analyze the Host face.");
    const generated = new FaceModelEmitter(host).emit(packageName);
    if (generated.remote === undefined) {
      const model = host.packages.find(candidate => candidate.name === packageName);
      throw new Error(
        `@acpus/dsh declared no generated Remote methods (${String(model?.invocations.length ?? 0)} invocations).`,
      );
    }
    return {
      ...generated.remote,
      js: generated.remote.js.replaceAll(
        relative(workspace, temporaryRoot),
        "packages/dsh",
      ),
    };
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function readCanonical(artifact) {
  const path = resolve(sourceRoot, artifact.source);
  try {
    return await readFile(path);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    throw new Error(
      `Missing DSH Remote artifact src/remote/${artifact.source}. Run \`pnpm --filter @acpus/dsh remote:generate\`.`,
      { cause: error },
    );
  }
}

async function readOptional(path) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

function sourceExport(target) {
  if (
    target !== null
    && typeof target === "object"
    && !Array.isArray(target)
    && typeof target.development === "string"
  ) {
    return target.development;
  }
  return target;
}
