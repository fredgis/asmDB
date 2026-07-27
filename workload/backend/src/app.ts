import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import type { AppConfig } from "./config.js";
import { loadConfig } from "./config.js";
import { fabricAuthMiddleware } from "./middleware/fabric-auth.js";
import { OboTokenBroker, type ClientAssertionProvider } from "./services/obo.js";
import { CloudDatabaseService } from "./services/cloud-databases.js";
import { CdcGatewayService } from "./services/cdc-gateway.js";
import { CdcTokenService } from "./services/cdc-token.js";
import { FabricService } from "./services/fabric.js";
import { apiRouter } from "./routes/api.js";
import { healthRouter } from "./routes/health.js";
import { errorBody, HttpError } from "./errors.js";
import { errorMiddleware } from "./http.js";

const VERSION = "0.1.0";

export interface RateLimitOverrides {
  databases?: number;
  notebooks?: number;
  cdcPreview?: number;
  cdcToken?: number;
}

export interface CreateAppOptions {
  config?: AppConfig;
  rateLimits?: RateLimitOverrides;
  clientAssertionProvider?: ClientAssertionProvider;
}

function rateLimiter(limit: number) {
  return rateLimit({
    windowMs: 60 * 1000,
    limit,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    message: errorBody(new HttpError(429, "rate_limited", "Too many requests")),
  });
}

function corsOrigin(config: AppConfig) {
  const allowList = new Set(
    config.allowedOrigins.map((origin) => origin.replace(/\/+$/, "").toLowerCase())
  );

  return (
    origin: string | undefined,
    callback: (err: Error | null, allow?: boolean) => void
  ): void => {
    if (!origin) {
      callback(null, true);
      return;
    }

    // The workload frontend is served from its own domain and calls this API
    // from inside the Fabric iframe, so the browser sends that domain as the
    // Origin - not a fabric.microsoft.com one. Allowing only Fabric hosts
    // blocks every real request, and the failure surfaces as a bare "backend
    // unavailable" with the actual reason visible only in the browser console.
    const allowed =
      allowList.has(origin.replace(/\/+$/, "").toLowerCase()) ||
      /^https:\/\/[a-z0-9.-]+\.fabric\.microsoft\.com$/i.test(origin) ||
      /^https:\/\/[a-z0-9.-]+\.powerbi\.com$/i.test(origin) ||
      (config.nodeEnv === "development" && /^https?:\/\/localhost(:\d+)?$/i.test(origin));

    callback(null, allowed);
  };
}

export function createApp(options: CreateAppOptions = {}) {
  const config = options.config ?? loadConfig();
  const broker = new OboTokenBroker(config, options.clientAssertionProvider);
  const services = {
    databases: new CloudDatabaseService(config, broker),
    cdcGateway: new CdcGatewayService(config),
    cdcTokens: new CdcTokenService(config),
    fabric: new FabricService(config, broker),
  };

  const app = express();
  app.set("trust proxy", 1);
  app.use(cors({ origin: corsOrigin(config), credentials: true }));
  app.use(express.json({ limit: config.requestBodyLimit }));

  const auth = fabricAuthMiddleware(config);
  const limits = {
    databases: options.rateLimits?.databases ?? 60,
    notebooks: options.rateLimits?.notebooks ?? 20,
    cdcPreview: options.rateLimits?.cdcPreview ?? 30,
    cdcToken: options.rateLimits?.cdcToken ?? 20,
  };

  app.use("/health", healthRouter(VERSION));
  app.use("/api/databases", rateLimiter(limits.databases), auth);
  app.use("/api/lakehouses", rateLimiter(limits.databases), auth);
  app.use("/api/notebooks", rateLimiter(limits.notebooks), auth);
  app.use("/api/cdc", rateLimiter(limits.cdcPreview), auth);
  app.use("/api/cdc-token", rateLimiter(limits.cdcToken), auth);
  app.use("/api", apiRouter(services));
  app.use(errorMiddleware);

  return app;
}

