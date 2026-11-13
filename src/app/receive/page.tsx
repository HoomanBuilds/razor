import { IdentityProvider } from "@/components/auth/identity-provider";
import { PortalAuth } from "@/components/recipient/portal-auth";
import { RecipientPortal } from "@/components/recipient/recipient-portal";
import { RecipientWorkspace } from "@/components/recipient/recipient-workspace";

export default async function ReceivePage({searchParams}:{searchParams:Promise<{token?:string;paymentId?:string;recipientId?:string}>}) {
  const query=await searchParams,params=new URLSearchParams();
  for(const name of ["token","paymentId","recipientId"] as const)if(typeof query[name]==="string"&&query[name]!.length<=128)params.set(name,query[name]!);
  const token=params.get("token"),next=`/receive${params.size?`?${params}`:""}`;
  return <IdentityProvider><PortalAuth next={next}><main className="mx-auto max-w-5xl px-5 py-8"><a href="/" className="mb-8 inline-block text-xl font-bold">Razor</a>{token?<RecipientPortal token={token}/>:<RecipientWorkspace/>}</main></PortalAuth></IdentityProvider>;
}
