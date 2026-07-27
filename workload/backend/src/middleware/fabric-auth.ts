import type { Request, Response, NextFunction } from "express";
import { createRemoteJWKSet, jwtVerify } from "jose";
import type { JWTPayload, JWTVerifyGetKey } from "jose";
import type { AppConfig } from "../config.js";
import { HttpError, errorBody } from "../errors.js";

export interface FabricContext {
  workspaceId: string;
  userId: string;
  token: string;
}

declare global {
  namespace Express {
    interface Request {
      fabricContext?: FabricContext;
    }
  }
}

let cachedJwksUri: string | undefined;
let cachedJWKS: JWTVerifyGetKey | undefined;

function getJWKS(config: AppConfig): JWTVerifyGetKey {
  const jwksUri =
    config.jwksUri ??
    `https://login.microsoftonline.com/${config.tenantId}/discovery/v2.0/keys`;

  if (cachedJWKS && cachedJwksUri === jwksUri) return cachedJWKS;

  cachedJwksUri = jwksUri;
  cachedJWKS = createRemoteJWKSet(new URL(jwksUri));
  return cachedJWKS;
}

function expectedIssuers(tenantId: string): string[] {
  return [
    `https://login.microsoftonline.com/${tenantId}/v2.0`,
    `https://sts.windows.net/${tenantId}/`,
  ];
}

function extractWorkspaceId(payload: JWTPayload, req: Request): string | undefined {
  const fromClaims =
    (payload["fabric_workspace_id"] as string | undefined) ??
    (payload["workspaceId"] as string | undefined);
  if (fromClaims) return fromClaims;

  const fromHeader = req.headers["x-fabric-workspace-id"];
  return typeof fromHeader === "string" && fromHeader.length > 0
    ? fromHeader
    : undefined;
}

export function fabricAuthMiddleware(config: AppConfig) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const authHeader = req.headers.authorization;

    if (!authHeader?.startsWith("Bearer ")) {
      const error = new HttpError(
        401,
        "unauthorized",
        "Missing or invalid Authorization header"
      );
      res.status(error.status).json(errorBody(error));
      return;
    }

    const token = authHeader.substring(7);

    void (async () => {
      try {
        const { payload } = await jwtVerify(token, getJWKS(config), {
          issuer: expectedIssuers(config.tenantId),
          audience: config.clientId,
        });

        const workspaceId = extractWorkspaceId(payload, req);
        const userId = payload["oid"] as string | undefined;

        if (!workspaceId || !userId) {
          throw new HttpError(
            401,
            "unauthorized",
            "Invalid token claims: missing workspace ID or user object ID (oid)"
          );
        }

        req.fabricContext = { workspaceId, userId, token };
        next();
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : "Failed to validate token";
        const error =
          err instanceof HttpError
            ? err
            : new HttpError(401, "unauthorized", message);
        res.status(error.status).json(errorBody(error));
      }
    })();
  };
}
