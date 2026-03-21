import { buildConnectParams, loadDeviceAuth, loadDeviceIdentity, type GatewayConnectionSettings } from "./protocol.js";

export type GatewayProbeResult = {
  ok: boolean;
  detail?: string;
  authFailure?: boolean;
  scopeFailure?: boolean;
};

type GatewayFrame = {
  type?: string;
  event?: string;
  ok?: boolean;
  error?: unknown;
  nonce?: string;
  payload?: unknown;
};

function frameErrorMessage(frame: GatewayFrame): string {
  if (typeof frame.error === "string" && frame.error.trim()) {
    return frame.error;
  }
  if (frame.error && typeof frame.error === "object") {
    const message = (frame.error as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) {
      return message;
    }
  }
  return "Gateway request failed";
}

function toProbeFailure(detail: string): GatewayProbeResult {
  const normalized = detail.toLowerCase();
  return {
    ok: false,
    detail,
    authFailure:
      normalized.includes("unauthorized") ||
      normalized.includes("password") ||
      normalized.includes("token"),
    scopeFailure: normalized.includes("missing scope"),
  };
}

export async function probeGatewayConnection(params: {
  stateDir: string;
  settings: GatewayConnectionSettings;
  timeoutMs?: number;
}): Promise<GatewayProbeResult> {
  const timeoutMs = params.timeoutMs ?? 8_000;
  const deviceIdentity = loadDeviceIdentity(params.stateDir);
  const deviceAuth = loadDeviceAuth(params.stateDir);

  return await new Promise<GatewayProbeResult>((resolve) => {
    let settled = false;
    let challengeNonce: string | null = null;
    const ws = new WebSocket(params.settings.url);

    const finish = (result: GatewayProbeResult) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        // ignore
      }
      resolve(result);
    };

    const timer = setTimeout(() => {
      finish({ ok: false, detail: `Gateway probe timed out after ${timeoutMs}ms.` });
    }, timeoutMs);

    ws.addEventListener("open", () => {
      if (!challengeNonce) {
        return;
      }
      const paramsPayload = buildConnectParams(params.settings, {
        clientMode: "probe",
        nonce: challengeNonce,
        deviceIdentity,
        deviceToken: deviceAuth?.token ?? null,
      });
      ws.send(JSON.stringify({ type: "req", id: "probe-connect", method: "connect", params: paramsPayload }));
    });

    ws.addEventListener("message", (event) => {
      let frame: GatewayFrame;
      try {
        frame = JSON.parse(String(event.data)) as GatewayFrame;
      } catch {
        return;
      }

      if (frame.event === "hello" && typeof frame.nonce === "string") {
        challengeNonce = frame.nonce;
        const paramsPayload = buildConnectParams(params.settings, {
          clientMode: "probe",
          nonce: challengeNonce,
          deviceIdentity,
          deviceToken: deviceAuth?.token ?? null,
        });
        ws.send(JSON.stringify({ type: "req", id: "probe-connect", method: "connect", params: paramsPayload }));
        return;
      }

      if (frame.type === "res" && frame.ok === true) {
        finish({ ok: true });
        return;
      }

      if ((frame.type === "res" && frame.ok === false) || frame.type === "error") {
        finish(toProbeFailure(frameErrorMessage(frame)));
      }
    });

    ws.addEventListener("error", () => {
      finish({ ok: false, detail: `Failed to connect to gateway at ${params.settings.url}.` });
    });

    ws.addEventListener("close", (event) => {
      if (!settled) {
        if (event.code === 1000) {
          finish({ ok: true });
          return;
        }
        finish({
          ok: false,
          detail: event.reason || `Gateway connection closed (${event.code}).`,
        });
      }
    });
  });
}
