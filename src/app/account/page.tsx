import { IdentityProvider } from "@/components/auth/identity-provider";
import { PortalAuth } from "@/components/recipient/portal-auth";
import { AccountDashboard } from "@/components/account/account-dashboard";
import { accountView } from "@/lib/account-navigation";

export default async function AccountPage({ searchParams }: { searchParams: Promise<{ view?: string; returnTo?: string }> }) {
  const query = await searchParams, params = new URLSearchParams();
  if (accountView(query.view) !== "profile") params.set("view", accountView(query.view));
  if (typeof query.returnTo === "string" && query.returnTo.length <= 2000) params.set("returnTo", query.returnTo);
  const next = `/account${params.size ? `?${params}` : ""}`;
  return <IdentityProvider><PortalAuth next={next}><AccountDashboard initialView={accountView(query.view)} returnTo={query.returnTo}/></PortalAuth></IdentityProvider>;
}
