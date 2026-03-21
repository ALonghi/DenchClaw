import {
  buildDenchCloudAgentModelEntries,
  buildDenchCloudProviderModels,
  buildDenchGatewayApiBaseUrl,
  buildDenchGatewayCatalogUrl,
  cloneFallbackDenchCloudModels,
  DEFAULT_DENCH_CLOUD_GATEWAY_URL,
  formatDenchCloudModelHint,
  normalizeDenchCloudCatalogResponse,
  normalizeDenchGatewayUrl,
  resolveDenchCloudModel,
  type DenchCloudCatalogModel,
} from "./models.js";

export const id = "dench-ai-gateway";

const PROVIDER_ID = "dench-cloud";
const PROVIDER_LABEL = "Dench Cloud";
const API_KEY_ENV_VARS = ["DENCH_CLOUD_API_KEY", "DENCH_API_KEY"] as const;
const DEFAULT_PUBLIC_PROVIDER_TOKEN = "dench-public";

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
  const configured =
    typeof pluginConfig?.gatewayUrl === "string" ? pluginConfig.gatewayUrl : undefined;
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
    ...(apiKey ? {} : { authHeader: false }),
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

function resolveConfiguredModel(api: any): string | undefined {
  const defaults = asRecord(asRecord(asRecord(api?.config)?.agents)?.defaults);
  const modelValue = defaults?.model;
  const modelRecord = asRecord(modelValue);
  const modelRef =
    typeof modelValue === "string"
      ? modelValue
      : typeof modelRecord?.primary === "string"
        ? modelRecord.primary
        : undefined;
  return typeof modelRef === "string" && modelRef.startsWith(`${PROVIDER_ID}/`)
    ? modelRef.slice(`${PROVIDER_ID}/`.length)
    : undefined;
}

async function promptForModelSelection(params: {
  prompter: any;
  models: DenchCloudCatalogModel[];
  initialStableId?: string;
}): Promise<DenchCloudCatalogModel> {
  const selectedStableId = String(
    await params.prompter.select({
      message: "Choose your default Dench Cloud model",
      options: params.models.map((model) => ({
        value: model.stableId,
        label: model.displayName,
        hint: formatDenchCloudModelHint(model),
      })),
      ...(params.initialStableId ? { initialValue: params.initialStableId } : {}),
    }),
  );

  const selected = resolveDenchCloudModel(params.models, selectedStableId);
  if (!selected) {
    throw new Error(`Unknown Dench Cloud model "${selectedStableId}".`);
  }
  return selected;
}

function buildSetupNotes(params: { gatewayUrl: string; catalog: CatalogLoadResult }): string[] {
  const notes = [
    `Dench Cloud uses ${buildDenchGatewayApiBaseUrl(params.gatewayUrl)} for model traffic.`,
    "This provider uses Dench's public gateway flow and does not require an API key by default.",
  ];

  if (params.catalog.source === "fallback") {
    notes.push(
      `Model catalog fell back to DenchClaw's bundled list (${params.catalog.detail ?? "public catalog unavailable"}).`,
    );
  }

  return notes;
}

function buildProviderSetupResult(params: {
  gatewayUrl: string;
  catalog: CatalogLoadResult;
  selected: DenchCloudCatalogModel;
  apiKey?: string;
}) {
  return {
    profiles: [
      {
        profileId: `${PROVIDER_ID}:default`,
        credential: {
          type: "token",
          provider: PROVIDER_ID,
          token: params.apiKey || DEFAULT_PUBLIC_PROVIDER_TOKEN,
        },
      },
    ],
    defaultModel: `${PROVIDER_ID}/${params.selected.stableId}`,
    configPatch: buildDenchCloudConfigPatch({
      gatewayUrl: params.gatewayUrl,
      models: params.catalog.models,
      apiKey: params.apiKey,
    }),
    notes: buildSetupNotes({
      gatewayUrl: params.gatewayUrl,
      catalog: params.catalog,
    }),
  };
}

async function runInteractiveSetup(ctx: any, api: any, gatewayUrl: string) {
  const catalog = await fetchDenchCloudCatalog(gatewayUrl);
  const selected = await promptForModelSelection({
    prompter: ctx.prompter,
    models: catalog.models,
    initialStableId: resolveConfiguredModel(api),
  });

  return buildProviderSetupResult({
    gatewayUrl,
    catalog,
    selected,
    apiKey: resolveEnvApiKey(),
  });
}

async function runNonInteractiveSetup(ctx: any, gatewayUrl: string) {
  const catalog = await fetchDenchCloudCatalog(gatewayUrl);
  const selected = resolveDenchCloudModel(
    catalog.models,
    String(ctx?.opts?.denchCloudModel || process.env.DENCH_CLOUD_MODEL || "").trim(),
  );
  if (!selected) {
    throw new Error("Configured Dench Cloud model is not available.");
  }

  return buildProviderSetupResult({
    gatewayUrl,
    catalog,
    selected,
    apiKey: resolveEnvApiKey(),
  });
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
    auth: [
      {
        id: "public-gateway",
        label: "Dench Cloud",
        hint: "Choose a Dench Cloud model and configure the public gateway",
        kind: "custom",
        run: async (ctx: any) => await runInteractiveSetup(ctx, api, gatewayUrl),
        runNonInteractive: async (ctx: any) => await runNonInteractiveSetup(ctx, gatewayUrl),
      },
    ],
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
