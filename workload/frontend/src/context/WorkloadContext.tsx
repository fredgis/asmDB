import React, { createContext, useContext } from "react";
import type { WorkloadClientAPI } from "@ms-fabric/workload-client";

interface WorkloadContextType {
  workloadClient: WorkloadClientAPI | null;
}

const WorkloadContext = createContext<WorkloadContextType>({
  workloadClient: null,
});

export const WorkloadProvider: React.FC<{
  workloadClient: WorkloadClientAPI | null;
  children: React.ReactNode;
}> = ({ workloadClient, children }) => (
  <WorkloadContext.Provider value={{ workloadClient }}>
    {children}
  </WorkloadContext.Provider>
);

export const useWorkloadClient = (): WorkloadClientAPI | null => {
  const context = useContext(WorkloadContext);
  return context.workloadClient;
};

export const useWorkloadContext = useWorkloadClient;

