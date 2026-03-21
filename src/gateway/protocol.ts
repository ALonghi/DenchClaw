import { createPrivateKey, createPublicKey, sign } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export type GatewayConnectionSettings = {
  url: string;
  token?: string;
  password?: string;
};

type DeviceIdentity = {
  deviceId: string;
  publicKeyPem: string;
  privateKeyPem: string;
};

type DeviceAuth = {
  token: string;
};

type BuildConnectParamsOptions = {
  clientMode?: "webchat" | "backend" | "cli" | "ui" | "node" | "probe" | "test";
  caps?: string[];
  nonce?: string;
  deviceIdentity?: DeviceIdentity | null;
  deviceToken?: string | null;
};

const DEFAULT_GATEWAY_CLIENT_CAPS = ["tool-events"];
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function parseJsonObject(raw: string): Record<string, unknown> | null {
  try {
    return asRecord(JSON.parse(raw));
  } catch {
    return null;
  }
}

function base64UrlEncode(buf: Buffer): string {
  return buf.toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

function derivePublicKeyRaw(publicKeyPem: string): Buffer {
  const spki = createPublicKey(publicKeyPem).export({ type: "spki", format: "der" });
  if (
    spki.length === ED25519_SPKI_PREFIX.length + 32 &&
    spki.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX)
  ) {
    return spki.subarray(ED25519_SPKI_PREFIX.length);
  }
  return spki;
}

function signDevicePayload(privateKeyPem: string, payload: string): string {
  const key = createPrivateKey(privateKeyPem);
  return base64UrlEncode(sign(null, Buffer.from(payload, "utf8"), key) as unknown as Buffer);
}

export function loadDeviceIdentity(stateDir: string): DeviceIdentity | null {
  const filePath = path.join(stateDir, "identity", "device.json");
  if (!existsSync(filePath)) {
    return null;
  }
  const parsed = parseJsonObject(readFileSync(filePath, "utf-8"));
  if (
    parsed &&
    typeof parsed.deviceId === "string" &&
    typeof parsed.publicKeyPem === "string" &&
    typeof parsed.privateKeyPem === "string"
  ) {
    return {
      deviceId: parsed.deviceId,
      publicKeyPem: parsed.publicKeyPem,
      privateKeyPem: parsed.privateKeyPem,
    };
  }
  return null;
}

export function loadDeviceAuth(stateDir: string): DeviceAuth | null {
  const filePath = path.join(stateDir, "identity", "device-auth.json");
  if (!existsSync(filePath)) {
    return null;
  }
  const parsed = parseJsonObject(readFileSync(filePath, "utf-8"));
  if (!parsed) {
    return null;
  }
  const tokens = asRecord(parsed.tokens);
  const operator = asRecord(tokens?.operator);
  if (operator && typeof operator.token === "string") {
    return {
      token: operator.token,
    };
  }
  return null;
}

export function buildConnectParams(
  settings: GatewayConnectionSettings,
  options?: BuildConnectParamsOptions,
): Record<string, unknown> {
  const caps = Array.isArray(options?.caps)
    ? options.caps.filter((cap): cap is string => typeof cap === "string" && cap.trim().length > 0)
    : DEFAULT_GATEWAY_CLIENT_CAPS;
  const clientMode = options?.clientMode ?? "backend";
  const clientId = process.env.OPENCLAW_GATEWAY_CLIENT_ID || "gateway-client";
  const role = "operator";
  const scopes = ["operator.read", "operator.write", "operator.admin"];

  const hasGatewayAuth = Boolean(settings.token || settings.password);
  const deviceToken = options?.deviceToken;
  const auth = hasGatewayAuth || deviceToken
    ? {
        ...(settings.token ? { token: settings.token } : {}),
        ...(settings.password ? { password: settings.password } : {}),
        ...(deviceToken ? { deviceToken } : {}),
      }
    : undefined;

  const nonce = options?.nonce;
  const identity = options?.deviceIdentity;
  let device: Record<string, unknown> | undefined;
  if (identity && nonce) {
    const signedAtMs = Date.now();
    const platform = process.platform;
    const payload = [
      "v3",
      identity.deviceId,
      clientId,
      clientMode,
      role,
      scopes.join(","),
      String(signedAtMs),
      settings.token ?? "",
      nonce,
      platform,
      "",
    ].join("|");
    const signature = signDevicePayload(identity.privateKeyPem, payload);
    device = {
      id: identity.deviceId,
      publicKey: base64UrlEncode(derivePublicKeyRaw(identity.publicKeyPem)),
      signature,
      signedAt: signedAtMs,
      nonce,
    };
  }

  return {
    minProtocol: 3,
    maxProtocol: 3,
    client: {
      id: clientId,
      version: "dev",
      platform: process.platform,
      mode: clientMode,
      instanceId: "denchclaw-web-server",
    },
    locale: "en-US",
    userAgent: "denchclaw-web",
    role,
    scopes,
    caps,
    ...(auth ? { auth } : {}),
    ...(device ? { device } : {}),
  };
}
