import { RazorLogo } from "@/components/brand/razor-logo";
import type { Metadata } from "next";
import { FundingPage } from "@/components/funding/funding-page";

export const metadata: Metadata = { title: "Fund a company | Razor", referrer: "no-referrer", robots: { index: false, follow: false } };

export default async function FundPage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const { token } = await searchParams;
  if (!token) return <main className="mx-auto max-w-2xl px-5 py-12"><a href="/" className="text-xl font-bold"><RazorLogo size={23}/></a><h1 className="mt-10 text-2xl font-semibold">Open a company funding link</h1><p className="mt-3 text-sm text-muted-foreground">Ask the company for a secure link with its funding amount and purpose.</p></main>;
  return <main className="mx-auto max-w-3xl px-5 py-8"><a href="/" className="mb-8 inline-block text-xl font-bold"><RazorLogo size={23}/></a><FundingPage key={token} token={token} /></main>;
}
