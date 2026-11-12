import { IdentityProvider } from "@/components/auth/identity-provider";
import { PortalAuth } from "@/components/recipient/portal-auth";
import { RecipientPortal } from "@/components/recipient/recipient-portal";

export default async function ReceivePage({searchParams}:{searchParams:Promise<{token?:string}>}) {
  const {token}=await searchParams;
  if(!token)return <main className="mx-auto max-w-2xl p-8"><a href="/" className="font-bold">FLOAT</a><h1 className="mt-8 text-2xl font-semibold">Open your recipient invitation</h1><p className="mt-3 text-sm text-muted-foreground">Ask your payer for a secure recipient link to choose your payout preferences.</p></main>;
  return <IdentityProvider><PortalAuth next={`/receive?token=${encodeURIComponent(token)}`}><main className="mx-auto max-w-3xl px-5 py-8"><a href="/" className="mb-8 inline-block text-xl font-bold">FLOAT</a><RecipientPortal token={token}/></main></PortalAuth></IdentityProvider>;
}
