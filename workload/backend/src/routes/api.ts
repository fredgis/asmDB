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
const previewQuerySchema = z.object({
  from: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
const cdcTokenBodySchema = z.object({ instanceId: instanceIdSchema });
const notebookBodySchema = z.object({
  workspaceId: workspaceIdSchema,
  displayName: z.string().trim().min(1).max(256),
  sourceDatabaseId: instanceIdSchema,
  sourceDatabaseName: z.string().trim().min(1).max(128),
  lakehouseId: z.string().uuid(),
  lakehouseName: z.string().trim().min(1).max(128),
  tablePrefix: z.string().trim().max(64).optional(),
  decoder: z.enum(["None", "Hex", "Base64", "JSON", "CSV", "MessagePack"]).optional(),
  syncMode: z.enum(["cdc_incremental", "full_reload"]),
});

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
      const workspaceId = workspaceIdSchema.safeParse(req.query.workspaceId);
      if (!workspaceId.success) {
        throw new HttpError(400, "bad_request", "workspaceId must be a GUID");
      }
      const lakehouses = await services.fabric.listLakehouses(context.token, workspaceId.data);
      res.json({ lakehouses });
    })
  );

  router.post(
    "/notebooks",
    asyncHandler(async (req, res) => {
      const context = requireFabricContext(req);
      const body = notebookBodySchema.safeParse(req.body);
      if (!body.success) {
        throw new HttpError(400, "bad_request", "Invalid notebook request body");
      }

      const notebook = await services.fabric.createNotebook(context.token, body.data);
      res.status(201).json(notebook);
    })
  );

  router.get(
    "/cdc/:instanceId/preview",
    asyncHandler(async (req, res) => {
      const instanceIdResult = instanceIdSchema.safeParse(req.params.instanceId);
      if (!instanceIdResult.success) {
        throw new HttpError(400, "bad_request", "Invalid instanceId");
      }

      const query = previewQuerySchema.safeParse(req.query);
      if (!query.success) {
        throw new HttpError(400, "bad_request", "Invalid preview query");
      }

      const preview = await services.cdcGateway.preview(
        instanceIdResult.data,
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
        throw new HttpError(400, "bad_request", "Invalid cdc-token request body");
      }

      res.json(services.cdcTokens.mint(body.data.instanceId, context.userId));
    })
  );

  return router;
}
