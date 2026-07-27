import { z } from "zod";
import type { AppConfig } from "../config.js";
import { HttpError } from "../errors.js";
import { fetchJsonCapped } from "./capped-fetch.js";
import type { OboTokenBroker } from "./obo.js";

// The Fabric REST API will not accept the token the frontend holds: the
// workload client issues a token whose audience is the workload's own app, and
// the SDK says so explicitly - additionalScopesToConsent is documented as the
// fallback "when failing to perform OBO flows in the workload's Backend". So
// the exchange belongs here, next to the one for asmDB Cloud, rather than in
// the browser where it would simply return 401.
const FABRIC_SCOPE = "https://api.fabric.microsoft.com/.default";

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

export interface Lakehouse {
  id: string;
  name: string;
  workspaceId: string;
}

export class FabricService {
  constructor(
    private readonly config: AppConfig,
    private readonly broker: OboTokenBroker
  ) {}

  async listLakehouses(userToken: string, workspaceId: string): Promise<Lakehouse[]> {
    const accessToken = await this.broker.exchange(userToken, FABRIC_SCOPE);
    const url = `https://api.fabric.microsoft.com/v1/workspaces/${encodeURIComponent(
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
}
