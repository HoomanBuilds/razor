"use client";

import { isPublicDemo } from "@/lib/demo-scope";

import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Plus } from "lucide-react";
import { api } from "@/lib/api";
import { dateLabel, usd } from "@/lib/format";
import { formatUnits } from "@/lib/money";
import type { accountingOverview } from "@/server/accounting/service";
import { AssetIdentity } from "../assets/asset-identity";
import { useAction } from "./hooks";
import { Action, Address, control, Empty, Field, Status } from "./shared";

type Overview = ReturnType<typeof accountingOverview>;
type LedgerTask = "observe" | "group" | "activity" | "valuation" | "fee" | "batch" | null;
export function valuationFields(values: FormData) {
  return {
    numerator: String(values.get("valuationNumerator")),
    denominator: String(values.get("valuationDenominator")),
    source: String(values.get("valuationSource")),
    date: String(values.get("valuationDate")),
    rounding: String(values.get("valuationRounding")),
  };
}
export function AccountingValuationFields({ asset }: { asset: "NEAR" | "USDC" }) {
  return <>
    <div className="grid gap-4 rounded-2xl bg-muted/50 p-4 sm:col-span-2 sm:grid-cols-2">
      <p className="text-sm font-medium sm:col-span-2">Functional currency per {asset}</p>
      <Field label="Rate numerator"><input name="valuationNumerator" className={control} required inputMode="numeric" pattern="[1-9][0-9]{0,17}"/></Field>
      <Field label="Rate denominator"><input name="valuationDenominator" className={control} required inputMode="numeric" pattern="[1-9][0-9]{0,17}"/></Field>
    </div>
    <Field label="Rate source and approval"><input name="valuationSource" className={control} required minLength={3} maxLength={300}/></Field>
    <Field label="Valuation date"><input name="valuationDate" className={control} type="date" required max={new Date().toISOString().slice(0, 10)}/></Field>
    <div className="sm:col-span-2"><Field label="Rounding"><select name="valuationRounding" className={control} required defaultValue="exact"><option value="exact">Exact cents only</option><option value="half_even_to_cent">Nearest cent, ties to even; retain residual</option></select></Field></div>
  </>;
}
export function AccountingLedgerTools(props: { endpoint: string; data: Overview; connectionId: string; canApprove: boolean; disabled: boolean; onChange: () => void }) {
  return <LedgerContent key={`${props.endpoint}:${props.connectionId}`} {...props}/>;
}
function LedgerContent({ endpoint, data, connectionId, canApprove, disabled, onChange }: { endpoint: string; data: Overview; connectionId: string; canApprove: boolean; disabled: boolean; onChange: () => void }) {
  const { busy, error, run, setError } = useAction();
  const [notice, setNotice] = useState(""), [task, setTask] = useState<LedgerTask>(null), [selectedId, setSelectedId] = useState("");
  const [tab, setTab] = useState<"fees" | "groups">("fees"), [network, setNetwork] = useState("mainnet"), [feeIds, setFeeIds] = useState<string[]>([]);
  const [feeConfirmed, setFeeConfirmed] = useState(false), [fxConfirmed, setFxConfirmed] = useState(false);
  const [referenceKind, setReferenceKind] = useState("payment"), [referenceId, setReferenceId] = useState(""), [paymentId, setPaymentId] = useState("");
  const [activityResult, setActivityResult] = useState<{ matched: number; unmatched: number; conflicting: number; mayHaveMore: boolean } | null>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const fresh = !disabled && !busy, connection = data.connections.find(value => value.id === connectionId);
  const selectedFee = data.ledger.fees.find(value => value.id === selectedId), selectedBatch = data.ledger.feeBatches.find(value => value.id === selectedId);
  const selectedFees = data.ledger.fees.filter(value => feeIds.includes(value.id)), groupValid = !!feeIds.length && selectedFees.length === feeIds.length && selectedFees.every(value => !value.batch_id && value.network === network);
  const groupingTotal = selectedFees.reduce((sum, value) => sum + BigInt(value.amount_atomic), 0n);
  const settlement = data.settlements.find(value => value.id === paymentId);
  const settlementLabel = (id: string) => { const source = data.settlements.find(value => value.id === id); return source ? `${source.reference} · ${usd(source.amount)}` : null; };
  const feeLabel = (fee: Overview["ledger"]["fees"][number]) => settlementLabel(fee.reference_id) || (fee.reference_kind === "payment" ? "Payment fee" : "Funding fee");
  function open(next: LedgerTask, id = "") { setTask(next); setSelectedId(id); setError(""); setNotice(""); setActivityResult(null); setFeeIds([]); setReferenceId(""); setPaymentId(""); setFeeConfirmed(false); setFxConfirmed(false); }
  async function mutate(path: string, input: unknown, message: string) {
    await api(path, input);
    if (!mounted.current) return;
    setTask(null); setNotice(message); onChange();
  }
  const titles = { observe: "Record NEAR fee", group: "Group fees", activity: "Import provider activity", valuation: "Approve FX valuation", fee: "Fee record", batch: "Fee group" };
  const networks = Array.from(new Set(data.ledger.fees.map(value => value.network)));
  return <section aria-label="Bookkeeping sources" aria-busy={!!busy} className="grid min-w-0 gap-5">
    {task ? <>
      <button type="button" disabled={!!busy} onClick={() => open(null)} className="inline-flex items-center gap-1 justify-self-start text-sm text-muted-foreground"><ChevronLeft size={16}/>Bookkeeping sources</button>
      <h3 className="text-xl font-medium tracking-tight">{titles[task]}</h3>
    </> : <div className="flex flex-wrap items-center justify-between gap-3"><h3 className="text-lg font-medium">Bookkeeping sources</h3>{canApprove && <Action disabled={!fresh} onClick={() => open("observe")}><Plus size={15}/>Record fee</Action>}</div>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {notice && <p role="status" className="text-sm">{notice}</p>}
    {!task && <>
      <div className="flex flex-wrap items-center gap-3"><div className="flex rounded-full bg-muted p-1" role="group" aria-label="Source type">{(["fees", "groups"] as const).map(value => <button key={value} type="button" aria-pressed={tab === value} onClick={() => setTab(value)} className={`rounded-full px-4 py-2 text-sm ${tab === value ? "bg-white shadow-sm" : "text-muted-foreground"}`}>{value === "fees" ? "Fees" : "Fee groups"}</button>)}</div>{canApprove && data.ledger.fees.some(value => !value.batch_id) && <button type="button" className="text-sm text-primary" disabled={!fresh} onClick={() => { open("group"); setNetwork(data.ledger.fees.find(value => !value.batch_id)?.network || "mainnet"); }}>Group fees</button>}{connection?.status === "active" && <><button type="button" className="text-sm text-primary" disabled={!fresh} onClick={() => open("activity")}>Import activity</button>{canApprove && <button type="button" className="text-sm text-primary" disabled={!fresh} onClick={() => open("valuation")}>FX valuation</button>}</>}</div>
      {tab === "fees" && (data.ledger.fees.length ? <div className="divide-y rounded-2xl border px-4">{data.ledger.fees.map(value => <button type="button" key={value.id} disabled={!fresh} onClick={() => open("fee", value.id)} className="flex w-full items-center justify-between gap-3 py-4 text-left"><div className="min-w-0"><p className="truncate text-sm font-medium">{feeLabel(value)}</p><p className="mt-1 text-xs text-muted-foreground">{dateLabel(value.created_at)} · {value.network}</p></div><div className="ml-auto min-w-0 text-right"><p className="break-all text-sm tabular-nums">{formatUnits(value.amount_atomic, 24)} NEAR</p><p className="mt-1 text-xs text-muted-foreground">{value.batch_id ? "Grouped" : "Ungrouped"}</p></div><ChevronRight size={16} className="shrink-0 text-muted-foreground"/></button>)}</div> : <Empty>No recorded NEAR fees.</Empty>)}
      {tab === "groups" && (data.ledger.feeBatches.length ? <div className="divide-y rounded-2xl border px-4">{data.ledger.feeBatches.map((value, index) => <button type="button" key={value.id} disabled={!fresh} onClick={() => open("batch", value.id)} className="flex w-full items-center justify-between gap-3 py-4 text-left"><div><p className="text-sm font-medium">Fee group {index + 1}</p><p className="mt-1 text-xs text-muted-foreground">{dateLabel(value.created_at)} · {value.network}</p></div><div className="ml-auto min-w-0 text-right"><p className="mb-2 break-all text-sm tabular-nums">{formatUnits(value.amount_atomic, 24)} NEAR</p><Status value={value.state}/></div><ChevronRight size={16} className="shrink-0 text-muted-foreground"/></button>)}</div> : <Empty>No fee groups.</Empty>)}
    </>}
    {task === "observe" && canApprove && <form onChange={event => { if (!(event.target instanceof HTMLInputElement && event.target.type === "checkbox")) setFeeConfirmed(false); }} className="grid gap-5" onSubmit={event => { event.preventDefault(); const values = new FormData(event.currentTarget); void run("fee", () => mutate(`${endpoint}/fees/observe`, { referenceKind, referenceId: referenceId && referenceId !== "manual" ? referenceId : values.get("referenceId"), transactionHash: values.get("transactionHash"), signerAccount: values.get("signerAccount"), companyExpenseAcknowledged: true }, "Final NEAR fee recorded.")); }}>
      <fieldset className="grid gap-5 sm:grid-cols-2" disabled={!fresh}>
        <Field label="Source type"><select className={control} value={referenceKind} onChange={event => { setReferenceKind(event.target.value); setReferenceId(""); }}><option value="payment">Payment</option><option value="funding">Funding</option></select></Field>
        {referenceKind === "payment" && data.settlements.length ? <Field label="Payment"><select className={control} value={referenceId} required onChange={event => setReferenceId(event.target.value)}><option value="">Choose payment</option>{data.settlements.map((value, index) => <option key={value.id} value={value.id}>{value.reference} · {usd(value.amount)} · #{index + 1}</option>)}<option value="manual">Another payment</option></select></Field> : null}
        {(referenceKind === "funding" || !data.settlements.length || referenceId === "manual") && <Field label={referenceKind === "payment" ? "Payment ID" : "Funding ID"}><input key={referenceKind} name="referenceId" className={control} required maxLength={128}/></Field>}
        <div className="sm:col-span-2"><Field label="Final NEAR transaction hash"><input name="transactionHash" className={control} required maxLength={64}/></Field></div>
        <div className="sm:col-span-2"><Field label="Transaction signer"><input name="signerAccount" className={control} required maxLength={64}/></Field></div>
        <label key={`${referenceKind}:${referenceId}`} className="flex items-start gap-3 text-sm sm:col-span-2"><input type="checkbox" required checked={feeConfirmed} onChange={event => setFeeConfirmed(event.target.checked)} className="mt-1"/>This company-member wallet paid the fee. Solver and relayer costs are excluded.</label>
        <div className="flex justify-end border-t pt-5 sm:col-span-2"><Action disabled={!fresh} busy={busy === "fee"}>Verify and record fee</Action></div>
      </fieldset>
    </form>}
    {task === "group" && canApprove && <form className="grid gap-5" onSubmit={event => { event.preventDefault(); if (!groupValid) return; void run("group", () => mutate(`${endpoint}/fees/groups`, { feeIds, acknowledgement: true }, "Fee group created. Posting approval is separate.")); }}>
      <Field label="Network"><select className={control} value={network} disabled={!fresh} onChange={event => { setNetwork(event.target.value); setFeeIds([]); }}>{networks.map(value => <option key={value}>{value}</option>)}</select></Field>
      <div className="divide-y rounded-2xl border px-4">{data.ledger.fees.filter(value => !value.batch_id && value.network === network).map(value => <label key={value.id} className="flex items-center gap-3 py-4"><input type="checkbox" checked={feeIds.includes(value.id)} disabled={!fresh} onChange={event => setFeeIds(previous => event.target.checked ? [...previous, value.id] : previous.filter(id => id !== value.id))}/><span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{feeLabel(value)}</span><span className="mt-1 block text-xs text-muted-foreground">{dateLabel(value.created_at)}</span></span><span className="max-w-[50%] break-all text-right text-sm tabular-nums">{formatUnits(value.amount_atomic, 24)} NEAR</span></label>)}</div>
      {!!feeIds.length && <div className="flex flex-wrap justify-between gap-3 rounded-2xl bg-muted/50 p-4 text-sm"><span>{feeIds.length} fees selected</span><strong className="break-all font-medium tabular-nums">{formatUnits(groupingTotal.toString(), 24)} NEAR</strong></div>}
      {!!feeIds.length && !groupValid && <p role="alert" className="text-sm text-destructive">Selected fees changed. Choose ungrouped fees again.</p>}
      <div className="flex justify-end border-t pt-5"><Action disabled={!fresh || !groupValid} busy={busy === "group"}>Create fee group</Action></div>
    </form>}
    {task === "fee" && (selectedFee ? <>
      <div className="grid gap-3 rounded-2xl bg-muted/50 p-5"><AssetIdentity symbol="NEAR" network="near"/><p className="break-all text-2xl font-medium tabular-nums">{formatUnits(selectedFee.amount_atomic, 24)} NEAR</p><p className="text-sm text-muted-foreground">Actual network fee · {selectedFee.network}</p></div>
      <dl className="grid gap-3 text-sm"><div className="flex justify-between gap-4"><dt className="text-muted-foreground">Source</dt><dd className="text-right">{feeLabel(selectedFee)}</dd></div><div className="flex justify-between gap-4"><dt className="text-muted-foreground">Recorded</dt><dd>{dateLabel(selectedFee.created_at)}</dd></div><div className="flex justify-between gap-4"><dt className="text-muted-foreground">Grouping</dt><dd>{selectedFee.batch_id ? "Grouped" : "Ungrouped"}</dd></div></dl>
      <Field as="div" label="NEAR transaction"><Address value={selectedFee.transaction_hash} label="transaction hash"/><a hidden={isPublicDemo()} className="mt-2 inline-block text-sm text-primary" href={`https://${selectedFee.network === "testnet" ? "testnet." : ""}nearblocks.io/txns/${encodeURIComponent(selectedFee.transaction_hash)}`} target="_blank" rel="noreferrer">View transaction</a></Field>
      <details className="border-t pt-4 text-sm"><summary className="cursor-pointer text-muted-foreground">Record IDs</summary><div className="mt-4 grid gap-4"><Field as="div" label="Source ID"><Address value={selectedFee.reference_id} label="source ID"/></Field><Field as="div" label="Fee ID"><Address value={selectedFee.id} label="fee ID"/></Field>{selectedFee.batch_id && <Field as="div" label="Group ID"><Address value={selectedFee.batch_id} label="group ID"/></Field>}</div></details>
    </> : <Empty>Fee record unavailable.</Empty>)}
    {task === "batch" && (selectedBatch ? <>
      <div className="grid gap-3 rounded-2xl bg-muted/50 p-5"><AssetIdentity symbol="NEAR" network="near"/><p className="break-all text-2xl font-medium tabular-nums">{formatUnits(selectedBatch.amount_atomic, 24)} NEAR</p><div className="flex items-center justify-between gap-3"><span className="text-sm text-muted-foreground">{selectedBatch.network}</span><Status value={selectedBatch.state}/></div></div>
      <div className="divide-y">{data.ledger.fees.filter(value => value.batch_id === selectedBatch.id).map(value => <div key={value.id} className="flex items-start justify-between gap-4 py-3 text-sm"><span>{feeLabel(value)}</span><span className="max-w-[55%] break-all text-right tabular-nums">{formatUnits(value.amount_atomic, 24)} NEAR</span></div>)}</div>
      <details className="border-t pt-4 text-sm"><summary className="cursor-pointer text-muted-foreground">Group records</summary><div className="mt-4 grid gap-4"><Field as="div" label="Group ID"><Address value={selectedBatch.id} label="group ID"/></Field><Field as="div" label="Source hash"><Address value={selectedBatch.source_hash} label="source hash"/></Field></div></details>
      {canApprove && selectedBatch.state === "grouped" && <form key={selectedBatch.id} className="grid gap-4 border-t pt-5" onSubmit={event => { event.preventDefault(); void run(`release:${selectedBatch.id}`, () => mutate(`${endpoint}/fees/groups/${selectedBatch.id}/release`, {}, "Unposted fees released for regrouping.")); }}><label className="flex items-start gap-3 text-sm"><input type="checkbox" required disabled={!fresh} className="mt-1"/>Release this unposted group for regrouping.</label><div className="flex justify-end"><Action disabled={!fresh} busy={busy === `release:${selectedBatch.id}`}>Release group</Action></div></form>}
    </> : <Empty>Fee group unavailable.</Empty>)}
    {task === "activity" && connection?.status === "active" && <form className="grid gap-5" onSubmit={event => { event.preventDefault(); const values = new FormData(event.currentTarget); void run("activity", async () => { const result = await api<{ matched: number; unmatched: number; conflicting: number; mayHaveMore: boolean }>(`${endpoint}/connections/${connectionId}/activity`, { kind: values.get("kind"), page: Number(values.get("page")) }); if (!mounted.current) return; setActivityResult(result); onChange(); }); }}><fieldset className="grid gap-5 sm:grid-cols-2" disabled={!fresh}><Field label="Records"><select name="kind" className={control} onChange={() => setActivityResult(null)}><option value="bill">Bills</option><option value="settlement">Bill settlements</option><option value="credit">Supplier credits</option><option value="journal">Journal entries</option></select></Field><Field label="Page"><input name="page" type="number" className={control} min={1} max={1000} step={1} required defaultValue={1} onChange={() => setActivityResult(null)}/></Field><div className="flex justify-end border-t pt-5 sm:col-span-2"><Action disabled={!fresh} busy={busy === "activity"}>Import activity</Action></div></fieldset>{activityResult && <div role="status" className="grid gap-4 rounded-2xl bg-muted/50 p-5"><div className="grid grid-cols-3 gap-3">{[["Matched", activityResult.matched], ["Unmatched", activityResult.unmatched], ["Conflicts", activityResult.conflicting]].map(([label, value]) => <div key={label}><p className="text-xs text-muted-foreground">{label}</p><p className="mt-1 text-xl font-medium tabular-nums">{value}</p></div>)}</div><p className="text-xs text-muted-foreground">{activityResult.mayHaveMore ? "More records available on the next page." : "Page complete."} Read-only comparison.</p></div>}</form>}
    {task === "valuation" && canApprove && connection?.status === "active" && <form onChange={event => { if (!(event.target instanceof HTMLInputElement && event.target.type === "checkbox")) setFxConfirmed(false); }} className="grid gap-5" onSubmit={event => { event.preventDefault(); const values = new FormData(event.currentTarget); if (!settlement) return; void run("fx", () => mutate(`${endpoint}/connections/${connectionId}/fx-differences`, { paymentId, valuation: valuationFields(values), reason: values.get("reason"), acknowledgement: true }, "FX source approved. Journal posting requires separate approval.")); }}><fieldset className="grid gap-5 sm:grid-cols-2" disabled={!fresh}><div className="sm:col-span-2"><Field label="Posted settlement"><select className={control} required value={paymentId} onChange={event => setPaymentId(event.target.value)}><option value="">Choose settlement</option>{data.settlements.map((value, index) => <option key={value.id} value={value.id}>{value.reference} · {usd(value.amount)} · #{index + 1}</option>)}</select></Field></div><AccountingValuationFields asset="USDC"/><div className="sm:col-span-2"><Field label="Approval reason"><textarea name="reason" className={control} minLength={3} maxLength={2000} rows={3} required/></Field></div><label key={`${paymentId}:${settlement?.amount}`} className="flex items-start gap-3 text-sm sm:col-span-2"><input type="checkbox" required checked={fxConfirmed} onChange={event => setFxConfirmed(event.target.checked)} className="mt-1"/>I approve this rate and the resulting crypto-clearing valuation difference. No cash or refund is created.</label><div className="flex justify-end border-t pt-5 sm:col-span-2"><Action disabled={!fresh || !settlement} busy={busy === "fx"}>Approve FX source</Action></div></fieldset></form>}
    {data.unavailableProviders.map(provider => <p key={provider.provider} className="text-xs text-muted-foreground"><Status value="unavailable"/> {provider.provider}: {provider.reason}</p>)}
  </section>;
}
