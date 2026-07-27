import { z } from "zod";
import type { AppConfig } from "../config.js";
import { HttpError } from "../errors.js";
import { fetchJsonCapped } from "./capped-fetch.js";
import type { OboTokenBroker } from "./obo.js";

const databaseSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    tier: z.string(),
    engine: z.string().optional(),
    endpoint: z.string().url().optional(),
    rows: z.union([z.string(), z.number()]).optional(),
    capacity: z.union([z.string(), z.number()]).optional(),
  })
  .passthrough();

const databasesSchema = z.object({ databases: z.array(databaseSchema) });

export interface WorkloadDatabase {
  id: string;
  name: string;
  tier: "premium";
  engine: string;
  endpoint: string;
  rows: string;
  capacity: string;
}

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

export class CloudDatabaseService {
  constructor(
    private readonly config: AppConfig,
    private readonly broker: OboTokenBroker
  ) {}

  async listPremium(userToken: string): Promise<WorkloadDatabase[]> {
    const accessToken = await this.broker.exchange(userToken);
    const response = await fetchJsonCapped(
      databasesSchema,
      joinUrl(this.config.cloudApi, "/databases"),
      {
        method: "GET",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${accessToken}`,
        },
      },
      this.config
    );

    if (response.status === 403) {
      throw new HttpError(403, "forbidden", "asmDB Cloud denied this user");
    }
    if (!response.ok) {
      throw new HttpError(
        502,
        "upstream_unavailable",
        `asmDB Cloud returned status ${response.status}`
      );
    }

    return response.data.databases
      .filter((database) => database.tier === "premium")
      .map((database) => ({
        id: database.id,
        name: database.name,
        tier: "premium",
        engine: database.engine ?? "unknown",
        endpoint: database.endpoint ?? "",
        rows: String(database.rows ?? "0"),
        capacity: String(database.capacity ?? "0"),
      }));
  }
}
