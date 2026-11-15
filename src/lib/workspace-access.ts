import type { Section } from "../components/workspace/types";

export const WORKSPACE_NAVIGATION_EVENT = "razor:workspace-navigation";

const requirements: Record<Section, readonly string[]> = {
  overview: ["company:read"],
  payments: ["company:read", "payments:read"],
  payroll: ["company:read", "payments:read"],
  bills: ["company:read", "payments:read"],
  expenses: ["company:read", "payments:read", "documents:manage"],
  procurement: ["company:read", "payments:read"],
  distributions: ["company:read", "payments:read"],
  accounting: ["company:read", "company:manage", "payments:read", "reports:read"],
  support: ["company:read"],
  clearing: ["company:read", "payments:read"],
  recipients: ["company:read", "recipients:read"],
  treasury: ["company:read"],
  financing: ["company:read", "payments:read"],
  assistant: ["company:read", "payments:read"],
  activity: ["company:read", "reports:read"],
  billing: ["company:read"],
  settings: ["company:read"],
};

export function hasPermissions(permissions: readonly string[] | undefined, required: readonly string[]) {
  return required.every(permission => permissions?.includes(permission));
}

export function canOpenSection(section: Section, permissions: readonly string[] | undefined) {
  return !!requirements[section] && hasPermissions(permissions, requirements[section]);
}

export function workspacePath(companyId: string, section: Section, paymentId?: string, invoiceId?: string) {
  const params = new URLSearchParams({ company: companyId, section });
  if (section === "payments" && paymentId) params.set("payment", paymentId);
  if (section === "billing" && invoiceId) params.set("invoice", invoiceId);
  return `/app?${params}`;
}
