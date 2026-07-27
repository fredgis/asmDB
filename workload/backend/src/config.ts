import { z } from "zod";

const positiveInt = z.coerce.number().int().positive();
const booleanFromEnv = z.preprocess((value) => {
  if (typeof value !== "string") return value;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}, z.boolean());

export const configSchema = z
  .object({
    nodeEnv: z.string().default("production"),
    port: positiveInt.default(5010),
    tenantId: z.string().min(1),
    clientId: z.string().min(1),
    clientSecret: z.string().min(1).optional(),
    useManagedIdentity: booleanFromEnv.default(false),
    managedIdentityClientId: z.string().min(1).optional(),
    cloudApi: z.string().url().default("https://www.asmdb.cloud/api/v1"),
    cloudScope: z.string().min(1).optional(),
  appIdUri: z.string().min(1).optional(),
    gatewayUrl: z.string().url(),
    gatewayToken: z.string().min(1),
    jwksUri: z.string().url().optional(),
    tokenEndpoint: z.string().url().optional(),
    requestBodyLimit: z.string().default("16kb"),
    upstreamJsonBytes: positiveInt.default(1024 * 1024),
    upstreamCdcBytes: positiveInt.default(256 * 1024),
    upstreamTimeoutMs: positiveInt.default(8000),
    cdcTokenTtlSeconds: positiveInt.default(15 * 60),
    allowedOrigins: z
      .string()
      .default("")
      .transform((value) =>
        value
          .split(",")
          .map((entry) => entry.trim())
          .filter((entry) => entry.length > 0)
      ),
  })
  .superRefine((config, ctx) => {
    if (!config.useManagedIdentity && !config.clientSecret) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["clientSecret"],
        message:
          "OBO client authentication is not configured. Set ASMDB_WL_USE_MANAGED_IDENTITY=true for a federated managed-identity client assertion, or set ASMDB_WL_ENTRA_CLIENT_SECRET for local development.",
      });
    }
  });

export type AppConfig = z.infer<typeof configSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return configSchema.parse({
    nodeEnv: env.NODE_ENV,
    port: env.PORT,
    tenantId: env.ASMDB_WL_ENTRA_TENANT_ID,
    clientId: env.ASMDB_WL_ENTRA_CLIENT_ID,
    clientSecret: env.ASMDB_WL_ENTRA_CLIENT_SECRET,
    useManagedIdentity: env.ASMDB_WL_USE_MANAGED_IDENTITY,
    managedIdentityClientId: env.ASMDB_WL_MANAGED_IDENTITY_CLIENT_ID,
    cloudApi: env.ASMDB_CLOUD_API,
    cloudScope: env.ASMDB_CLOUD_SCOPE,
    appIdUri: env.ASMDB_WL_APP_ID_URI,
    gatewayUrl: env.ASMDB_GATEWAY_URL,
    gatewayToken: env.ASMDB_GATEWAY_TOKEN,
    jwksUri: env.ASMDB_WL_JWKS_URI,
    tokenEndpoint: env.ASMDB_WL_TOKEN_ENDPOINT,
    requestBodyLimit: env.ASMDB_REQUEST_BODY_LIMIT,
    upstreamJsonBytes: env.ASMDB_UPSTREAM_JSON_BYTES,
    upstreamCdcBytes: env.ASMDB_UPSTREAM_CDC_BYTES,
    upstreamTimeoutMs: env.ASMDB_UPSTREAM_TIMEOUT_MS,
    cdcTokenTtlSeconds: env.ASMDB_CDC_TOKEN_TTL_SECONDS,
    allowedOrigins: env.ASMDB_ALLOWED_ORIGINS,
  });
}
