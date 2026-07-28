import { z } from "zod";
import type { AppConfig } from "../config.js";
import { HttpError } from "../errors.js";
import { fetchJsonCapped, fetchTextCapped } from "./capped-fetch.js";
import { ASMDB_SYNC_TEMPLATE } from "./notebook-template.js";
import type { OboTokenBroker } from "./obo.js";

// The Fabric REST API will not accept the token the frontend holds: the
// workload client issues a token whose audience is the workload's own app, and
// the SDK says so explicitly - additionalScopesToConsent is documented as the
// fallback "when failing to perform OBO flows in the workload's Backend". So
// the exchange belongs here, next to the one for asmDB Cloud, rather than in
// the browser where it would simply return 401.
const FABRIC_SCOPE = "https://api.fabric.microsoft.com/.default";
const FABRIC_NOTEBOOK_FORMAT = "ipynb";
const FABRIC_NOTEBOOK_PART_PATH = "artifact.content.ipynb";

const itemsSchema = z.object({
  value: z
    .array(
      z
        .object({
          id: z.string(),
          displayName: z.string(),
          type: z.string(),
          workspaceId: z.string().optional(),
        })
        .passthrough()
    )
    .default([]),
});

const notebookSchema = z
  .object({
    id: z.string(),
    displayName: z.string(),
    webUrl: z.string().optional(),
  })
  .passthrough();

const operationStateSchema = z
  .object({
    status: z.string(),
    error: z.unknown().optional().nullable(),
  })
  .passthrough();

export interface Lakehouse {
  id: string;
  name: string;
  workspaceId: string;
}

export interface CreateNotebookRequest {
  workspaceId: string;
  displayName: string;
  sourceDatabaseId: string;
  sourceDatabaseName: string;
  lakehouseId: string;
  lakehouseName: string;
  tablePrefix?: string;
  decoder?: "None" | "Hex" | "Base64" | "JSON" | "CSV" | "MessagePack";
}

export interface CreatedNotebook {
  notebookId: string;
  displayName: string;
  webUrl?: string;
}

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

function utf8Base64(value: string): string {
  return Buffer.from(value, "utf8").toString("base64");
}

function replaceAllLiteral(input: string, needle: string, replacement: string): string {
  return input.split(needle).join(replacement);
}

function sanitizeIdentifier(input: string, fallback: string): string {
  const value = input
    .trim()
    .replace(/[^A-Za-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "");
  const withFallback = value.length > 0 ? value : fallback;
  return /^[A-Za-z_]/.test(withFallback) ? withFallback : `t_${withFallback}`;
}

function renderSyncNotebook(config: AppConfig, request: CreateNotebookRequest): string {
  const decoder = request.decoder ?? "None";
  let tablePrefix = request.tablePrefix ? request.tablePrefix.replace(/[^A-Za-z0-9_]+/g, "_") : "";
  if (tablePrefix && !/^[A-Za-z_]/.test(tablePrefix)) {
    tablePrefix = `t_${tablePrefix}`;
  }
  const targetTable = `${tablePrefix}${sanitizeIdentifier(request.sourceDatabaseName, "asmdb_table")}`;
  let rendered = ASMDB_SYNC_TEMPLATE;
  const replacements: Record<string, string> = {
    __ASMDB_GATEWAY_URL__: config.gatewayUrl,
    __ASMDB_INSTANCE_ID__: request.sourceDatabaseId,
    __ASMDB_TARGET_TABLE__: targetTable,
    __ASMDB_KEY_VAULT_URL__: config.keyVaultUrl,
    __ASMDB_KEY_VAULT_SECRET_NAME__: config.keyVaultSecretName,
    'DECODER = "None"': `DECODER = "${decoder}"`,
  };
  for (const [needle, replacement] of Object.entries(replacements)) {
    rendered = replaceAllLiteral(rendered, needle, replacement);
  }
  return `${rendered}\n\n# Generated entry point\nrun_sync()\n`;
}

function notebookIpynb(config: AppConfig, request: CreateNotebookRequest): string {
  const source = renderSyncNotebook(config, request);
  return JSON.stringify({
    nbformat: 4,
    nbformat_minor: 5,
    cells: [
      {
        cell_type: "code",
        source: [
          "%%configure -f\n",
          `${JSON.stringify(
            {
              defaultLakehouse: {
                name: request.lakehouseName,
                id: request.lakehouseId,
                workspaceId: request.workspaceId,
              },
            },
            null,
            2
          )}\n`,
        ],
        execution_count: null,
        outputs: [],
        metadata: {},
      },
      {
        cell_type: "code",
        source: source.split(/(?<=\n)/),
        execution_count: null,
        outputs: [],
        metadata: {},
      },
    ],
    metadata: {
      language_info: { name: "python" },
      kernelspec: { name: "synapse_pyspark", display_name: "Synapse PySpark" },
      dependencies: {
        lakehouse: {
          default_lakehouse: request.lakehouseId,
          default_lakehouse_name: request.lakehouseName,
          default_lakehouse_workspace_id: request.workspaceId,
        },
      },
    },
  });
}

function platformPart(request: CreateNotebookRequest): string {
  return JSON.stringify({
    $schema:
      "https://developer.microsoft.com/json-schemas/fabric/gitIntegration/platformProperties/2.0.0/schema.json",
    metadata: {
      type: "Notebook",
      displayName: request.displayName,
      description: `asmDB sync notebook for ${request.sourceDatabaseName}`,
    },
    config: {
      version: "2.0",
      logicalId: "00000000-0000-0000-0000-000000000000",
    },
  });
}

function fabricErrorCode(text: string): string | undefined {
  try {
    const parsed = JSON.parse(text) as { errorCode?: unknown; error?: { code?: unknown } };
    const code = parsed.errorCode ?? parsed.error?.code;
    return typeof code === "string" ? code : undefined;
  } catch {
    return undefined;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class FabricService {
  constructor(
    private readonly config: AppConfig,
    private readonly broker: OboTokenBroker
  ) {}

  async listLakehouses(userToken: string, workspaceId: string): Promise<Lakehouse[]> {
    const accessToken = await this.broker.exchange(userToken, FABRIC_SCOPE);
    const url = `${this.config.fabricApi.replace(/\/+$/, "")}/v1/workspaces/${encodeURIComponent(
      workspaceId
    )}/items?type=Lakehouse`;

    const response = await fetchJsonCapped(
      itemsSchema,
      url,
      { method: "GET", headers: { accept: "application/json", authorization: `Bearer ${accessToken}` } },
      this.config
    );

    if (response.status === 401 || response.status === 403) {
      throw new HttpError(
        403,
        "fabric_forbidden",
        "Fabric denied this user access to the workspace items. Check that the workload app has been granted the Power BI delegated permissions and that consent was given."
      );
    }
    if (!response.ok) {
      throw new HttpError(502, "fabric_unavailable", `Fabric returned status ${response.status}`);
    }

    return response.data.value
      .filter((item) => item.type === "Lakehouse")
      .map((item) => ({
        id: item.id,
        name: item.displayName,
        workspaceId: item.workspaceId ?? workspaceId,
      }));
  }

  async createNotebook(userToken: string, request: CreateNotebookRequest): Promise<CreatedNotebook> {
    const accessToken = await this.broker.exchange(userToken, FABRIC_SCOPE);
    await this.ensureLakehouseExists(accessToken, request.workspaceId, request.lakehouseId);
    const url = `${this.config.fabricApi.replace(/\/+$/, "")}/v1/workspaces/${encodeURIComponent(
      request.workspaceId
    )}/notebooks`;
    const body = {
      displayName: request.displayName,
      description: `asmDB sync notebook for ${request.sourceDatabaseName}`,
      definition: {
        format: FABRIC_NOTEBOOK_FORMAT,
        parts: [
          {
            path: FABRIC_NOTEBOOK_PART_PATH,
            payload: utf8Base64(notebookIpynb(this.config, request)),
            payloadType: "InlineBase64",
          },
          {
            path: ".platform",
            payload: utf8Base64(platformPart(request)),
            payloadType: "InlineBase64",
          },
        ],
      },
    };

    const response = await fetchTextCapped(
      url,
      {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify(body),
      },
      this.config.upstreamJsonBytes,
      this.config.upstreamTimeoutMs
    );

    if (response.status === 201) {
      return this.parseCreatedNotebook(response.text);
    }
    if (response.status === 202) {
      return this.pollNotebookCreation(response, accessToken);
    }
    this.throwNotebookCreateError(response.status, response.text);
  }

  private async ensureLakehouseExists(
    accessToken: string,
    workspaceId: string,
    lakehouseId: string
  ): Promise<void> {
    const url = `${this.config.fabricApi.replace(/\/+$/, "")}/v1/workspaces/${encodeURIComponent(
      workspaceId
    )}/items?type=Lakehouse`;
    const response = await fetchTextCapped(
      url,
      { method: "GET", headers: { accept: "application/json", authorization: `Bearer ${accessToken}` } },
      this.config.upstreamJsonBytes,
      this.config.upstreamTimeoutMs
    );
    if (response.status === 401 || response.status === 403) {
      throw new HttpError(
        403,
        "fabric_notebook_forbidden",
        "Fabric denied this user access to the workspace lakehouses. Check workspace role and delegated consent."
      );
    }
    if (response.status === 404) {
      throw new HttpError(404, "fabric_item_not_found", "Fabric could not find the workspace for this sync notebook.");
    }
    if (!response.ok) {
      throw new HttpError(502, "fabric_unavailable", `Fabric returned status ${response.status} while validating the lakehouse`);
    }
    let json: unknown;
    try {
      json = JSON.parse(response.text);
    } catch {
      throw new HttpError(502, "upstream_malformed", "Fabric returned malformed lakehouse JSON");
    }
    const parsed = itemsSchema.safeParse(json);
    if (!parsed.success) {
      throw new HttpError(502, "upstream_malformed", "Fabric lakehouse JSON did not match contract");
    }
    if (!parsed.data.value.some((item) => item.type === "Lakehouse" && item.id === lakehouseId)) {
      throw new HttpError(404, "fabric_item_not_found", "Fabric could not find the selected lakehouse in this workspace.");
    }
  }

  private parseCreatedNotebook(text: string): CreatedNotebook {
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new HttpError(502, "upstream_malformed", "Fabric returned malformed notebook JSON");
    }
    const parsed = notebookSchema.safeParse(json);
    if (!parsed.success) {
      throw new HttpError(502, "upstream_malformed", "Fabric notebook JSON did not match contract");
    }
    return {
      notebookId: parsed.data.id,
      displayName: parsed.data.displayName,
      webUrl: parsed.data.webUrl,
    };
  }

  private async pollNotebookCreation(initial: { headers: Headers }, accessToken: string): Promise<CreatedNotebook> {
    const operationId = initial.headers.get("x-ms-operation-id");
    const location = initial.headers.get("location");
    const stateUrl = operationId
      ? joinUrl(this.config.fabricApi, `/v1/operations/${encodeURIComponent(operationId)}`)
      : location;
    if (!stateUrl) {
      throw new HttpError(502, "fabric_unavailable", "Fabric accepted notebook creation without an operation location");
    }
    const resultUrl = operationId
      ? `${stateUrl}/result`
      : stateUrl.endsWith("/result")
        ? stateUrl
        : `${stateUrl.replace(/\/+$/, "")}/result`;
    const deadline = Date.now() + this.config.fabricOperationTimeoutMs;

    while (Date.now() < deadline) {
      const stateResponse = await fetchJsonCapped(
        operationStateSchema,
        stateUrl,
        { method: "GET", headers: { accept: "application/json", authorization: `Bearer ${accessToken}` } },
        this.config
      );
      if (!stateResponse.ok) {
        throw new HttpError(502, "fabric_unavailable", `Fabric operation polling returned status ${stateResponse.status}`);
      }

      const status = stateResponse.data.status.toLowerCase();
      if (status === "succeeded") {
        const resultResponse = await fetchTextCapped(
          resultUrl,
          { method: "GET", headers: { accept: "application/json", authorization: `Bearer ${accessToken}` } },
          this.config.upstreamJsonBytes,
          this.config.upstreamTimeoutMs
        );
        if (!resultResponse.ok) {
          throw new HttpError(502, "fabric_unavailable", `Fabric operation result returned status ${resultResponse.status}`);
        }
        return this.parseCreatedNotebook(resultResponse.text);
      }
      if (status === "failed") {
        throw new HttpError(502, "fabric_unavailable", "Fabric notebook creation operation failed", {
          fabricError: stateResponse.data.error ?? null,
        });
      }

      const retryAfter = Number(initial.headers.get("retry-after"));
      const retryAfterMs = Number.isFinite(retryAfter) && retryAfter >= 0 ? retryAfter * 1000 : this.config.fabricOperationPollMs;
      await delay(Math.min(retryAfterMs, this.config.fabricOperationPollMs));
    }

    throw new HttpError(504, "fabric_operation_timeout", "Fabric accepted notebook creation but did not complete before the polling timeout");
  }

  private throwNotebookCreateError(status: number, text: string): never {
    const code = fabricErrorCode(text);
    if (status === 401 || status === 403) {
      throw new HttpError(
        403,
        "fabric_notebook_forbidden",
        "Fabric denied this user permission to create a notebook in the workspace. Check workspace role and delegated consent."
      );
    }
    if (status === 404) {
      throw new HttpError(
        404,
        "fabric_item_not_found",
        "Fabric could not find the workspace or lakehouse for this sync notebook."
      );
    }
    if (status === 409 || code === "ItemDisplayNameAlreadyInUse") {
      throw new HttpError(
        409,
        "fabric_item_name_conflict",
        "A Fabric item with this notebook display name already exists in the workspace."
      );
    }
    throw new HttpError(502, "fabric_unavailable", `Fabric returned status ${status} while creating the notebook`);
  }
}
