import {
  buildDenchCloudAgentModelEntries,
  buildDenchCloudProviderModels,
  buildDenchGatewayApiBaseUrl,
  buildDenchGatewayCatalogUrl,
  cloneFallbackDenchCloudModels,
  DEFAULT_DENCH_CLOUD_GATEWAY_URL,
  normalizeDenchCloudCatalogResponse,
  normalizeDenchGatewayUrl,
  type DenchCloudCatalogModel,
} from "./models.js";

export const id = "dench-ai-gateway";

const PROVIDER_ID = "dench-cloud";
const PROVIDER_LABEL = "Dench Cloud";
const API_KEY_ENV_VARS = ["DENCH_CLOUD_API_KEY", "DENCH_API_KEY"] as const;

type CatalogSource = "live" | "fallback";

type CatalogLoadResult = {
  models: DenchCloudCatalogModel[];
  source: CatalogSource;
  detail?: string;
};

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | undefined {
  return value && typeof value === "object" ? (value as UnknownRecord) : undefined;
}

function resolvePluginConfig(api: any): UnknownRecord | undefined {
  const pluginConfig = api?.config?.plugins?.entries?.["dench-ai-gateway"]?.config;
  return asRecord(pluginConfig);
}

function resolveGatewayUrl(api: any): string {
  const pluginConfig = resolvePluginConfig(api);
  const configured = typeof pluginConfig?.gatewayUrl === "string" ? pluginConfig.gatewayUrl : undefined;
  return normalizeDenchGatewayUrl(
    configured || process.env.DENCH_GATEWAY_URL || DEFAULT_DENCH_CLOUD_GATEWAY_URL,
  );
}

function resolveEnvApiKey(): string | undefined {
  for (const envVar of API_KEY_ENV_VARS) {
    const value = process.env[envVar]?.trim();
    if (value) {
      return value;
    }
  }
  return undefined;
}

function buildProviderConfig(
  gatewayUrl: string,
  models: DenchCloudCatalogModel[],
  apiKey?: string,
) {
  return {
    baseUrl: buildDenchGatewayApiBaseUrl(gatewayUrl),
    ...(apiKey ? { apiKey } : {}),
    api: "openai-completions",
    models: buildDenchCloudProviderModels(models),
  };
}

export function buildDenchCloudConfigPatch(params: {
  gatewayUrl: string;
  models: DenchCloudCatalogModel[];
  apiKey?: string;
}) {
  return {
    models: {
      mode: "merge",
      providers: {
        [PROVIDER_ID]: buildProviderConfig(params.gatewayUrl, params.models, params.apiKey),
      },
    },
    agents: {
      defaults: {
        models: buildDenchCloudAgentModelEntries(params.models),
      },
    },
  };
}

export async function fetchDenchCloudCatalog(gatewayUrl: string): Promise<CatalogLoadResult> {
  try {
    const response = await fetch(buildDenchGatewayCatalogUrl(gatewayUrl));
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const payload = await response.json().catch(() => null);
    const models = normalizeDenchCloudCatalogResponse(payload);
    if (!models.length) {
      throw new Error("response did not contain any usable models");
    }

    return { models, source: "live" };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      models: cloneFallbackDenchCloudModels(),
      source: "fallback",
      detail,
    };
  }
}

function buildAuthNotes(params: {
  gatewayUrl: string;
  catalog: CatalogLoadResult;
}): string[] {
  const notes = [
    `Dench Cloud uses ${buildDenchGatewayApiBaseUrl(params.gatewayUrl)} for model traffic.`,
  ];

  if (params.catalog.source === "fallback") {
    notes.push(
      `Model catalog fell back to DenchClaw's bundled list (${params.catalog.detail ?? "public catalog unavailable"}).`,
    );
  }

  return notes;
}

async function buildDiscoveryProvider(api: any, gatewayUrl: string) {
  const configured = api?.config?.models?.providers?.[PROVIDER_ID];
  if (configured && typeof configured === "object") {
    return configured;
  }

  const catalog = await fetchDenchCloudCatalog(gatewayUrl);
  return buildProviderConfig(gatewayUrl, catalog.models, resolveEnvApiKey());
}

export default function register(api: any) {
  const pluginConfig = resolvePluginConfig(api);
  if (pluginConfig?.enabled === false) {
    return;
  }

  const gatewayUrl = resolveGatewayUrl(api);

  api.registerProvider({
    id: PROVIDER_ID,
    label: PROVIDER_LABEL,
    docsPath: "/providers/models",
    aliases: ["dench", "dench-cloud", "dench-ai-gateway"],
    envVars: [...API_KEY_ENV_VARS],
    // Best-effort discovery so newer OpenClaw builds can rehydrate provider config.
    discovery: {
      order: "profile",
      run: async () => {
        const provider = await buildDiscoveryProvider(api, gatewayUrl);
        return provider ? { provider } : null;
      },
    },
  } as any);

  api.registerService({
    id: "dench-ai-gateway",
    start: () => {
      api.logger?.info?.(`[dench-ai-gateway] active (gateway: ${gatewayUrl})`);
    },
    stop: () => {
      api.logger?.info?.("[dench-ai-gateway] stopped");
    },
  });
}
