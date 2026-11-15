import { WORKSPACE_NAVIGATION_EVENT } from "@/lib/workspace-access";
import { focusWorkspaceForm } from "./page-metrics";

export function openFunding(companyId: string, id: string) {
  const location = new URL(window.location.href);
  location.searchParams.set("company", companyId);
  location.searchParams.set("section", "treasury");
  location.searchParams.set("funding", id);
  window.history.replaceState(null, "", location);
  window.dispatchEvent(new Event(WORKSPACE_NAVIGATION_EVENT));
  focusWorkspaceForm("treasury-funding-history");
}
