import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ALLOWED_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"]);
const LOOPBACK_HOSTS = new Set(["localhost", "localhost."]);

function isPrivateIpv4(host: string): boolean {
  return /^(127\.|10\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/i.test(host);
}

function isPrivateIpv6(host: string): boolean {
  const normalized = host.toLowerCase();
  return normalized === "::1" || normalized.startsWith("fe80:") || normalized.startsWith("fc") || normalized.startsWith("fd");
}

function isPrivateHost(host: string): boolean {
  const normalized = host.replace(/^\[(.*)\]$/, "$1").toLowerCase();
  if (LOOPBACK_HOSTS.has(normalized)) {return true;}
  const family = isIP(normalized);
  if (family === 4) {return isPrivateIpv4(normalized);}
  if (family === 6) {return isPrivateIpv6(normalized);}
  return false;
}

async function assertPublicDestination(url: URL): Promise<void> {
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Only http and https URLs are allowed");
  }
  if (url.username || url.password) {
    throw new Error("Credentials in URLs are not allowed");
  }
  if (isPrivateHost(url.hostname)) {
    throw new Error("Requests to private/local addresses are not allowed");
  }
  if (isIP(url.hostname)) {
    return;
  }

  const records = await lookup(url.hostname, { all: true, verbatim: true });
  if (records.length === 0 || records.some((record) => isPrivateHost(record.address))) {
    throw new Error("Requests to private/local addresses are not allowed");
  }
}

export async function POST(req: Request) {
  let body: {
    url?: string;
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { url } = body;
  if (!url || typeof url !== "string") {
    return Response.json(
      { error: "Missing 'url' field" },
      { status: 400 },
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return Response.json({ error: "Invalid URL" }, { status: 400 });
  }

  const method = typeof body.method === "string" ? body.method.toUpperCase() : "GET";
  if (!ALLOWED_METHODS.has(method)) {
    return Response.json({ error: "HTTP method not allowed" }, { status: 400 });
  }

  try {
    await assertPublicDestination(parsed);
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Request blocked" },
      { status: 403 },
    );
  }

  try {
    const resp = await fetch(url, {
      method,
      headers: body.headers || {},
      body: method !== "GET" && method !== "HEAD"
        ? body.body
        : undefined,
      redirect: "manual",
    });

    const respBody = await resp.text();
    const respHeaders: Record<string, string> = {};
    resp.headers.forEach((v, k) => {
      respHeaders[k] = v;
    });

    return Response.json({
      status: resp.status,
      statusText: resp.statusText,
      headers: respHeaders,
      body: respBody,
    });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Fetch failed" },
      { status: 502 },
    );
  }
}
