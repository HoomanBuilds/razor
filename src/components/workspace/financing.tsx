"use client";
import { FinancingManagement } from "../financing-management";
import { useWorkspace } from "./context";
export function WorkingCapitalPanel() {
  const { base, organization, session, revision, refresh } = useWorkspace();
  if (!organization.permissions?.includes("payments:read")) return null;
  return (
    <FinancingManagement
      base={base}
      revision={revision}
      onRefresh={refresh}
      canManage={
        organization.owner_id === session.user.id &&
        organization.permissions.includes("company:manage") &&
        organization.permissions.includes("payments:approve")
      }
    />
  );
}
