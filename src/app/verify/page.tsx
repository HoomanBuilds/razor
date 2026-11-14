import type { Metadata } from "next";
import { PacketVerifier } from "@/components/verification/packet-verifier";

export const metadata: Metadata = { title: "Verify evidence | Razor", description: "Independently verify disclosed Razor evidence packets locally without workspace credentials." };

export default function VerifyPage() {
  return <main className="mx-auto max-w-5xl px-5 py-10"><a href="/" className="text-xl font-bold">Razor</a><h1 className="mb-4 mt-10 text-3xl font-semibold">Verify an evidence packet</h1><PacketVerifier /></main>;
}
