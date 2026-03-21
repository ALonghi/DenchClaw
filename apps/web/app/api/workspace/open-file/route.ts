import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import { resolveWorkspacePath } from "@/lib/workspace";

const execFileAsync = promisify(execFile);

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/workspace/open-file
 * Opens a workspace file or directory using the system's default application.
 * On macOS this uses `open`, on Linux `xdg-open`.
 */
export async function POST(req: Request) {
	let body: { path?: string; reveal?: boolean };
	try {
		body = await req.json();
	} catch {
		return Response.json(
			{ error: "Invalid JSON body" },
			{ status: 400 },
		);
	}

	const rawPath = body.path;
	if (!rawPath || typeof rawPath !== "string") {
		return Response.json(
			{ error: "Missing 'path' in request body" },
			{ status: 400 },
		);
	}

	const resolvedPath = resolveWorkspacePath(rawPath);
	if (!resolvedPath) {
		return Response.json(
			{ error: "File not found or path traversal rejected" },
			{ status: 404 },
		);
	}
	const resolved = resolvedPath.absolutePath;

	if (!existsSync(resolved)) {
		return Response.json(
			{ error: "File not found", path: resolved },
			{ status: 404 },
		);
	}

	const platform = process.platform;
	const reveal = body.reveal === true;

	if (platform === "darwin") {
		const args = reveal ? ["-R", resolved] : [resolved];
		try {
			await execFileAsync("open", args);
			return Response.json({ ok: true, path: resolved });
		} catch (error) {
			return Response.json(
				{ error: `Failed to open file: ${error instanceof Error ? error.message : String(error)}` },
				{ status: 500 },
			);
		}
	} else if (platform === "linux") {
		try {
			await execFileAsync("xdg-open", [resolved]);
			return Response.json({ ok: true, path: resolved });
		} catch (error) {
			return Response.json(
				{ error: `Failed to open file: ${error instanceof Error ? error.message : String(error)}` },
				{ status: 500 },
			);
		}
	} else {
		return Response.json(
			{ error: `Unsupported platform: ${platform}` },
			{ status: 400 },
		);
	}
}
