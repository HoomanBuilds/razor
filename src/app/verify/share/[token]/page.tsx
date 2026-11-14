import type { Metadata } from "next";
import { PublicEvidenceShareViewer } from "@/components/evidence-sharing/viewer";
export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Shared evidence | Razor",
  description: "Read a deliberately disclosed frozen portable evidence packet.",
  referrer: "no-referrer",
  robots: { index: false, follow: false, noarchive: true },
};
export default async function EvidenceSharePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  return (
    <main className="mx-auto max-w-5xl px-5 py-10">
      <a href="/" rel="noreferrer" className="text-xl font-bold">
        Razor
      </a>
      <h1 className="mb-4 mt-10 text-3xl font-semibold">
        Review shared evidence
      </h1>
      <PublicEvidenceShareViewer token={token} />
    </main>
  );
}
