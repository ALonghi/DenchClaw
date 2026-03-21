# Security Best Practices Assessment

## Executive Summary

This report captures the pre-hardening findings that motivated the current security changes. Several issues listed below have now been fixed or partially mitigated in the fork; the report is retained as an audit record of what was identified before those changes landed.

This fork is not hardened as a hostile-environment web application. The codebase assumes the HTTP and WebSocket surfaces are only reachable by a trusted local user. That assumption is not enforced in the application itself.

The highest-impact issues are:

1. Multiple API routes can read and write arbitrary local files outside the workspace.
2. The database query path contains a shell-invocation bug that can likely be turned into command execution.
3. There is no application-layer authentication or authorization on the main API surface.
4. The built-in outbound proxy has SSRF protections that are easy to bypass.

If this app is ever exposed beyond strict localhost-only use, compromise should be assumed. Even in localhost-only mode, several issues remain relevant because a malicious local process, browser context, or rebinding/proxy mistake would immediately inherit broad filesystem and shell access.

## Remediation Status

- `DC-SEC-001`: Partially fixed. Most browser-facing file mutation/read routes are now workspace-bound, but the local browse/picker model still needs explicit privileged gating.
- `DC-SEC-002`: Fixed. DuckDB shell-string invocation was replaced with argument-array execution.
- `DC-SEC-003`: Open. There is still no broad app-layer auth/authz boundary.
- `DC-SEC-004`: Partially fixed. Hostname and resolved-IP checks were added, and the proxy is being further tightened to pin validated DNS results at connection time.
- `DC-SEC-005`: Partially fixed. Terminal token and origin checks were added, but the feature remains high impact if exposed incorrectly.

## Critical

### DC-SEC-001
- Rule ID: `NEXT-AUTHZ-001`
- Severity: Critical
- Location: [apps/web/lib/workspace.ts](apps/web/lib/workspace.ts#L1181), [apps/web/app/api/workspace/raw-file/route.ts](apps/web/app/api/workspace/raw-file/route.ts#L56), [apps/web/app/api/workspace/raw-file/route.ts](apps/web/app/api/workspace/raw-file/route.ts#L130), [apps/web/app/api/workspace/file/route.ts](apps/web/app/api/workspace/file/route.ts#L41), [apps/web/app/api/workspace/file/route.ts](apps/web/app/api/workspace/file/route.ts#L91), [apps/web/app/api/workspace/browse/route.ts](apps/web/app/api/workspace/browse/route.ts#L105)
- Evidence:

```ts
// apps/web/lib/workspace.ts
} else if (kind === "homeRelative") {
  absolutePath = resolve(normalize(expandHomeRelativePath(inputPath)));
} else {
  absolutePath = resolve(normalize(inputPath));
}
```

```ts
// apps/web/app/api/workspace/raw-file/route.ts
const resolvedPath = resolveFilesystemPath(path);
if (resolvedPath) {return resolvedPath.absolutePath;}
```

```ts
// apps/web/app/api/workspace/file/route.ts
const targetPath = resolveFilesystemPath(relPath, { allowMissing: true });
```

```ts
// apps/web/app/api/workspace/browse/route.ts
let dir = url.searchParams.get("dir");
...
const resolved = resolve(dir);
const entries = buildBrowseTree(resolved, 3, 0, showHidden);
```

- Impact: Any caller that can reach the app can browse arbitrary local directories, read arbitrary local files, and write/delete arbitrary local files, not just workspace content.
- Fix: Restrict request-facing file APIs to workspace-relative paths only. Use `safeResolvePath` or `safeResolveNewPath` for all browser-facing file routes, and move absolute-path access behind a separate privileged local-only mechanism that is off by default.
- Mitigation: If absolute-path support must exist, gate it behind explicit opt-in, loopback-only binding checks, and a high-entropy per-session auth token.
- False positive notes: This may be intentional for a trusted local operator workflow, but it is still an application-level security risk because the trust boundary is not enforced in code.

### DC-SEC-002
- Rule ID: `NEXT-INJECT-001`
- Severity: Critical
- Location: [apps/web/app/api/workspace/db/query/route.ts](/Users/hybrid/dev/github/DenchClaw/apps/web/app/api/workspace/db/query/route.ts#L13), [apps/web/lib/workspace.ts](/Users/hybrid/dev/github/DenchClaw/apps/web/lib/workspace.ts#L1131)
- Evidence:

```ts
// apps/web/app/api/workspace/db/query/route.ts
const absPath = safeResolvePath(relPath);
...
const rows = await duckdbQueryOnFileAsync(absPath, sql);
```

```ts
// apps/web/lib/workspace.ts
const { stdout } = await execAsync(`'${bin}' -json '${dbFilePath}' '${escapedSql}'`, {
  shell: "/bin/sh",
});
```

- Impact: `dbFilePath` is interpolated into a shell command without escaping. Because the app also lets clients create workspace files with attacker-chosen names, this is a likely command-injection path to arbitrary shell execution.
- Fix: Stop invoking DuckDB through shell strings. Use `spawn`/`execFile` with argument arrays so `dbFilePath` and `sql` are passed as opaque arguments, not shell-interpreted text.
- Mitigation: As an immediate stopgap, reject file paths containing shell-significant characters and disable database-querying on user-selected files until the helper is rewritten.
- False positive notes: I did not execute a proof-of-concept payload on your machine. The vulnerability is based on direct shell interpolation and standard POSIX filename semantics.

## High

### DC-SEC-003
- Rule ID: `NEXT-AUTHN-001`
- Severity: High
- Location: [apps/web/app/api/web-sessions/route.ts](/Users/hybrid/dev/github/DenchClaw/apps/web/app/api/web-sessions/route.ts#L20), [apps/web/app/api/web-sessions/[id]/route.ts](/Users/hybrid/dev/github/DenchClaw/apps/web/app/api/web-sessions/[id]/route.ts#L209), [apps/web/app/api/chat/route.ts](/Users/hybrid/dev/github/DenchClaw/apps/web/app/api/chat/route.ts#L62), [apps/web/app/api/workspace/file/route.ts](/Users/hybrid/dev/github/DenchClaw/apps/web/app/api/workspace/file/route.ts#L41)
- Evidence:

```ts
// Representative pattern across routes
export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  ...
  return Response.json({ session });
}
```

```ts
// apps/web/app/api/chat/route.ts
export async function POST(req: Request) {
  const {
    messages,
    sessionId,
    sessionKey,
    distinctId,
    userHtml,
  } = await req.json();
```

- Impact: There is no visible authentication, authorization, or CSRF/origin validation layer protecting destructive or sensitive routes. Any party that can reach the service can create sessions, read session data, modify workspace files, and trigger agent actions.
- Fix: Add a real application auth boundary for the web app. At minimum, require a server-side session or bearer token on all non-public routes, and enforce origin/CSRF protection for cookie-based flows.
- Mitigation: Keep the app bound to loopback only, do not expose it through tunnels/reverse proxies, and place an authenticating reverse proxy in front of it if remote access is ever required.
- False positive notes: If an external auth layer exists outside this repo, it is not visible in app code and should be verified at runtime. I found no in-repo request guard or session enforcement on the main API routes.

### DC-SEC-004
- Rule ID: `NEXT-SSRF-001`
- Severity: High
- Location: [apps/web/app/api/apps/proxy/route.ts](/Users/hybrid/dev/github/DenchClaw/apps/web/app/api/apps/proxy/route.ts#L4)
- Evidence:

```ts
const PRIVATE_IP =
  /^(127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|0\.|localhost|::1|\[::1\])/i;

if (PRIVATE_IP.test(parsed.hostname)) {
  return Response.json({ error: "Requests to private/local addresses are not allowed" }, { status: 403 });
}

const resp = await fetch(url, {
  method: body.method || "GET",
  headers: body.headers || {},
  body: ...
});
```

- Impact: The proxy trusts the hostname string instead of the resolved destination IP. An attacker can use DNS rebinding, attacker-controlled domains that resolve to RFC1918/loopback space, or alternate local-address encodings to pivot the app into internal services.
- Fix: Enforce an allowlist of supported schemes and hosts, resolve DNS server-side, reject any request whose final resolved IP is loopback/private/link-local, and re-check after redirects.
- Mitigation: Disable the generic proxy route unless a concrete feature requires it.
- False positive notes: If the proxy is only used for trusted internal apps, the exposure is lower, but the route is still a generic SSRF primitive as implemented.

### DC-SEC-005
- Rule ID: `NEXT-RCE-002`
- Severity: High
- Location: [apps/web/lib/terminal-server.ts](/Users/hybrid/dev/github/DenchClaw/apps/web/lib/terminal-server.ts#L61), [apps/web/lib/terminal-server.ts](/Users/hybrid/dev/github/DenchClaw/apps/web/lib/terminal-server.ts#L147), [apps/web/app/api/terminal/port/route.ts](/Users/hybrid/dev/github/DenchClaw/apps/web/app/api/terminal/port/route.ts#L6)
- Evidence:

```ts
// apps/web/lib/terminal-server.ts
pty = nodePty.spawn(shell, shellArgs(shell), {
  cwd: spawnCwd,
  env: Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== undefined)),
});
```

```ts
// apps/web/lib/terminal-server.ts
function handleConnection(ws: WebSocket, _req: IncomingMessage) {
  ws.on("message", (data) => {
    handleMessage(ws, data.toString());
  });
}
```

```ts
// apps/web/app/api/terminal/port/route.ts
export function GET() {
  const port = getTerminalPort();
  return NextResponse.json({ port, proxy });
}
```

- Impact: The terminal service exposes a full shell with inherited environment and no authentication or origin validation at the WebSocket layer. It is loopback-bound, but if a hostile browser context or local process reaches it, this is direct command execution.
- Fix: Require an unguessable per-session token for terminal connection setup, validate the `Origin` header, and avoid disclosing the port without an authenticated session.
- Mitigation: Keep the terminal feature disabled by default in higher-risk deployments.
- False positive notes: Because the WebSocket server binds `127.0.0.1`, remote internet exploitability depends on additional exposure. The local attack surface is still real.

## Medium

### DC-SEC-006
- Rule ID: `NEXT-WEBHOOK-001`
- Severity: Medium
- Location: [apps/web/app/api/apps/webhooks/[...path]/route.ts](/Users/hybrid/dev/github/DenchClaw/apps/web/app/api/apps/webhooks/%5B...path%5D/route.ts#L35), [apps/web/app/api/apps/webhooks/[...path]/route.ts](/Users/hybrid/dev/github/DenchClaw/apps/web/app/api/apps/webhooks/%5B...path%5D/route.ts#L59)
- Evidence:

```ts
pushEvent(key, {
  method: req.method,
  headers,
  body,
  receivedAt: Date.now(),
});
```

```ts
if (poll || since) {
  const events = store.get(key) || [];
  return Response.json({ events: filtered });
}
```

- Impact: Webhook payloads and headers are accepted from anyone and can be retrieved by anyone who knows the path. There is no signature verification, secret token, or reader authorization.
- Fix: Require per-webhook secrets or signed webhook verification, and require authenticated access to read stored events.
- Mitigation: Treat this as a development-only inspection feature and disable it outside trusted local use.
- False positive notes: If these endpoints are strictly developer tooling, that should be documented and enforced by deployment defaults.

## Low

### DC-SEC-007
- Rule ID: `NEXT-HEADERS-001`
- Severity: Low
- Location: [apps/web/next.config.ts](/Users/hybrid/dev/github/DenchClaw/apps/web/next.config.ts#L26), [apps/web/app/layout.tsx](/Users/hybrid/dev/github/DenchClaw/apps/web/app/layout.tsx#L33)
- Evidence:

```ts
// apps/web/next.config.ts
headers: [{ key: "X-Denchclaw-Version", value: denchVersion }]
```

```tsx
// apps/web/app/layout.tsx
<script dangerouslySetInnerHTML={{ __html: `(function(){ ... })();` }} />
```

- Impact: I did not find a baseline CSP, clickjacking policy, or referrer policy in app code. The inline script also means CSP adoption would need a nonce/hash plan rather than a permissive `unsafe-inline` fallback.
- Fix: Add a baseline header policy in `next.config.ts` or edge config: CSP, `frame-ancestors` or `X-Frame-Options`, `X-Content-Type-Options`, and `Referrer-Policy`. Convert the inline reload script to a nonce/hash-compatible pattern.
- Mitigation: If these headers are set by a reverse proxy, verify that runtime behavior rather than assuming it.
- False positive notes: This is defense-in-depth. It is lower priority than the direct filesystem, shell, and auth issues above.

## Notes

- I did not find evidence of committed secrets in this repository snapshot.
- The PostHog browser key is intentionally public-facing and should be treated as non-secret.
- The severity of several findings drops if the app is guaranteed to remain loopback-only and inaccessible to any untrusted local process or browser context, but the application itself does not enforce that trust boundary.
