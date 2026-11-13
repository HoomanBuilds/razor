"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { api, errorMessage, RequestError } from "@/lib/api";
import { usd } from "@/lib/format";
import { AssetGuidance } from "@/components/assets/asset-guidance";
import type { PublicFundingRequest, PublicQuoteResult } from "@/server/funding-requests/types";
import type { Token } from "@/server/payments/intents";
import { useAction } from "@/components/workspace/hooks";
import { Action, control, Empty, Field, Panel, Status } from "@/components/workspace/shared";

const FundingWalletAction = dynamic(() => import("@/components/auth/funding-wallet").then((module) => module.FundingWalletAction), { ssr: false });
const storageKey = (id: string) => `razor:funding-request:${id}:quote`;
function savedKey(id: string) {
  try { const value = sessionStorage.getItem(storageKey(id)); return value && /^[A-Za-z0-9_-]{16,128}$/.test(value) ? value : ""; } catch { return ""; }
}
function saveKey(id: string, key: string) { try { sessionStorage.setItem(storageKey(id), key); } catch {} }

export function FundingPage({ token }: { token: string }) {
  const [request, setRequest] = useState<PublicFundingRequest | null>(null);
  const [tokens, setTokens] = useState<Token[]>([]);
  const [quote, setQuote] = useState<PublicQuoteResult | null>(null);
  const [quoteKey, setQuoteKey] = useState("");
  const [source, setSource] = useState("");
  const [search, setSearch] = useState("");
  const [loadError, setLoadError] = useState("");
  const [loading, setLoading] = useState(true);
  const { busy, error, run } = useAction();
  useEffect(() => {
    let active = true;
    setLoading(true); setLoadError(""); setQuote(null); setRequest(null); setTokens([]); setQuoteKey(""); setSource("");
    async function load() {
      const result = await api<{ request: PublicFundingRequest }>(`/funding-requests/request?token=${encodeURIComponent(token)}`);
      if (!active) return;
      setRequest(result.request);
      const saved = savedKey(result.request.id);
      if (saved) {
        try { const resumed = await api<PublicQuoteResult>("/funding-requests/resume", { token, idempotencyKey: saved }); if (active) { setQuote(resumed); setQuoteKey(saved); setSource(resumed.token.assetId); } } catch (error) { if (!(error instanceof RequestError && error.status === 404)) throw error; }
      }
      if (["open", "funding_in_progress", "awaiting_confirmation"].includes(result.request.status)) {
        const catalog = await api<{ tokens: Token[] }>(`/funding-requests/assets?token=${encodeURIComponent(token)}`);
        if (active) setTokens(catalog.tokens);
      }
    }
    load().catch((cause) => { if (active) setLoadError(errorMessage(cause)); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [token]);
  async function check(fundingId: string, sourceTxHash?: string) {
    const result = await api<{ request: PublicFundingRequest; confirmationRequired: boolean }>("/funding-requests/reconcile", { token, fundingId, idempotencyKey: quoteKey || undefined, sourceTxHash });
    setRequest(result.request);
    if (quote) { const resumed = await api<PublicQuoteResult>("/funding-requests/resume", { token, idempotencyKey: quoteKey }); setQuote(resumed); }
  }
  const closed = request ? ["fulfilled", "expired", "revoked", "paused", "payment_closed"].includes(request.status) : false;
  const choices = tokens.filter((asset) => `${asset.symbol} ${asset.blockchain}`.toLowerCase().includes(search.toLowerCase()));
  return <div className="grid gap-6">
    {loading && <Empty>Loading secure funding request...</Empty>}
    {(loadError || error) && <p role="alert" className="rounded-lg border p-4 text-sm text-destructive">{loadError || error}</p>}
    {request && <>
      <Panel title={`Fund ${request.companyName}`} description={request.purpose}><div className="grid gap-4 sm:grid-cols-3"><div><p className="text-xs text-muted-foreground">Requested company credit</p><p className="mt-2 text-3xl font-semibold">{usd(request.amount)} USDC</p></div><div><p className="text-xs text-muted-foreground">Confirmed for this request</p><p className="mt-2 text-2xl font-semibold">{usd(request.confirmedAmount)}</p></div><div><p className="text-xs text-muted-foreground">Link expires</p><p className="mt-2 text-sm">{new Date(request.expiresAt).toLocaleString()}</p><div className="mt-2"><Status value={request.status} /></div></div></div><p className="mt-5 text-xs text-muted-foreground">The company receives native USDC in its verified NEAR treasury. You choose your source asset and pay its conversion and network costs. This link grants no company spending or workspace access.</p></Panel>
      {request.status === "fulfilled" && <Panel title="Funding confirmed"><p className="text-sm">Final native-USDC receipts cover this request. No further funding is needed.</p></Panel>}
      {request.status === "awaiting_confirmation" && <p role="status" className="rounded-lg border bg-card p-4 text-sm">Funding has been reported. The company must verify the final NEAR receipt before this request is fulfilled.</p>}
      {closed && request.status !== "fulfilled" && <p role="status" className="rounded-lg border p-4 text-sm">This request is {request.status}. Do not send a new deposit. Previously sent funds remain tracked below.</p>}
      {!closed && !request.activeFunding && <Panel title="Choose how to fund" description="A live signed quote fixes the source amount needed for the remaining USDC. No account or company membership is required."><form className="grid gap-4 sm:grid-cols-2" onSubmit={(event) => { event.preventDefault(); const values = new FormData(event.currentTarget); void run("quote", async () => { if (!source) throw new RequestError("Choose a supported source asset.", 422, "ASSET_REQUIRED"); const saved = quoteKey || savedKey(request.id); if (saved && !quote) { try { const resumed = await api<PublicQuoteResult>("/funding-requests/resume", { token, idempotencyKey: saved }); setQuote(resumed); setQuoteKey(saved); setRequest(resumed.request); return; } catch (cause) { if (!(cause instanceof RequestError && cause.status === 404)) throw cause; } } const key = crypto.randomUUID(); saveKey(request.id, key); setQuoteKey(key); const result = await api<PublicQuoteResult>("/funding-requests/quote", { token, originAsset: source, refundAddress: String(values.get("refund")).trim(), idempotencyKey: key }); setQuote(result); setRequest(result.request); }); }}>
        <div className="sm:col-span-2"><AssetGuidance kind="funding" tokens={tokens} selectedAssetId={source} onSelect={asset => { setSource(asset.assetId); setSearch(""); }} disabled={!!busy} /></div>
        <Field label="Find an asset"><input className={control} value={search} onChange={(event) => { setSearch(event.target.value); setSource(""); }} placeholder="ETH, SOL, USDC, Bitcoin..." /></Field>
        <Field label="Source asset and network"><select className={control} value={source} onChange={(event) => setSource(event.target.value)} required><option value="">Choose a supported asset</option>{choices.map((asset) => <option key={asset.assetId} value={asset.assetId}>{asset.symbol} on {asset.blockchain}</option>)}</select></Field>
        <div className="sm:col-span-2"><Field label="Your refund address on the source network" hint="Use a wallet you control. Connect that same account when sending the deposit."><input className={control} name="refund" required maxLength={256} placeholder="Source wallet or account address" /></Field></div>
        <div className="sm:col-span-2"><Action disabled={!!busy || !tokens.length} busy={busy === "quote"}>Preview source payment for {usd(request.remainingAmount)} USDC</Action></div>
      </form></Panel>}
      {quote && <Panel title="Your funding quote" description="Review the quoted source amount and network before opening your wallet. A source transfer alone does not confirm company credit."><div className="mb-5 flex flex-wrap items-center justify-between gap-4"><div><p className="text-sm">Source: {quote.token.symbol} on {quote.token.blockchain}</p><p className="mt-1 text-xs text-muted-foreground">Quote expires {new Date((JSON.parse(quote.funding.quote) as { quote: { deadline?: string }; quoteRequest: { deadline: string } }).quote.deadline ?? (JSON.parse(quote.funding.quote) as { quoteRequest: { deadline: string } }).quoteRequest.deadline).toLocaleString()}</p></div><Status value={quote.funding.status} /></div>{quote.depositBlockedReason && <p role="alert" className="mb-4 text-sm text-destructive">{quote.depositBlockedReason} New deposits are blocked; existing funding remains tracked.</p>}{!closed && quote.depositAllowed !== false && <FundingWalletAction key={quote.funding.id} funding={quote.funding} token={quote.token} onSubmitted={async (hash) => { await check(quote.funding.id, hash); }} />}<div className="mt-5"><Action disabled={!!busy} busy={busy === "check"} onClick={() => void run("check", async () => { await check(quote.funding.id); })}>Check this funding leg</Action></div><p className="mt-3 text-xs text-muted-foreground">An expired or uncertain route remains unresolved until its outcome is verified. Do not fund a second route while the earlier one may still arrive.</p></Panel>}
      {request.activeFunding && !quote && <Panel title="Funding is already in progress" description="Another browser has prepared the active funding route. Its source wallet and deposit instructions remain private to that browser."><Action disabled={!!busy || !request.activeFunding.id} busy={busy === "check"} onClick={() => void run("check", async () => { if (request.activeFunding?.id) await check(request.activeFunding.id); })}>Check request status</Action></Panel>}
    </>}
  </div>;
}
