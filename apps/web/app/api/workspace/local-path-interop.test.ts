import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("node:fs", () => ({
	existsSync: vi.fn(() => true),
	statSync: vi.fn(() => ({ isDirectory: () => false, isFile: () => true })),
	readFileSync: vi.fn(() => Buffer.from("hello")),
}));

vi.mock("node:child_process", () => ({
	execFile: vi.fn((_file: string, _args: string[], callback: (err: Error | null, stdout?: string, stderr?: string) => void) => {
		callback(null, "", "");
	}),
}));

vi.mock("@/lib/workspace", () => ({
	resolveWorkspacePath: vi.fn(),
}));

describe("Workspace absolute-path interoperability", () => {
	beforeEach(() => {
		vi.resetModules();
		vi.mock("node:fs", () => ({
			existsSync: vi.fn(() => true),
			statSync: vi.fn(() => ({ isDirectory: () => false, isFile: () => true })),
			readFileSync: vi.fn(() => Buffer.from("hello")),
		}));
		vi.mock("node:child_process", () => ({
			execFile: vi.fn((_file: string, _args: string[], callback: (err: Error | null, stdout?: string, stderr?: string) => void) => {
				callback(null, "", "");
			}),
		}));
		vi.mock("@/lib/workspace", () => ({
			resolveWorkspacePath: vi.fn(),
		}));
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("allows path-info for absolute paths that are still inside the workspace", async () => {
		const { resolveWorkspacePath } = await import("@/lib/workspace");
		vi.mocked(resolveWorkspacePath).mockReturnValueOnce({
			absolutePath: "/ws/docs/spec.md",
			kind: "absolute",
			withinWorkspace: true,
			workspaceRelativePath: "docs/spec.md",
		});

		const { GET } = await import("./path-info/route.js");
		const res = await GET(new Request("http://localhost/api/workspace/path-info?path=%2Fws%2Fdocs%2Fspec.md"));
		expect(res.status).toBe(200);
		await expect(res.json()).resolves.toEqual({
			path: "/ws/docs/spec.md",
			name: "spec.md",
			type: "file",
		});
	});

	it("allows browse-file reads for absolute paths that remain inside the workspace", async () => {
		const { resolveWorkspacePath } = await import("@/lib/workspace");
		vi.mocked(resolveWorkspacePath).mockReturnValueOnce({
			absolutePath: "/ws/assets/image.png",
			kind: "absolute",
			withinWorkspace: true,
			workspaceRelativePath: "assets/image.png",
		});

		const { GET } = await import("./browse-file/route.js");
		const res = await GET(new Request("http://localhost/api/workspace/browse-file?path=%2Fws%2Fassets%2Fimage.png&raw=true"));
		expect(res.status).toBe(200);
		expect(res.headers.get("Content-Type")).toBe("image/png");
	});

	it("allows open-file for absolute paths that remain inside the workspace", async () => {
		const { resolveWorkspacePath } = await import("@/lib/workspace");
		vi.mocked(resolveWorkspacePath).mockReturnValueOnce({
			absolutePath: "/ws/docs/spec.md",
			kind: "absolute",
			withinWorkspace: true,
			workspaceRelativePath: "docs/spec.md",
		});
		const { execFile } = await import("node:child_process");

		const { POST } = await import("./open-file/route.js");
		const res = await POST(new Request("http://localhost/api/workspace/open-file", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ path: "/ws/docs/spec.md" }),
		}));

		expect(res.status).toBe(200);
		if (process.platform === "darwin") {
			expect(execFile).toHaveBeenCalledWith("open", ["/ws/docs/spec.md"], expect.any(Function));
		} else if (process.platform === "linux") {
			expect(execFile).toHaveBeenCalledWith("xdg-open", ["/ws/docs/spec.md"], expect.any(Function));
		}
	});
});
