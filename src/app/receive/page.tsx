import { IdentityProvider } from "@/components/auth/identity-provider";
import { PortalAuth } from "@/components/recipient/portal-auth";
import { RecipientPortal } from "@/components/recipient/recipient-portal";
import { RecipientWorkspace } from "@/components/recipient/recipient-workspace";

export default async function ReceivePage({searchParams}:{searchParams:Promise<{token?:string}>}) {
  const {token}=await searchParams;
  return <IdentityProvider><PortalAuth next={token?`/receive?token=${encodeURIComponent(token)}`:"/receive"}><main className="mx-auto max-w-5xl px-5 py-8"><a href="/" className="mb-8 inline-block text-xl font-bold">Razor</a>{token?<RecipientPortal token={token}/>:<RecipientWorkspace/>}</main></PortalAuth></IdentityProvider>;
}
