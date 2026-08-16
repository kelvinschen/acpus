import { fileURLToPath } from "node:url";
import type { NamedAcpAgentLaunchRegistry } from "@acpus/runtime/host";

export function createDshAgentLaunches(
  dshHome: string,
): NamedAcpAgentLaunchRegistry {
  const sourceMode = fileURLToPath(import.meta.url).endsWith(".ts");
  const entry = fileURLToPath(new URL(
    `./dsh-acp-agent-bin.${sourceMode ? "ts" : "js"}`,
    import.meta.url,
  ));
  const prefix = sourceMode
    ? [process.execPath, "--import", import.meta.resolve("tsx"), entry]
    : [process.execPath, entry];
  return Object.freeze({
    dsh: ({ model }) => [
      ...prefix,
      "--dsh-home",
      dshHome,
      ...(model === undefined ? [] : ["--model", model]),
    ],
  });
}
