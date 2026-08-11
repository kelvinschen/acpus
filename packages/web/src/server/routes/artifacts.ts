import { basename, extname } from "node:path";
import type { Context, Hono } from "hono";
import { readArtifact } from "@acpus/runtime";
import { apiError } from "../errors.js";
import type { WebWorkspaceContext } from "../workspace-context.js";

const artifactPreviewLimit = 128 * 1024;
const artifactHtmlCsp = [
  "sandbox allow-scripts",
  "default-src https: data: blob:",
  "script-src 'unsafe-inline' https: data: blob:",
  "style-src 'unsafe-inline' https: data: blob:",
  "connect-src https: data: blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

export function registerArtifactRoutes(app: Hono, workspaces: WebWorkspaceContext): void {
  app.get("/api/workspaces/:workspaceKey/runs/:id/artifacts/:artifactId/preview", async (context) => {
    const workspace = await workspaces.resolve(context.req.param("workspaceKey"));
    await workspaces.requireStoreReady(workspace.canonicalPath);
    const runId = context.req.param("id");
    const artifactId = context.req.param("artifactId");
    const verified = await readArtifact(workspace.canonicalPath, runId, artifactId);
    if (!verified) apiError(404, "artifact_not_found", `Artifact '${artifactId}' was not found.`);
    const { artifact, bytes } = verified;
    const previewBytes = bytes.subarray(0, artifactPreviewLimit);
    setArtifactResponseHeaders(context, artifact.path, artifact.mediaType, bytes.byteLength, {
      truncated: previewBytes.byteLength < bytes.byteLength,
    });
    return context.newResponse(Uint8Array.from(previewBytes));
  });

  app.get("/api/workspaces/:workspaceKey/runs/:id/artifacts/:artifactId/content", async (context) => {
    const workspace = await workspaces.resolve(context.req.param("workspaceKey"));
    await workspaces.requireStoreReady(workspace.canonicalPath);
    const runId = context.req.param("id");
    const artifactId = context.req.param("artifactId");
    const verified = await readArtifact(workspace.canonicalPath, runId, artifactId);
    if (!verified) apiError(404, "artifact_not_found", `Artifact '${artifactId}' was not found.`);
    const { artifact, bytes } = verified;
    setArtifactResponseHeaders(context, artifact.path, artifact.mediaType, bytes.byteLength, {
      fileName: safeArtifactFileName(artifact.path, artifact.id),
    });
    return context.newResponse(Uint8Array.from(bytes));
  });
}

function setArtifactResponseHeaders(
  context: Context,
  path: string,
  registeredMediaType: string | undefined,
  size: number,
  options: { truncated?: boolean; fileName?: string },
): void {
  const type = registeredMediaType ?? mediaType(path);
  context.header("content-type", type);
  context.header("cache-control", "no-store");
  context.header("x-content-type-options", "nosniff");
  context.header("referrer-policy", "no-referrer");
  context.header("x-acpus-artifact-size", String(size));
  if (options.truncated !== undefined) {
    context.header("x-acpus-artifact-truncated", String(options.truncated));
  }
  if (options.fileName !== undefined) {
    const encodedName = encodeURIComponent(options.fileName).replace(/[!'()*]/g, character =>
      `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
    );
    context.header("x-acpus-artifact-name", encodedName);
    context.header("content-disposition", `inline; filename*=UTF-8''${encodedName}`);
  }
  if (type.split(";", 1)[0]?.trim().toLowerCase() === "text/html") {
    context.header("content-security-policy", artifactHtmlCsp);
  }
}

function safeArtifactFileName(path: string, artifactId: string): string {
  const name = (basename(path) || artifactId).replace(/[\\/\u0000-\u001f\u007f]/g, "_");
  return name === "." || name === ".." || name.length === 0 ? "artifact" : name;
}

function mediaType(path: string): string {
  switch (extname(path).toLowerCase()) {
    case ".json": return "application/json; charset=utf-8";
    case ".html": return "text/html; charset=utf-8";
    case ".css": return "text/css; charset=utf-8";
    case ".js": return "text/javascript; charset=utf-8";
    case ".svg": return "image/svg+xml";
    case ".png": return "image/png";
    case ".jpg": case ".jpeg": return "image/jpeg";
    case ".md": case ".markdown": return "text/markdown; charset=utf-8";
    case ".txt": return "text/plain; charset=utf-8";
    default: return "application/octet-stream";
  }
}
