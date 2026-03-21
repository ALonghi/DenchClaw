import { mkdirSync, existsSync } from "node:fs";
import { resolve, normalize } from "node:path";
import { resolveFilesystemPath, resolveWorkspacePath, isProtectedSystemPath } from "@/lib/workspace";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/workspace/mkdir
 * Body: { path: string; absolute?: boolean }
 *
 * Creates a new directory. Absolute paths remain supported for the
 * directory picker flow; other workspace-facing file APIs are locked down.
 */
export async function POST(req: Request) {
  let body: { path?: string; absolute?: boolean };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { path: rawPath, absolute: useAbsolute } = body;
  if (!rawPath || typeof rawPath !== "string") {
    return Response.json(
      { error: "Missing 'path' field" },
      { status: 400 },
    );
  }

  const targetPath = useAbsolute && !rawPath.startsWith("/") && !rawPath.startsWith("~/")
    ? resolveFilesystemPath(resolve(normalize(rawPath)), { allowMissing: true })
    : useAbsolute
      ? resolveFilesystemPath(rawPath, { allowMissing: true })
      : resolveWorkspacePath(rawPath, { allowMissing: true });

  if (!targetPath) {
    return Response.json(
      { error: "Invalid path or path traversal rejected" },
      { status: 400 },
    );
  }

  if (isProtectedSystemPath(targetPath)) {
    return Response.json(
      { error: "Cannot create a protected system path" },
      { status: 403 },
    );
  }

  if (existsSync(targetPath.absolutePath)) {
    return Response.json(
      { error: "Directory already exists" },
      { status: 409 },
    );
  }

  try {
    mkdirSync(targetPath.absolutePath, { recursive: true });
    return Response.json({
      ok: true,
      path: targetPath.workspaceRelativePath != null
        ? targetPath.workspaceRelativePath
        : targetPath.absolutePath,
    });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "mkdir failed" },
      { status: 500 },
    );
  }
}
