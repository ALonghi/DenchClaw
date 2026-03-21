import { EventEmitter } from "node:events";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const lookupMock = vi.fn();
const httpRequestMock = vi.fn();

vi.mock("node:dns/promises", () => ({
	lookup: lookupMock,
}));

vi.mock("node:http", () => ({
	request: httpRequestMock,
}));

vi.mock("node:https", () => ({
	request: vi.fn(),
}));

function makeUpstreamResponse(init: {
	statusCode?: number;
	statusMessage?: string;
	headers?: Record<string, string>;
	body?: string;
}) {
	const res = new EventEmitter() as EventEmitter & {
		statusCode?: number;
		statusMessage?: string;
		headers: Record<string, string>;
	};
	res.statusCode = init.statusCode ?? 200;
	res.statusMessage = init.statusMessage ?? "OK";
	res.headers = init.headers ?? {};
	queueMicrotask(() => {
		if (init.body) {
			res.emit("data", Buffer.from(init.body));
		}
		res.emit("end");
	});
	return res;
}

describe("POST /api/apps/proxy", () => {
	beforeEach(() => {
		vi.resetModules();
		lookupMock.mockReset();
		httpRequestMock.mockReset();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("rejects DNS resolutions to private addresses", async () => {
		lookupMock.mockResolvedValueOnce([{ address: "127.0.0.1", family: 4 }]);
		const { POST } = await import("./proxy/route.js");
		const res = await POST(new Request("http://localhost/api/apps/proxy", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ url: "http://example.com/" }),
		}));
		expect(res.status).toBe(403);
		await expect(res.json()).resolves.toEqual({
			error: "Requests to private/local addresses are not allowed",
		});
	});

	it("pins the upstream connection to the validated DNS result", async () => {
		lookupMock.mockResolvedValueOnce([{ address: "93.184.216.34", family: 4 }]);
		httpRequestMock.mockImplementationOnce((url: URL, options: { lookup: Function }, callback: (res: EventEmitter) => void) => {
			const upstreamRes = makeUpstreamResponse({
				statusCode: 200,
				statusMessage: "OK",
				headers: { "content-type": "text/plain" },
				body: "proxied",
			});
			callback(upstreamRes);

			return {
				setTimeout: vi.fn(),
				on: vi.fn(),
				write: vi.fn(),
				end: vi.fn(() => {
					options.lookup(url.hostname, {}, (err: Error | null, address: string, family: number) => {
						expect(err).toBeNull();
						expect(address).toBe("93.184.216.34");
						expect(family).toBe(4);
					});
				}),
				destroy: vi.fn(),
			};
		});

		const { POST } = await import("./proxy/route.js");
		const res = await POST(new Request("http://localhost/api/apps/proxy", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				url: "http://example.com/test",
				method: "POST",
				headers: {
					Host: "evil.test",
					"X-Test": "1",
				},
				body: "hello",
			}),
		}));

		expect(httpRequestMock).toHaveBeenCalledTimes(1);
		const [, options] = httpRequestMock.mock.calls[0];
		expect(options.headers).toEqual({ "X-Test": "1" });
		expect(res.status).toBe(200);
		await expect(res.json()).resolves.toMatchObject({
			status: 200,
			body: "proxied",
		});
	});
});
