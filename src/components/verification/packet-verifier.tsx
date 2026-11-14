"use client";

import { useState } from "react";
import { MAX_PACKET_BYTES, parsePacket, verifierTrustSchema, type PortablePacket, type VerificationClaim, type VerifierTrust } from "@/lib/verification/packet";
import { historicalNearLookup } from "@/lib/verification/near-history";
import { verifyPacket } from "@/lib/verification/verify";

export function PacketVerifier() {
  const [packet, setPacket] = useState<PortablePacket | null>(null), [trust, setTrust] = useState<VerifierTrust | undefined>(), [claims, setClaims] = useState<VerificationClaim[] | null>(null);
  const [error, setError] = useState(""), [busy, setBusy] = useState(false), [rpcUrl, setRpcUrl] = useState(""), [networkEnabled, setNetworkEnabled] = useState(false);
  async function readFile(file: File | undefined, kind: "packet" | "trust") {
    setClaims(null); setError("");
    if (kind === "packet") setPacket(null); else setTrust(undefined);
    if (!file) return;
    setBusy(true);
    try {
      if (file.size > (kind === "packet" ? MAX_PACKET_BYTES : 100_000)) throw new Error(kind === "packet" ? "Evidence packet exceeds 40 MB" : "Trust input exceeds 100 KB");
      const text = await file.text();
      if (kind === "packet") setPacket(parsePacket(text)); else setTrust(verifierTrustSchema.parse(JSON.parse(text)));
    } catch { setError(`Invalid ${kind} file. Check the JSON format, version and size.`); }
    finally { setBusy(false); }
  }
  async function verify() {
    if (!packet) return;
    setBusy(true); setClaims(null); setError("");
    try { setClaims(await verifyPacket(packet, { trust, ...(networkEnabled ? { lookupHistory: historicalNearLookup(rpcUrl) } : {}) })); }
    catch { setError("Verification could not run. Check the packet, trust inputs and RPC URL."); }
    finally { setBusy(false); }
  }
  return <div className="space-y-6">
    <p className="text-sm leading-6 text-muted-foreground">Open an exported JSON packet to verify its disclosed encrypted wire bytes and model signature on this device. No workspace sign-in, AI key or file upload is required. Hardware identity, decrypted content and destination settlement are separate claims.</p>
    <fieldset disabled={busy} className="grid gap-5 rounded-xl border p-5">
      <label className="grid gap-2 text-sm font-medium">Evidence packet (JSON, up to 40 MB)<input type="file" accept="application/json,.json" onChange={event => void readFile(event.target.files?.[0], "packet")} /></label>
      <label className="grid gap-2 text-sm font-medium">Optional independently reviewed trust input (JSON, up to 100 KB)<input type="file" accept="application/json,.json" onChange={event => void readFile(event.target.files?.[0], "trust")} /><span className="font-normal text-xs leading-5 text-muted-foreground">Obtain expected signer, deployment hashes and financial references from a source you trust. An allowlist supplied by the packet author does not establish trust. This input checks expectations; it does not replace Intel/NVIDIA hardware verification.</span></label>
      <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1" checked={networkEnabled} onChange={event => { setNetworkEnabled(event.target.checked); setClaims(null); }} /><span>Enable historical NEAR RPC lookups. This sends public contract, payment and transaction references to the RPC you choose. Offline checks make no network requests.</span></label>
      {networkEnabled && <label className="grid gap-2 text-sm font-medium">Archival NEAR RPC URL<input type="url" required className="rounded-md border bg-background p-2 font-normal" placeholder="https://your-archival-near-rpc" value={rpcUrl} onChange={event => { setRpcUrl(event.target.value); setClaims(null); }} /><span className="font-normal text-xs text-muted-foreground">The selected RPC is a trusted observation source. Lookups use the execution block, with no fallback to current state. RPC responses are not light-client proofs.</span></label>}
      <button type="button" disabled={!packet || busy || networkEnabled && !rpcUrl} onClick={() => void verify()} className="justify-self-start rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50">{busy ? "Checking evidence..." : "Verify locally"}</button>
    </fieldset>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {packet && <p className="break-all text-xs text-muted-foreground">Loaded {packet.subject.kind}: {packet.subject.id}. Disclosure: {packet.disclosure.mode}. The subject association and observed execution time remain exporter assertions.</p>}
    {claims && <div aria-live="polite" className="space-y-4"><p className="text-sm font-medium">{claims.filter(item => item.status === "passed").length} passed, {claims.filter(item => item.status === "failed").length} failed, {claims.filter(item => item.status === "unavailable").length} unavailable, {claims.filter(item => item.status === "not_checked").length} not checked. Read each claim's scope.</p><div className="overflow-x-auto rounded-xl border"><table className="w-full text-left text-sm"><caption className="sr-only">Independent evidence verification results</caption><thead className="bg-muted"><tr><th scope="col" className="p-3">Claim</th><th scope="col" className="p-3">Result</th><th scope="col" className="p-3">Scope and limitations</th></tr></thead><tbody>{claims.map(item => <tr key={item.claim} className="border-t align-top"><th scope="row" className="break-words p-3 font-medium">{item.claim.replaceAll("_", " ")}</th><td className="whitespace-nowrap p-3">{item.status.replaceAll("_", " ")}</td><td className="min-w-64 p-3 leading-6 text-muted-foreground">{item.detail}</td></tr>)}</tbody></table></div></div>}
    <p className="text-xs leading-5 text-muted-foreground">No signature proves that an invoice or model conclusion is factually correct. Downloaded files cannot be revoked or expired remotely. Share only the disclosure you intend to make.</p>
    <details className="text-xs"><summary className="cursor-pointer font-medium">Trust file format and local command</summary><p className="my-3 leading-5 text-muted-foreground">Replace the example values with independently reviewed inputs. Omit fields you cannot independently establish. Trust files never come from automatic packet allowlists.</p><pre className="overflow-x-auto rounded-lg bg-muted p-3">{'{"schema":"razor.verifier-trust","version":1,"expectedModel":"reviewed-model-id","expectedSigner":{"signingAlgo":"ed25519","signingAddress":"reviewed-public-key-hex"},"approvedModelComposeSha256":["reviewed-compose-sha256"]}'}</pre><pre className="mt-3 overflow-x-auto rounded-lg bg-muted p-3">node --max-old-space-size=512 --import tsx scripts/verify-evidence.ts packet.json --trust reviewed-trust.json</pre><p className="mt-3 leading-5 text-muted-foreground">The standalone CLI exits 1 for failed claims or invalid input and 2 for incomplete verification. Use --help for RPC options and limits.</p></details>
  </div>;
}
