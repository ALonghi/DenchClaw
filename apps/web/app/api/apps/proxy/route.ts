import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
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

type ValidatedAddress = {
  address: string;
  family: 4 | 6;
};

function normalizeRequestHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  if (!headers) {return {};}
  const sanitized: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value !== "string") {continue;}
    const lowerKey = key.toLowerCase();
    if (
      lowerKey === "host" ||
      lowerKey === "connection" ||
      lowerKey === "content-length" ||
      lowerKey === "transfer-encoding"
    ) {
      continue;
    }
    sanitized[key] = value;
  }
  return sanitized;
}

async function assertPublicDestination(url: URL): Promise<ValidatedAddress[]> {
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
    return [{
      address: url.hostname,
      family: isIP(url.hostname) as 4 | 6,
    }];
  }

  const records = await lookup(url.hostname, { all: true, verbatim: true });
  if (records.length === 0 || records.some((record) => isPrivateHost(record.address))) {
    throw new Error("Requests to private/local addresses are not allowed");
  }
  return records.map((record) => ({
    address: record.address,
    family: record.family as 4 | 6,
  }));
}

async function proxyRequest(
  url: URL,
  method: string,
  headers: Record<string, string>,
  body: string | undefined,
  destination: ValidatedAddress,
): Promise<Response> {
  const requestImpl = url.protocol === "https:" ? httpsRequest : httpRequest;
  return await new Promise<Response>((resolve, reject) => {
    const upstreamReq = requestImpl(url, {
      method,
      headers,
      lookup: (_hostname, _options, callback) => {
        callback(null, destination.address, destination.family);
      },
    }, (upstreamRes) => {
      const chunks: Buffer[] = [];
      upstreamRes.on("data", (chunk) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      upstreamRes.on("end", () => {
        const responseHeaders: Record<string, string> = {};
        for (const [key, value] of Object.entries(upstreamRes.headers)) {
          if (Array.isArray(value)) {
            responseHeaders[key] = value.join(", ");
          } else if (typeof value === "string") {
            responseHeaders[key] = value;
          }
        }

        resolve(Response.json({
          status: upstreamRes.statusCode ?? 502,
          statusText: upstreamRes.statusMessage ?? "",
          headers: responseHeaders,
          body: Buffer.concat(chunks).toString("utf-8"),
        }));
      });
    });

    upstreamReq.setTimeout(15_000, () => {
      upstreamReq.destroy(new Error("Upstream request timed out"));
    });
    upstreamReq.on("error", reject);
    if (body !== undefined) {
      upstreamReq.write(body);
    }
    upstreamReq.end();
  });
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

  let destinations: ValidatedAddress[];
  try {
    destinations = await assertPublicDestination(parsed);
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Request blocked" },
      { status: 403 },
    );
  }

  try {
    const requestHeaders = normalizeRequestHeaders(body.headers);
    return await proxyRequest(
      parsed,
      method,
      requestHeaders,
      method !== "GET" && method !== "HEAD" ? body.body : undefined,
      destinations[0],
    );
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Fetch failed" },
      { status: 502 },
    );
  }
}
