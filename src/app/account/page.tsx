import { IdentityProvider } from "@/components/auth/identity-provider";
import { PortalAuth } from "@/components/recipient/portal-auth";
import { AccountRecoveryPanel } from "@/components/account/account-recovery-panel";

export default function AccountPage() {
  return <IdentityProvider><PortalAuth next="/account"><main className="mx-auto max-w-5xl px-5 py-8"><a href="/" className="mb-8 inline-block text-xl font-bold">Razor</a><AccountRecoveryPanel/></main></PortalAuth></IdentityProvider>;
}
