import { Router } from "express";
import { z } from "zod";
import { HttpError } from "../errors.js";
import { asyncHandler } from "../http.js";
import type { CdcGatewayService } from "../services/cdc-gateway.js";

function validationError(message: string, error: z.ZodError): HttpError {
  return new HttpError(400, "bad_request", message, {
    validationErrors: error.issues.map((issue) => ({
      path: issue.path.length > 0 ? issue.path.map(String).join(".") : "(root)",
      message: issue.message,
    })),
  });
}

const instanceIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/, "Instance id must be alphanumeric with underscores or hyphens");

const paramsSchema = z.object({ instanceId: instanceIdSchema });

/**
 * The gateway caps a page at 1000 frames and advertises the rest through
 * x-asmdb-has-more, so it accepts a larger limit and simply returns fewer. The
 * notebook relies on that and asks for PAGE_LIMIT = 5000. Rejecting the request
 * instead of clamping it would make this route stricter than the gateway it
 * fronts, which is exactly how the first version of it broke every sync.
 */
const GATEWAY_PAGE_LIMIT = 1000;
const querySchema = z.object({
  from: z.coerce.number().int().min(0).default(0),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .default(GATEWAY_PAGE_LIMIT)
    .transform((value) => Math.min(value, GATEWAY_PAGE_LIMIT)),
});

/**
 * Fabric Spark cannot reach the CDC gateway. The gateway runs in an internal Container
 * Apps environment, and Fabric does not create a private DNS zone for that resource type,
 * so a managed private endpoint leaves the hostname resolving to the public address.
 * The backend already reaches the gateway over VNet integration, so generated notebooks
 * read their change log through this passthrough instead.
 *
 * The caller's bearer token is forwarded unchanged: the gateway stays the sole authority
 * on who may read a change log, and the backend adds no second opinion.
 */
export function syncRouter(services: { cdcGateway: CdcGatewayService }): Router {
  const router = Router();

  router.get(
    "/cdc/:instanceId",
    asyncHandler(async (req, res) => {
      const params = paramsSchema.safeParse(req.params);
      if (!params.success) {
        throw validationError("Invalid CDC path", params.error);
      }

      const query = querySchema.safeParse(req.query);
      if (!query.success) {
        throw validationError("Invalid CDC query", query.error);
      }

      const authorization = req.header("authorization");
      if (!authorization) {
        throw new HttpError(
          401,
          "unauthorized",
          "This route forwards the caller's bearer token to the CDC gateway. Send the gateway token in the Authorization header."
        );
      }

      const upstream = await services.cdcGateway.passthrough(
        params.data.instanceId,
        String(query.data.from),
        query.data.limit,
        authorization
      );

      for (const [name, value] of Object.entries(upstream.headers)) {
        res.setHeader(name, value);
      }
      res.status(upstream.status).send(upstream.body);
    })
  );

  return router;
}
