import { RazorLogo } from "@/components/brand/razor-logo";
import type { Metadata } from "next";
import { IdentityProvider } from "@/components/auth/identity-provider";
import { HelpCenter } from "@/components/help-center";
import { PublicSupport } from "@/components/workspace/support";

export const metadata:Metadata={title:"Help and private support | Razor",description:"Product guides for onboarding, funding, payroll, invoices, private processing, accounting and recovery. Sign in to record a private support case."};

export default function HelpPage() {
 return <main className="mx-auto grid max-w-5xl min-w-0 grid-cols-1 gap-8 px-5 py-10"><a href="/" className="w-fit text-xl font-bold"><RazorLogo size={23}/></a><header><h1 className="text-3xl font-semibold">Help with your company payments</h1><p className="mt-3 max-w-3xl text-sm leading-6 text-muted-foreground">Find the steps for the product you are using. Supported assets and configured providers depend on current availability. Your account and company permissions still apply.</p></header><HelpCenter/><section id="support" className="min-w-0 scroll-mt-6" aria-label="Private support"><IdentityProvider><PublicSupport/></IdentityProvider></section></main>;
}
