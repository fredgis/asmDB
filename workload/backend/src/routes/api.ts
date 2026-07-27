import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../http.js";
import { HttpError } from "../errors.js";
import type { CloudDatabaseService } from "../services/cloud-databases.js";
import type { CdcGatewayService } from "../services/cdc-gateway.js";
import type { CdcTokenService } from "../services/cdc-token.js";

const instanceIdSchema = z.string().regex(/^db_[a-z0-9_\-]{3,80}$/);
const previewQuerySchema = z.object({
  from: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
const cdcTokenBodySchema = z.object({ instanceId: instanceIdSchema });

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
