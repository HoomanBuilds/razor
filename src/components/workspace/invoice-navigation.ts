import { WORKSPACE_NAVIGATION_EVENT } from "@/lib/workspace-access";
import { focusWorkspaceForm } from "./page-metrics";

export function openInvoice(id: string) {
  const location = new URL(window.location.href);
  location.searchParams.set("invoice", id);
  location.searchParams.delete("reviewBill");
  window.history.replaceState(null, "", location);
  window.dispatchEvent(new Event(WORKSPACE_NAVIGATION_EVENT));
  focusWorkspaceForm("bills-content");
}
