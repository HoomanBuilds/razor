import { IdentityProvider } from "@/components/auth/identity-provider";
import { PortalAuth } from "@/components/recipient/portal-auth";
import { RecipientPortal } from "@/components/recipient/recipient-portal";
import { RecipientWorkspace } from "@/components/recipient/recipient-workspace";

export default async function ReceivePage({searchParams}:{searchParams:Promise<{token?:string;paymentId?:string;recipientId?:string;view?:string}>}) {
  const query=await searchParams,params=new URLSearchParams();
  for(const name of ["token","paymentId","recipientId","view"] as const)if(typeof query[name]==="string"&&query[name]!.length<=128)params.set(name,query[name]!);
  const token=params.get("token"),next=`/receive${params.size?`?${params}`:""}`;
  return <IdentityProvider><PortalAuth next={next}>{token?<main className="mx-auto max-w-6xl px-5 py-8 sm:px-8"><a href="/receive" className="mb-8 inline-flex items-center gap-3 text-xl font-semibold"><span className="grid size-9 place-items-center rounded-xl bg-primary text-lg text-white">R</span>Razor</a><RecipientPortal key={token} token={token}/></main>:<RecipientWorkspace/>}</PortalAuth></IdentityProvider>;
}
