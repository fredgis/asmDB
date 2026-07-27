import type { Request, Response, NextFunction } from "express";
import { createRemoteJWKSet, jwtVerify } from "jose";
import type { JWTPayload, JWTVerifyGetKey } from "jose";
import type { AppConfig } from "../config.js";
import { HttpError, errorBody } from "../errors.js";

export interface FabricContext {
  workspaceId?: string;
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

// Entra issues the audience as whichever identifier the caller requested the
// token for. With a custom Application ID URI - ours is an https:// URI rather
// than api://<guid> - that is the URI, not the client id. Accepting only the
// GUID rejects every real Fabric token with a bare 401 that says nothing about
// which claim disagreed.
function expectedAudiences(config: AppConfig): string[] {
  const audiences = [config.clientId, `api://${config.clientId}`];
  if (config.appIdUri) audiences.push(config.appIdUri);
  return audiences;
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
          audience: expectedAudiences(config),
        });

        const workspaceId = extractWorkspaceId(payload, req);
        const userId = payload["oid"] as string | undefined;

        // Only the user identity is required. A workspace is not: listing the
        // databases a user may access has nothing to do with a workspace, and
        // the endpoints that do need one take it as an explicit parameter.
        // Demanding a claim Entra may not issue turned every call into a 401.
        if (!userId) {
          throw new HttpError(
            401,
            "unauthorized",
            "Token is valid but carries no user object id (oid) claim"
          );
        }

        req.fabricContext = { workspaceId, userId, token };
        next();
      } catch (err: unknown) {
        // Say which check failed. A bare "unauthorized" forces the next person
        // to guess between signature, issuer, audience and expiry.
        const message = err instanceof Error ? err.message : "Failed to validate token";
        const error =
          err instanceof HttpError
            ? err
            : new HttpError(401, "unauthorized", `Fabric token rejected: ${message}`);
        res.status(error.status).json(errorBody(error));
      }
    })();
  };
}
