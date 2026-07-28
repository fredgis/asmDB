import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../http.js";
import { HttpError } from "../errors.js";
import type { CloudDatabaseService } from "../services/cloud-databases.js";
import type { CdcGatewayService } from "../services/cdc-gateway.js";
import type { CdcTokenService } from "../services/cdc-token.js";
import type { FabricService } from "../services/fabric.js";

const instanceIdSchema = z.string().regex(/^db_[a-z0-9_\-]{3,80}$/);
const workspaceIdSchema = z.string().uuid();
const lakehousesQuerySchema = z.object({ workspaceId: workspaceIdSchema });
const previewQuerySchema = z.object({
  from: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
const cdcPreviewParamsSchema = z.object({ instanceId: instanceIdSchema });
const cdcTokenBodySchema = z.object({ instanceId: instanceIdSchema });
const optionalTrimmedString = (maxLength: number) =>
  z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
    z.string().trim().max(maxLength).optional()
  );
const optionalDecoderSchema = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.enum(["None", "Hex", "Base64", "JSON", "CSV", "MessagePack"]).optional()
);
const notebookBodySchema = z
  .object({
    workspaceId: workspaceIdSchema,
    displayName: z.string().trim().min(1).max(256),
    sourceDatabaseId: instanceIdSchema,
    sourceDatabaseName: z.string().trim().min(1).max(128),
    lakehouseId: z.string().uuid(),
    lakehouseName: z.string().trim().min(1).max(128),
    tablePrefix: optionalTrimmedString(64),
    decoder: optionalDecoderSchema,
  })
  .strict();

function validationError(message: string, error: z.ZodError): HttpError {
  return new HttpError(400, "bad_request", message, {
    validationErrors: error.issues.map((issue) => ({
      path: issue.path.length > 0 ? issue.path.map(String).join(".") : "(root)",
      message: issue.message,
    })),
  });
}

function requireFabricContext(req: Express.Request) {
  if (!req.fabricContext) {
    throw new HttpError(401, "unauthorized", "Fabric context is missing");
  }
  return req.fabricContext;
}

export function apiRouter(services: {
  databases: CloudDatabaseService;
  cdcGateway: CdcGatewayService;
  cdcTokens: CdcTokenService;
  fabric: FabricService;
}): Router {
  const router = Router();

  router.get(
    "/databases",
    asyncHandler(async (req, res) => {
      const context = requireFabricContext(req);
      const databases = await services.databases.listPremium(context.token);
      res.json({ databases });
    })
  );

  router.get(
    "/lakehouses",
    asyncHandler(async (req, res) => {
      const context = requireFabricContext(req);
      const query = lakehousesQuerySchema.safeParse(req.query);
      if (!query.success) {
        throw validationError("Invalid lakehouses query", query.error);
      }
      const lakehouses = await services.fabric.listLakehouses(context.token, query.data.workspaceId);
      res.json({ lakehouses });
    })
  );

  router.post(
    "/notebooks",
    asyncHandler(async (req, res) => {
      const context = requireFabricContext(req);
      const body = notebookBodySchema.safeParse(req.body);
      if (!body.success) {
        throw validationError("Invalid notebook request body", body.error);
      }

      const notebook = await services.fabric.createNotebook(context.token, body.data);
      res.status(201).json(notebook);
    })
  );

  router.get(
    "/cdc/:instanceId/preview",
    asyncHandler(async (req, res) => {
      const params = cdcPreviewParamsSchema.safeParse(req.params);
      if (!params.success) {
        throw validationError("Invalid CDC preview path", params.error);
      }

      const query = previewQuerySchema.safeParse(req.query);
      if (!query.success) {
        throw validationError("Invalid preview query", query.error);
      }

      const preview = await services.cdcGateway.preview(
        params.data.instanceId,
        String(query.data.from),
        query.data.limit
      );
      res.json(preview);
    })
  );

  router.post(
    "/cdc-token",
    asyncHandler(async (req, res) => {
      const context = requireFabricContext(req);
      const body = cdcTokenBodySchema.safeParse(req.body);
      if (!body.success) {
        throw validationError("Invalid cdc-token request body", body.error);
      }

      res.json(services.cdcTokens.mint(body.data.instanceId, context.userId));
    })
  );

  return router;
}
