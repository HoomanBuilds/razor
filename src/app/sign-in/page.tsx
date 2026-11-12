import { IdentityProvider } from "@/components/auth/identity-provider";
import { SignInPanel } from "@/components/auth/sign-in-panel";

export default async function SignInPage({searchParams}:{searchParams:Promise<{next?:string;link?:string}>}) {
  const query=await searchParams;
  return <IdentityProvider><SignInPanel next={query.next} link={query.link==="true"}/></IdentityProvider>;
}
