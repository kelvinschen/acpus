import { describe, expect, it } from "vitest";
import { buildSupervisorEnv } from "../../src/supervisor-discovery.js";

describe("buildSupervisorEnv", () => {
  it("passes through process env values without sensitive-prefix filtering", () => {
    const env = buildSupervisorEnv({
      PATH: "/usr/bin",
      AWS_ACCESS_KEY_ID: "aws-key",
      GCP_PROJECT: "gcp-project",
      GOOGLE_APPLICATION_CREDENTIALS: "/tmp/google.json",
      AZURE_CLIENT_ID: "azure-client",
      VAULT_ADDR: "https://vault.example",
      KUBERNETES_SERVICE_HOST: "127.0.0.1",
      DOCKER_HOST: "unix:///tmp/docker.sock",
      SSH_AUTH_SOCK: "/tmp/ssh.sock",
      GPG_TTY: "/dev/ttys001",
      PGPASSFILE: "/tmp/pgpass",
      UNDEFINED_VALUE: undefined
    });

    expect(env).toEqual({
      PATH: "/usr/bin",
      AWS_ACCESS_KEY_ID: "aws-key",
      GCP_PROJECT: "gcp-project",
      GOOGLE_APPLICATION_CREDENTIALS: "/tmp/google.json",
      AZURE_CLIENT_ID: "azure-client",
      VAULT_ADDR: "https://vault.example",
      KUBERNETES_SERVICE_HOST: "127.0.0.1",
      DOCKER_HOST: "unix:///tmp/docker.sock",
      SSH_AUTH_SOCK: "/tmp/ssh.sock",
      GPG_TTY: "/dev/ttys001",
      PGPASSFILE: "/tmp/pgpass"
    });
  });
});
