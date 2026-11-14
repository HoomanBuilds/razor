import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { RazorLanding } from "@/components/marketing/landing-page";
import { legacyWorkspacePath } from "@/lib/application-routes";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Razor | Company payments, without the busywork",
  description: "Manage crypto payroll, contractor payments, invoices and company treasury on NEAR. Fund with supported assets and let recipients choose how they receive.",
};

export default async function Home({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const legacy = legacyWorkspacePath(await searchParams);
  if (legacy) redirect(legacy);
  return <RazorLanding />;
}
