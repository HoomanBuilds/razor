import { RazorLogo } from "@/components/brand/razor-logo";
import { IdentityProvider } from "@/components/auth/identity-provider";
import { JoinCompany } from "@/components/recipient/join-company";
import { PortalAuth } from "@/components/recipient/portal-auth";

export default async function JoinPage({searchParams}:{searchParams:Promise<{token?:string}>}) {
  const {token}=await searchParams;
  if(!token)return <main className="mx-auto max-w-2xl p-8"><a href="/" className="font-bold"><RazorLogo size={23}/></a><h1 className="mt-8 text-2xl font-semibold">Open your company invitation</h1><p className="mt-3 text-sm text-muted-foreground">Ask a company administrator for a new secure invitation link.</p></main>;
  return <IdentityProvider><PortalAuth next={`/join?token=${encodeURIComponent(token)}`}><main className="mx-auto max-w-2xl px-5 py-8"><a href="/" className="mb-8 inline-block text-xl font-bold"><RazorLogo size={23}/></a><JoinCompany token={token}/></main></PortalAuth></IdentityProvider>;
}
