import { existsSync, statSync } from "node:fs";
import { basename } from "node:path";
import { safeResolvePath } from "@/lib/workspace";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/workspace/path-info?path=...
 * Resolves and inspects a workspace path for in-app preview routing.
 */
export async function GET(req: Request) {
	const url = new URL(req.url);
	const rawPath = url.searchParams.get("path");

	if (!rawPath) {
		return Response.json(
			{ error: "Missing 'path' query parameter" },
			{ status: 400 },
		);
	}

	const resolvedPath = safeResolvePath(rawPath);
	if (!resolvedPath) {
		return Response.json(
			{ error: "Path not found or path traversal rejected" },
			{ status: 404 },
		);
	}

	if (!existsSync(resolvedPath)) {
		return Response.json(
			{ error: "Path not found", path: resolvedPath },
			{ status: 404 },
		);
	}

	try {
		const stat = statSync(resolvedPath);
		const type = stat.isDirectory()
			? "directory"
			: stat.isFile()
				? "file"
				: "other";

		return Response.json({
			path: resolvedPath,
			name: basename(resolvedPath) || resolvedPath,
			type,
		});
	} catch {
		return Response.json(
			{ error: "Cannot stat path", path: resolvedPath },
			{ status: 500 },
		);
	}
}
