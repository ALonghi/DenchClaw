import { DENCHCLAW_DEFAULT_GATEWAY_PORT } from "./paths.js";

export type ExternalGatewayMode = {
  enabled: boolean;
  gatewayUrl?: string;
  gatewayPort: number;
  auth: {
    hasToken: boolean;
    hasPassword: boolean;
  };
  modeLabel: "local" | "external";
  reason: string;
};

function parsePort(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return undefined;
  }
  return parsed;
}

export function normalizeExternalGatewayUrl(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`Invalid OPENCLAW_GATEWAY_URL: ${raw}`);
  }

  if (parsed.protocol === "http:") {
    parsed.protocol = "ws:";
  } else if (parsed.protocol === "https:") {
    parsed.protocol = "wss:";
  } else if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
    throw new Error(
      `Invalid OPENCLAW_GATEWAY_URL protocol "${parsed.protocol}". Use ws:// or wss://.`,
    );
  }

  return parsed.toString();
}

export function resolveExternalGatewayMode(params?: {
  daemonless?: boolean;
  env?: NodeJS.ProcessEnv;
  existingGatewayPort?: number;
}): ExternalGatewayMode {
  const env = params?.env ?? process.env;
  const daemonless = Boolean(params?.daemonless);
  const rawGatewayUrl = env.OPENCLAW_GATEWAY_URL?.trim();
  const hasToken = Boolean(env.OPENCLAW_GATEWAY_TOKEN?.trim());
  const hasPassword = Boolean(env.OPENCLAW_GATEWAY_PASSWORD?.trim());

  const fallbackPort = params?.existingGatewayPort ?? DENCHCLAW_DEFAULT_GATEWAY_PORT;
  const envPort = parsePort(env.OPENCLAW_GATEWAY_PORT?.trim());
  let urlPort: number | undefined;
  let normalizedUrl: string | undefined;

  if (daemonless && rawGatewayUrl) {
    normalizedUrl = normalizeExternalGatewayUrl(rawGatewayUrl);
    urlPort = parsePort(new URL(normalizedUrl).port);
  }

  const gatewayPort = envPort ?? urlPort ?? fallbackPort;
  const enabled = daemonless && Boolean(normalizedUrl);

  return {
    enabled,
    gatewayUrl: normalizedUrl,
    gatewayPort,
    auth: {
      hasToken,
      hasPassword,
    },
    modeLabel: enabled ? "external" : "local",
    reason: enabled
      ? "Gateway lifecycle is externally managed."
      : rawGatewayUrl
        ? "External gateway URL is configured, but daemonless mode is not enabled."
        : "External gateway mode is not configured.",
  };
}
