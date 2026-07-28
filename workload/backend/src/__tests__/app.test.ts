import http from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { exportJWK, generateKeyPair, SignJWT, type JWK } from "jose";
import { createApp } from "../app.js";
import { loadConfig, type AppConfig } from "../config.js";
import type { ClientAssertionProvider } from "../services/obo.js";

const tenantId = "11111111-1111-1111-1111-111111111111";
const clientId = "22222222-2222-2222-2222-222222222222";

interface MockState {
  tokenStatus: number;
  tokenBody: unknown;
  tokenRequests: URLSearchParams[];
  databasesStatus: number;
  databasesBody: unknown;
  gatewayStatus: number;
  gatewayBody: string;
  gatewayHeaders: Record<string, string>;
  databaseCalls: number;
  fabricStatus: number;
  fabricBody: unknown;
  fabricOperationStates: unknown[];
  fabricOperationResult: unknown;
  fabricRequests: unknown[];
}

let publicJwk: JWK;
let privateKey: CryptoKey;
let server: http.Server;
let baseUrl: string;
let state: MockState;

function resetState(): void {
  state = {
    tokenStatus: 200,
    tokenBody: { access_token: "asmdb-user-token" },
    tokenRequests: [],
    databasesStatus: 200,
    databasesBody: {
      databases: [
        {
          id: "db_premium",
          name: "orders",
          tier: "premium",
          engine: "1.7.0",
          endpoint: "https://www.asmdb.cloud/db/premium",
          rows: "123456",
          capacity: "3145728",
        },
        {
          id: "db_free",
          name: "toy",
          tier: "free",
          engine: "1.7.0",
          endpoint: "https://www.asmdb.cloud/db/free",
          rows: "393216",
          capacity: "393216",
        },
      ],
    },
    gatewayStatus: 200,
    gatewayBody:
      '{"commitSeq":"4211","flags":{"reset":false},"ops":[{"op":"upsert","id":"1","record":{"value":42}}]}\n',
    gatewayHeaders: {
      "content-type": "application/x-ndjson",
      "x-asmdb-base-seq": "4200",
      "x-asmdb-last-seq": "4211",
      "x-asmdb-has-more": "false",
    },
    databaseCalls: 0,
    fabricStatus: 201,
    fabricBody: {
      id: "notebook-1",
      displayName: "asmDB sync",
      webUrl: "https://app.fabric.microsoft.com/notebooks/notebook-1",
    },
    fabricOperationStates: [{ status: "Succeeded", percentComplete: 100 }],
    fabricOperationResult: {
      id: "notebook-lro",
      displayName: "asmDB sync",
    },
    fabricRequests: [],
  };
}

function writeJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    nodeEnv: "test",
    port: 5010,
    tenantId,
    clientId,
    clientSecret: "dev-secret",
    useManagedIdentity: false,
    managedIdentityClientId: undefined,
    cloudApi: baseUrl,
    cloudScope: "api://asmdb-cloud/.default",
    fabricApi: baseUrl,
    gatewayUrl: baseUrl,
    gatewayToken: "gateway-secret",
    keyVaultUrl: "https://asmdb-test.vault.azure.net/",
    keyVaultSecretName: "asmdb-gateway-token",
    jwksUri: `${baseUrl}/jwks`,
    tokenEndpoint: `${baseUrl}/token`,
    requestBodyLimit: "16kb",
    upstreamJsonBytes: 1024 * 1024,
    upstreamCdcBytes: 256 * 1024,
    upstreamTimeoutMs: 1000,
    fabricOperationTimeoutMs: 100,
    fabricOperationPollMs: 1,
    cdcTokenTtlSeconds: 900,
    allowedOrigins: [],
    ...overrides,
  };
}

async function signToken(
  claims: Record<string, unknown> = {},
  audience: string = clientId
): Promise<string> {
  return new SignJWT({
    oid: "user-1",
    fabric_workspace_id: "workspace-1",
    ...claims,
  })
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setIssuer(`https://login.microsoftonline.com/${tenantId}/v2.0`)
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);
}

async function authedGetDatabases(app: ReturnType<typeof createApp>) {
  const token = await signToken();
  return request(app).get("/api/databases").set("authorization", `Bearer ${token}`);
}

beforeAll(async () => {
  const keyPair = await generateKeyPair("RS256", { extractable: true });
  privateKey = keyPair.privateKey;
  publicJwk = await exportJWK(keyPair.publicKey);
  publicJwk.kid = "test-key";
  publicJwk.alg = "RS256";
  publicJwk.use = "sig";

  resetState();
  server = http.createServer((req, res) => {
    void (async () => {
      if (req.url === "/jwks") {
        writeJson(res, 200, { keys: [publicJwk] });
        return;
      }
      if (req.url === "/token") {
        state.tokenRequests.push(new URLSearchParams(await readBody(req)));
        writeJson(res, state.tokenStatus, state.tokenBody);
        return;
      }
      if (req.url === "/databases") {
        state.databaseCalls += 1;
        writeJson(res, state.databasesStatus, state.databasesBody);
        return;
      }
      if (req.url?.startsWith("/cdc/")) {
        res.writeHead(state.gatewayStatus, state.gatewayHeaders);
        res.end(state.gatewayBody);
        return;
      }
      if (req.method === "GET" && req.url?.match(/^\/v1\/workspaces\/[^/]+\/items\?type=Lakehouse$/)) {
        writeJson(res, 200, {
          value: [
            {
              id: "44444444-4444-4444-8444-444444444444",
              displayName: "Lakehouse",
              type: "Lakehouse",
            },
          ],
        });
        return;
      }
      if (req.method === "POST" && req.url?.match(/^\/v1\/workspaces\/[^/]+\/notebooks$/)) {
        const body = JSON.parse(await readBody(req)) as unknown;
        state.fabricRequests.push(body);
        if (state.fabricStatus === 202) {
          res.writeHead(202, {
            location: `${baseUrl}/v1/operations/op-1`,
            "x-ms-operation-id": "op-1",
            "retry-after": "0",
          });
          res.end();
          return;
        }
        writeJson(res, state.fabricStatus, state.fabricBody);
        return;
      }
      if (req.method === "GET" && req.url === "/v1/operations/op-1") {
        const body = state.fabricOperationStates.shift() ?? { status: "Succeeded" };
        writeJson(res, 200, body);
        return;
      }
      if (req.method === "GET" && req.url === "/v1/operations/op-1/result") {
        writeJson(res, 200, state.fabricOperationResult);
        return;
      }
      writeJson(res, 404, { error: { code: "not_found" } });
    })();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test server port");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve()))
  );
});

beforeEach(() => {
  resetState();
});

describe("configuration", () => {
  it("fails startup when no OBO client credential mode is configured", () => {
    expect(() =>
      loadConfig({
        ASMDB_WL_ENTRA_TENANT_ID: tenantId,
        ASMDB_WL_ENTRA_CLIENT_ID: clientId,
        ASMDB_CLOUD_API: "https://www.asmdb.cloud/api/v1",
        ASMDB_GATEWAY_URL: "https://gateway.example",
        ASMDB_GATEWAY_TOKEN: "gateway-secret",
        ASMDB_KEY_VAULT_URL: "https://vault.example/",
      })
    ).toThrow(/ASMDB_WL_USE_MANAGED_IDENTITY=true.*ASMDB_WL_ENTRA_CLIENT_SECRET/s);
  });
});

describe("CORS", () => {  // The frontend is served from its own domain and calls this API from inside
  // the Fabric iframe, so the Origin is that domain, not a Fabric one.
  const frontend = "https://fe.asmdb.cloud";

  async function preflight(origin: string, allowedOrigins: string[] = [frontend]) {
    const app = createApp({ config: testConfig({ allowedOrigins }) });
    return request(app)
      .options("/api/databases")
      .set("origin", origin)
      .set("access-control-request-method", "GET");
  }

  it("allows the configured frontend origin", async () => {
    const res = await preflight(frontend);
    expect(res.headers["access-control-allow-origin"]).toBe(frontend);
  });

  it("allows Fabric and Power BI hosts", async () => {
    for (const origin of ["https://app.fabric.microsoft.com", "https://app.powerbi.com"]) {
      const res = await preflight(origin);
      expect(res.headers["access-control-allow-origin"]).toBe(origin);
    }
  });

  it("refuses an origin that is neither configured nor a host domain", async () => {
    const res = await preflight("https://evil.example");
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("refuses the frontend origin when it is not configured", async () => {
    const res = await preflight(frontend, []);
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });
});

describe("Fabric JWT validation", () => {
  it("rejects an absent JWT", async () => {
    const app = createApp({ config: testConfig() });
    const res = await request(app).get("/api/databases");
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("unauthorized");
  });

  it("rejects a malformed JWT", async () => {
    const app = createApp({ config: testConfig() });
    const res = await request(app)
      .get("/api/databases")
      .set("authorization", "Bearer not-a-jwt");
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("unauthorized");
  });

  it("rejects a JWT with the wrong audience", async () => {
    const token = await signToken();
    const app = createApp({ config: testConfig({ clientId: "wrong-audience" }) });
    const res = await request(app)
      .get("/api/databases")
      .set("authorization", `Bearer ${token}`);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("unauthorized");
    // Name the failing check. A bare "unauthorized" forces the next person to
    // guess between signature, issuer, audience and expiry.
    expect(res.body.error.message).toMatch(/Fabric token rejected/i);
  });

  // Entra sets the audience to whichever identifier the token was requested
  // for. Our Application ID URI is a custom https:// URI, so a real Fabric
  // token does not carry the client id GUID, and requiring it rejected every
  // genuine call with a 401 that explained nothing.
  it("accepts a token whose audience is the Application ID URI", async () => {
    const appIdUri = "https://workload.asmdb.cloud/fe/be/Org.AsmdbAnalytical/1";
    const token = await signToken({}, appIdUri);
    const app = createApp({ config: testConfig({ appIdUri }) });
    const res = await request(app)
      .get("/api/databases")
      .set("authorization", `Bearer ${token}`);
    expect(res.status).not.toBe(401);
  });

  // Listing the databases a user may access has nothing to do with a
  // workspace, and Entra does not necessarily issue a workspace claim.
  it("accepts a token that carries no workspace claim", async () => {
    const token = await signToken({ fabric_workspace_id: undefined });
    const app = createApp({ config: testConfig() });
    const res = await request(app)
      .get("/api/databases")
      .set("authorization", `Bearer ${token}`);
    expect(res.status).not.toBe(401);
  });

  it("rejects a JWT with the wrong issuer", async () => {
    const app = createApp({ config: testConfig({ tenantId: "33333333-3333-3333-3333-333333333333" }) });
    const token = await signToken();
    const res = await request(app)
      .get("/api/databases")
      .set("authorization", `Bearer ${token}`);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("unauthorized");
  });
});

describe("OBO client authentication", () => {
  it("sends a client secret in local-development credential mode", async () => {
    const app = createApp({ config: testConfig() });
    const res = await authedGetDatabases(app);

    expect(res.status).toBe(200);
    expect(state.tokenRequests).toHaveLength(1);
    expect(state.tokenRequests[0]?.get("client_secret")).toBe("dev-secret");
    expect(state.tokenRequests[0]?.get("client_assertion")).toBeNull();
    expect(state.tokenRequests[0]?.get("client_assertion_type")).toBeNull();
  });

  it("sends a managed-identity federated client assertion when configured", async () => {
    const provider: ClientAssertionProvider = { getAssertion: async () => "mi-assertion" };
    const app = createApp({
      config: testConfig({ useManagedIdentity: true, clientSecret: "dev-secret" }),
      clientAssertionProvider: provider,
    });
    const res = await authedGetDatabases(app);

    expect(res.status).toBe(200);
    expect(state.tokenRequests).toHaveLength(1);
    expect(state.tokenRequests[0]?.get("client_secret")).toBeNull();
    expect(state.tokenRequests[0]?.get("client_assertion")).toBe("mi-assertion");
    expect(state.tokenRequests[0]?.get("client_assertion_type")).toBe(
      "urn:ietf:params:oauth:client-assertion-type:jwt-bearer"
    );
  });
});

describe("asmDB workload API", () => {
  it("returns only premium databases", async () => {
    const token = await signToken();
    const app = createApp({ config: testConfig() });
    const res = await request(app)
      .get("/api/databases")
      .set("authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      databases: [
        {
          id: "db_premium",
          name: "orders",
          tier: "premium",
          engine: "1.7.0",
          endpoint: "https://www.asmdb.cloud/db/premium",
          rows: "123456",
          capacity: "3145728",
        },
      ],
    });
  });

  it("does not fall back to a service identity when OBO fails", async () => {
    state.tokenStatus = 400;
    state.tokenBody = { error: "invalid_grant" };
    const token = await signToken();
    const app = createApp({ config: testConfig() });

    const res = await request(app)
      .get("/api/databases")
      .set("authorization", `Bearer ${token}`);

    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe("obo_exchange_failed");
    expect(state.databaseCalls).toBe(0);
  });

  it("pins CDC pagination headers", async () => {
    state.gatewayHeaders["x-asmdb-has-more"] = "true";
    const token = await signToken();
    const app = createApp({ config: testConfig() });

    const res = await request(app)
      .get("/api/cdc/db_test123/preview?from=1&limit=20")
      .set("authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      baseSeq: "4200",
      lastSeq: "4211",
      hasMore: true,
    });
  });

  it("propagates cdc_gap as its own condition", async () => {
    state.gatewayStatus = 409;
    state.gatewayHeaders = { "content-type": "application/json" };
    state.gatewayBody = JSON.stringify({
      error: {
        code: "cdc_gap",
        message: "retention trimmed past requested sequence",
        baseSeq: "5000",
        requestedFrom: "120",
      },
    });
    const token = await signToken();
    const app = createApp({ config: testConfig() });

    const res = await request(app)
      .get("/api/cdc/db_test123/preview?from=120&limit=20")
      .set("authorization", `Bearer ${token}`);

    expect(res.status).toBe(409);
    expect(res.body.error).toEqual({
      code: "cdc_gap",
      message: "retention trimmed past requested sequence",
      baseSeq: "5000",
      requestedFrom: "120",
    });
  });

  it("propagates cdc_corrupt as its own condition with optional fields optional", async () => {
    state.gatewayStatus = 409;
    state.gatewayHeaders = { "content-type": "application/json" };
    state.gatewayBody = JSON.stringify({
      error: {
        code: "cdc_corrupt",
        message: "complete CDC frame failed CRC",
        detail: "crc mismatch",
        commitSeq: "4212",
      },
    });
    const token = await signToken();
    const app = createApp({ config: testConfig() });

    const res = await request(app)
      .get("/api/cdc/db_test123/preview?from=4212&limit=20")
      .set("authorization", `Bearer ${token}`);

    expect(res.status).toBe(409);
    expect(res.body.error).toEqual({
      code: "cdc_corrupt",
      message: "complete CDC frame failed CRC",
      detail: "crc mismatch",
      commitSeq: "4212",
    });
  });

  it("maps share_unreadable 503 as a transient client-visible condition", async () => {
    state.gatewayStatus = 503;
    state.gatewayHeaders = { "content-type": "application/json" };
    state.gatewayBody = JSON.stringify({
      error: {
        code: "share_unreadable",
        message: "share temporarily unreadable",
        detail: "permission denied",
      },
    });
    const token = await signToken();
    const app = createApp({ config: testConfig() });

    const res = await request(app)
      .get("/api/cdc/db_test123/preview?from=1&limit=20")
      .set("authorization", `Bearer ${token}`);

    expect(res.status).toBe(503);
    expect(res.body.error).toEqual({
      code: "share_unreadable",
      message: "share temporarily unreadable",
      detail: "permission denied",
    });
  });


  it("maps an infrastructure HTML 503 as transient, not malformed", async () => {
    state.gatewayStatus = 503;
    state.gatewayHeaders = { "content-type": "text/html" };
    state.gatewayBody = "<html><body>503 Service Unavailable</body></html>";
    const token = await signToken();
    const app = createApp({ config: testConfig() });

    const res = await request(app)
      .get("/api/cdc/db_test123/preview?from=1&limit=20")
      .set("authorization", `Bearer ${token}`);

    expect(res.status).toBe(503);
    expect(res.body.error).toEqual({
      code: "share_unreadable",
      message: "CDC gateway is temporarily unavailable",
      upstreamStatus: 503,
      upstreamBodySnippet: "<html><body>503 Service Unavailable</body></html>",
    });
  });

  it("refuses an oversized upstream response", async () => {
    state.gatewayBody = `${"x".repeat(200)}\n`;
    const token = await signToken();
    const app = createApp({ config: testConfig({ upstreamCdcBytes: 32 }) });

    const res = await request(app)
      .get("/api/cdc/db_test123/preview?limit=20")
      .set("authorization", `Bearer ${token}`);

    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe("upstream_too_large");
  });

  it("rate limits per route", async () => {
    const token = await signToken();
    const app = createApp({ config: testConfig(), rateLimits: { cdcToken: 1 } });

    const first = await request(app)
      .post("/api/cdc-token")
      .set("authorization", `Bearer ${token}`)
      .send({ instanceId: "db_test123" });
    const second = await request(app)
      .post("/api/cdc-token")
      .set("authorization", `Bearer ${token}`)
      .send({ instanceId: "db_test123" });

    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ instanceId: "db_test123" });
    expect(first.body.reference).toMatch(/^cdc_ref\./);
    expect(second.status).toBe(429);
    expect(second.body.error.code).toBe("rate_limited");
  });

  const notebookBody = {
    workspaceId: "33333333-3333-4333-8333-333333333333",
    displayName: "asmDB sync",
    sourceDatabaseId: "db_premium",
    sourceDatabaseName: "orders",
    lakehouseId: "44444444-4444-4444-8444-444444444444",
    lakehouseName: "Lakehouse",
    tablePrefix: "asmdb_",
    decoder: "JSON",
  } as const;

  async function postNotebook(app: ReturnType<typeof createApp>) {
    const token = await signToken();
    return request(app)
      .post("/api/notebooks")
      .set("authorization", `Bearer ${token}`)
      .send(notebookBody);
  }

  it("names missing notebook fields in 400 validation details", async () => {
    const token = await signToken();
    const app = createApp({ config: testConfig() });
    const { sourceDatabaseId: _sourceDatabaseId, ...bodyWithoutSourceId } = notebookBody;

    const res = await request(app)
      .post("/api/notebooks")
      .set("authorization", `Bearer ${token}`)
      .send(bodyWithoutSourceId);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({
      code: "bad_request",
      message: "Invalid notebook request body",
      validationErrors: expect.arrayContaining([
        expect.objectContaining({
          path: "sourceDatabaseId",
          message: expect.any(String),
        }),
      ]),
    });
    expect(JSON.stringify(res.body.error)).not.toContain("db_premium");
    expect(state.fabricRequests).toHaveLength(0);
  });

  it("names malformed notebook fields in 400 validation details", async () => {
    const token = await signToken();
    const app = createApp({ config: testConfig() });

    const res = await request(app)
      .post("/api/notebooks")
      .set("authorization", `Bearer ${token}`)
      .send({ ...notebookBody, lakehouseId: "not-a-guid" });

    expect(res.status).toBe(400);
    expect(res.body.error.validationErrors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "lakehouseId",
          message: expect.stringMatching(/uuid|guid/i),
        }),
      ])
    );
    expect(JSON.stringify(res.body.error)).not.toContain("not-a-guid");
    expect(state.fabricRequests).toHaveLength(0);
  });

  it("treats empty optional notebook fields as absent", async () => {
    const token = await signToken();
    const app = createApp({ config: testConfig() });

    const res = await request(app)
      .post("/api/notebooks")
      .set("authorization", `Bearer ${token}`)
      .send({ ...notebookBody, tablePrefix: "", decoder: "" });

    expect(res.status).toBe(201);
    const fabricRequest = state.fabricRequests[0] as {
      definition: { parts: Array<{ path: string; payload: string }> };
    };
    const contentPart = fabricRequest.definition.parts.find((part) => part.path === "artifact.content.ipynb");
    const decoded = Buffer.from(contentPart?.payload ?? "", "base64").toString("utf8");
    expect(decoded).toContain("orders");
    expect(decoded).not.toContain("asmdb_orders");
    expect(decoded).toContain('DECODER = \\"None\\"');
  });

  it("creates a notebook and sends substituted base64 notebook content", async () => {
    const app = createApp({ config: testConfig() });
    const res = await postNotebook(app);

    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      notebookId: "notebook-1",
      displayName: "asmDB sync",
      webUrl: "https://app.fabric.microsoft.com/notebooks/notebook-1",
    });
    expect(state.tokenRequests[0]?.get("scope")).toBe("https://api.fabric.microsoft.com/.default");

    const fabricRequest = state.fabricRequests[0] as {
      definition: { format: string; parts: Array<{ path: string; payload: string; payloadType: string }> };
    };
    expect(fabricRequest.definition.format).toBe("ipynb");
    const contentPart = fabricRequest.definition.parts.find((part) => part.path === "artifact.content.ipynb");
    expect(contentPart?.payloadType).toBe("InlineBase64");
    const decoded = Buffer.from(contentPart?.payload ?? "", "base64").toString("utf8");
    expect(() => JSON.parse(decoded)).not.toThrow();
    expect(decoded).toContain(baseUrl);
    expect(decoded).toContain("db_premium");
    expect(decoded).toContain("asmdb_orders");
    expect(decoded).toContain("https://asmdb-test.vault.azure.net/");
    expect(decoded).toContain("asmdb-gateway-token");
    expect(decoded).toContain('DECODER = \\"JSON\\"');
    expect(decoded).toContain("run_sync()");
    expect(decoded).not.toContain("__ASMDB_GATEWAY_URL__");
    expect(decoded).not.toContain("__ASMDB_KEY_VAULT_URL__");
  });

  it("polls long-running notebook creation and returns the operation result", async () => {
    state.fabricStatus = 202;
    state.fabricOperationStates = [{ status: "Running" }, { status: "Succeeded" }];
    const app = createApp({ config: testConfig() });

    const res = await postNotebook(app);

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ notebookId: "notebook-lro", displayName: "asmDB sync" });
  });

  it.each([
    [403, { errorCode: "InsufficientPrivileges" }, 403, "fabric_notebook_forbidden"],
    [404, { errorCode: "ItemNotFound" }, 404, "fabric_item_not_found"],
    [409, { errorCode: "ItemDisplayNameAlreadyInUse" }, 409, "fabric_item_name_conflict"],
    [500, { errorCode: "InternalError" }, 502, "fabric_unavailable"],
  ])(
    "maps Fabric notebook creation status %i to %s",
    async (fabricStatus, fabricBody, expectedStatus, expectedCode) => {
      state.fabricStatus = fabricStatus;
      state.fabricBody = fabricBody;
      const app = createApp({ config: testConfig() });

      const res = await postNotebook(app);

      expect(res.status).toBe(expectedStatus);
      expect(res.body.error.code).toBe(expectedCode);
    }
  );

  it("times out when Fabric accepts notebook creation but never completes it", async () => {
    state.fabricStatus = 202;
    state.fabricOperationStates = Array.from({ length: 200 }, () => ({ status: "Running" }));
    const app = createApp({ config: testConfig({ fabricOperationTimeoutMs: 5, fabricOperationPollMs: 1 }) });

    const res = await postNotebook(app);

    expect(res.status).toBe(504);
    expect(res.body.error.code).toBe("fabric_operation_timeout");
  });
});
