import {
  createWorkloadClient,
  InitParams,
  NotificationType,
} from "@ms-fabric/workload-client";
import { SYNC_HUB_EDITOR_PATH, SYNC_HUB_ITEM_TYPE, WORKLOAD_ID } from "./workload-constants";

const workloadName = WORKLOAD_ID;

export async function initialize(params: InitParams) {
  console.log("asmDB worker initialization", params);
  const workloadClient = createWorkloadClient();

  workloadClient.action.onAction(async ({ action, data }) => {
    console.log(`asmDB worker action: ${action}`, data);

    switch (action) {
      case "item.onCreationSuccess": {
        const itemData = data as { item?: { objectId?: string; itemType?: string } };
        const objectId = itemData.item?.objectId;
        if (itemData.item?.itemType && itemData.item.itemType !== SYNC_HUB_ITEM_TYPE) {
          console.warn(`Unexpected item type "${itemData.item.itemType}". Expected "${SYNC_HUB_ITEM_TYPE}" from the SyncHub manifest.`);
        }
        if (objectId) {
          workloadClient.page
            .open({ workloadName, route: `${SYNC_HUB_EDITOR_PATH}/${objectId}` as any })
            .catch((error: unknown) => console.error("Navigation error", error));
        }
        return { succeeded: true };
      }
      case "item.onCreationFailure": {
        const failureData = data as { errorCode?: string; resultCode?: string };
        await workloadClient.notification.open({
          title: "Error creating asmDB Analytical Capabilities",
          notificationType: NotificationType.Error,
          message: `Failed to create item. Error: ${failureData.errorCode ?? failureData.resultCode ?? "Unknown"}`,
        });
        return;
      }
      case "getItemSettings": {
        const settingsData = data as { item?: { objectId?: string } };
        return [
          {
            name: "about",
            displayName: "About",
            workloadSettingLocation: {
              workloadName,
              route: `${SYNC_HUB_EDITOR_PATH}-about/${settingsData.item?.objectId ?? ""}` as any,
            },
          },
        ];
      }
      default:
        return {};
    }
  });
}


