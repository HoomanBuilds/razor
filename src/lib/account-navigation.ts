import { appHref, isPublicDemo } from "./demo-scope";
import { localRedirect } from "./redirect-path";
import { workspacePath } from "./workspace-access";

export const ACCOUNT_VIEWS = ["profile", "wallets", "security", "recovery"] as const;
export type AccountView = typeof ACCOUNT_VIEWS[number];

export function accountView(value: unknown): AccountView {
  return ACCOUNT_VIEWS.some(view => view === value) ? value as AccountView : "profile";
}

export function accountReturnPath(companyIds: readonly string[], activeCompanyId: string | null, requested?: unknown) {
  const fallback = activeCompanyId && companyIds.includes(activeCompanyId) ? workspacePath(activeCompanyId, "overview") : appHref("/app");
  if (typeof requested !== "string") return fallback;
  const safe = localRedirect(requested, fallback), url = new URL(safe, "https://razor.invalid");
  if (url.pathname === "/receive") return appHref(safe);
  if (isPublicDemo() && url.pathname === "/demo") {const company=url.searchParams.get("company");return company&&!companyIds.includes(company)?fallback:safe;}
  if (url.pathname !== "/app") return fallback;
  const company = url.searchParams.get("company");
  return company && !companyIds.includes(company) ? fallback : appHref(safe);
}
