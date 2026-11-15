"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronLeft, FileJson } from "lucide-react";
import { api } from "@/lib/api";
import { COMPANY_REVIEW_MAX_BYTES, parseCompanyReview, type CompanyReview } from "@/lib/company-private/schema";
import { useWorkspace } from "./context";
import { useAction } from "./hooks";
import { Action, Address, control, Empty, Field, Panel } from "./shared";
import { openInvoice } from "./invoice-navigation";
import { focusWorkspaceForm } from "./page-metrics";

export function CompanyPrivateProcessing() {
  const { base } = useWorkspace();
  return <CompanyPrivateContent key={base}/>;
}
function CompanyPrivateContent() {
  const { base, organization, recipients, refresh, navigate } = useWorkspace();
  const allowed = ["company:read", "payments:read", "payments:prepare", "documents:manage"].every(permission => organization.permissions?.includes(permission));
  const [review, setReview] = useState<CompanyReview | null>(null), [fileError, setFileError] = useState("");
  const [reading, setReading] = useState(false), [confirmed, setConfirmed] = useState(false), [billId, setBillId] = useState("");
  const [view, setView] = useState<"import" | "review" | "bill" | "source" | "done">("import");
  const { busy, error, run, setError } = useAction();
  const active = useRef(true), generation = useRef(0);
  useEffect(() => { active.current = true; return () => { active.current = false; generation.current++; }; }, []);
  const payees = recipients.filter(value => value.preference_status === "confirmed" && value.confirmed_at);
  async function choose(file?: File) {
    const request = ++generation.current;
    setReview(null); setFileError(""); setConfirmed(false); setBillId(""); setError("");
    if (!file) return;
    setReading(true);
    try {
      if (file.size > COMPANY_REVIEW_MAX_BYTES) throw new Error();
      const parsed = parseCompanyReview(await file.text());
      if (active.current && request === generation.current) { setReview(parsed); setView("review"); }
    } catch { if (active.current && request === generation.current) setFileError("Choose a valid review JSON file, up to 256 KB. Nothing was uploaded."); }
    finally { if (active.current && request === generation.current) setReading(false); }
  }
  const show = (next: typeof view) => { setView(next); setConfirmed(false); setError(""); };
  return <Panel title={view === "import" ? "Company-operated analysis" : view === "bill" ? "Prepare bill draft" : view === "source" ? "Local source records" : view === "done" ? "Bill draft created" : "Review local extraction"} tone="white">
    <section aria-busy={!!busy || reading} className="grid gap-5">
      {(error || fileError) && <p role="alert" className="text-sm text-destructive">{error || fileError}</p>}
      {view !== "import" && <button type="button" className="inline-flex items-center gap-1 justify-self-start text-sm text-muted-foreground" disabled={!!busy || reading} onClick={() => show(view === "bill" || view === "source" ? "review" : "import")}><ChevronLeft size={16}/>{view === "bill" || view === "source" ? "Extraction" : "Local import"}</button>}
      {view === "import" && <>
        {allowed ? <><div className="grid gap-4 rounded-2xl border border-dashed p-6"><FileJson size={26} className="text-primary"/><Field label="Company review JSON"><input type="file" className={control} accept="application/json,.json" disabled={reading || !!busy} onChange={event => void choose(event.target.files?.[0])}/></Field><p className="text-xs text-muted-foreground">Up to 256 KB. Plaintext opens in this page; only approved fields are uploaded.</p></div>{reading && <p role="status" className="text-sm">Reading local file...</p>}<button type="button" className="justify-self-start text-sm text-primary" onClick={() => { navigate("bills"); focusWorkspaceForm("bill-compose"); }}>Enter an invoice manually</button></> : <Empty>Payment preparation and document permissions are required to import fields.</Empty>}
        <details className="border-t pt-5 text-sm"><summary className="cursor-pointer font-medium">Run the local tool</summary><div className="mt-4 grid gap-4"><p className="text-sm text-muted-foreground">Original documents and your NEAR AI key stay on your computer. Your NEAR AI account pays for inference.</p><ol className="list-inside list-decimal space-y-3 text-sm"><li>Use Node.js 24.22.1 or newer with Razor's installed dependencies.</li><li>Set <code>NEAR_AI_API_KEY</code>, <code>NEAR_AI_MODEL</code>, <code>NEAR_AI_MODEL_COMPOSE_SHA256</code> and <code>NEAR_AI_GATEWAY_COMPOSE_SHA256</code> in the local environment.</li><li>Run the command with new absolute output paths.</li></ol><pre className="max-w-full overflow-x-auto rounded-xl bg-muted/50 p-4 text-xs">node --max-old-space-size=512 --import tsx scripts/process-invoice-private.ts --input /absolute/invoice.pdf --output /absolute/review.json --packet /absolute/evidence.json</pre><p className="text-xs text-muted-foreground">TXT, PDF, PNG or JPEG. PDFs require the documented local PDF tools. Failed verification stops processing without a hosted fallback.</p><details className="text-xs text-muted-foreground"><summary className="cursor-pointer">Files, keys and evidence</summary><div className="mt-3 grid gap-3 leading-5"><p>Review JSON contains plaintext extracted fields. Keep it outside this web app if plaintext must stay entirely local.</p><p>Files use mode 0600 and remain until deleted locally. Revoke the API key through your NEAR AI account.</p><p>Evidence exports encrypted wire data without decryption keys. Use <code>--packet-mode metadata</code> to redact wire data, or omit <code>--packet</code>.</p></div></details><a href="/verify" target="_blank" rel="noopener noreferrer" className="justify-self-start text-primary">Open local evidence verifier</a></div></details>
      </>}
      {review && view !== "import" && <>
        <div className="flex flex-wrap items-start justify-between gap-4 rounded-2xl bg-muted/50 p-5"><div><h3 className="font-medium">{review.draft.supplier || "Unknown supplier"}</h3><p className="mt-1 text-sm text-muted-foreground">{review.draft.reference || "Reference missing"}</p></div><p className="break-all text-xl font-medium">{review.draft.amountPrinted || review.draft.amount || "Amount missing"} <span className="text-sm text-muted-foreground">{review.draft.currency || "Currency unconfirmed"}</span></p></div>
        {view === "review" && <>
          <p role="status" className="text-sm text-amber-800">Unverified plaintext extraction. Compare with the original invoice.</p>
          <dl className="grid gap-4 text-sm sm:grid-cols-2">{[["Amount due", review.draft.amount], ["Due date", review.draft.dueDate], ["Subtotal", review.draft.subtotal], ["Tax", review.draft.tax], ["Withholding", review.draft.withholding], ["Deposit", review.draft.deposit]].filter(([, value]) => value !== null && value !== "").map(([label, value]) => <div key={label}><dt className="text-xs text-muted-foreground">{label}</dt><dd className="mt-1">{value}</dd></div>)}</dl>
          {review.draft.warnings.map((warning, index) => <p key={index} className="text-sm text-amber-800">{warning}</p>)}
          {review.draft.paymentDetails && <p className="text-xs text-muted-foreground">Document payment instructions are excluded from import.</p>}
          {!!review.draft.lineItems.length && <details className="border-t pt-4 text-sm"><summary className="cursor-pointer text-muted-foreground">Line items · Original currency</summary><div className="mt-3 divide-y">{review.draft.lineItems.map((item, index) => <div key={index} className="grid gap-2 py-4"><div className="flex items-start justify-between gap-4"><span className="break-words">{item.description}</span><span className="shrink-0 tabular-nums">{item.total ?? "Total missing"}</span></div><p className="text-xs text-muted-foreground">Quantity {item.quantity ?? "Unconfirmed"} · Unit price {item.unitPrice ?? "Unconfirmed"}</p></div>)}</div></details>}
          <div className="flex flex-wrap items-center justify-end gap-4 border-t pt-5"><button type="button" className="text-sm text-muted-foreground" onClick={() => show("source")}>Source records</button>{allowed && <Action onClick={() => show("bill")}>Review bill fields</Action>}</div>
        </>}
        {view === "bill" && allowed && <form key={`${review.source.sha256}:${review.processedAt}`} className="grid gap-5" onChange={event => { if (!(event.target instanceof HTMLInputElement) || event.target.name !== "reviewConfirmed") setConfirmed(false); }} onSubmit={event => { event.preventDefault(); if (!confirmed) return; const values = new FormData(event.currentTarget); void run("import-local-review", async () => { const dueDate = String(values.get("dueDate") ?? ""); const result = await api<{ billId: string; message: string }>(`${base}/company-private/reviewed-invoices`, { sourceSha256: review.source.sha256, sourceKind: review.source.kind, recipientId: values.get("recipient"), reference: values.get("reference"), title: values.get("title"), agreedUSDC: values.get("amount"), maxFeeUSDC: values.get("fee"), ...(dueDate ? { dueDate } : {}), reviewConfirmed: true }); if (active.current) { setBillId(result.billId); setConfirmed(false); setView("done"); refresh(); } }); }}><fieldset disabled={!!busy} className="grid gap-5 sm:grid-cols-2">
          <Field label="Confirmed payee"><select name="recipient" className={control} required defaultValue=""><option value="">Choose payee</option>{payees.map(payee => <option key={payee.id} value={payee.id}>{payee.name}</option>)}</select></Field><Field label="Invoice reference"><input name="reference" className={control} required maxLength={120} defaultValue={review.draft.reference && review.draft.reference.length <= 120 ? review.draft.reference : ""}/></Field><div className="sm:col-span-2"><Field label="Description"><input name="title" className={control} required maxLength={240} defaultValue={review.draft.supplier ? `Invoice from ${review.draft.supplier}` : "Company-reviewed invoice"}/></Field></div><Field label="Agreed amount (USDC)"><input name="amount" className={control} required inputMode="decimal" pattern="[0-9]+(\.[0-9]{1,6})?" defaultValue={review.draft.currency === "USDC" ? review.draft.amount ?? "" : ""}/></Field><Field label="Payment cost ceiling (USDC)"><input name="fee" className={control} required inputMode="decimal" pattern="[0-9]+(\.[0-9]{1,6})?" defaultValue="1"/></Field><Field label="Due date (UTC, optional)"><input name="dueDate" type="date" className={control} defaultValue={review.draft.dueDate ?? ""}/></Field>{review.draft.currency !== "USDC" && <p className="self-center text-sm text-amber-800">Agree USDC separately. No automatic conversion.</p>}<label className="flex items-start gap-3 text-sm sm:col-span-2"><input name="reviewConfirmed" type="checkbox" required checked={confirmed} onChange={event => setConfirmed(event.target.checked)} className="mt-1"/>I compared these fields with the original and approve sharing them to create a bill draft.</label><p className="text-xs text-muted-foreground sm:col-span-2">Only the fields above and source hash/type are saved. No document or AI credentials.</p><div className="flex justify-end border-t pt-5 sm:col-span-2"><Action busy={busy === "import-local-review"} disabled={!!busy || !confirmed || !payees.length}>Create bill draft</Action></div>
        </fieldset></form>}
        {view === "source" && <><p className="text-sm text-muted-foreground">Exporter-supplied metadata, not independently verified by Razor.</p><dl className="grid gap-3 text-sm"><div className="flex justify-between gap-3"><dt className="text-muted-foreground">Source</dt><dd>{review.source.kind.toUpperCase()} · {review.source.bytes.toLocaleString()} bytes</dd></div><div className="flex justify-between gap-3"><dt className="text-muted-foreground">Processed</dt><dd>{new Date(review.processedAt).toLocaleString()}</dd></div><div className="flex justify-between gap-3"><dt className="text-muted-foreground">Reported model</dt><dd className="break-all text-right">{review.processing.model}</dd></div>{review.draft.confidence !== null && <div className="flex justify-between gap-3"><dt className="text-muted-foreground">Model confidence estimate</dt><dd>{Math.round(review.draft.confidence * 100)}%</dd></div>}</dl><Field as="div" label="Source SHA-256"><Address value={review.source.sha256} label="source hash"/></Field><details className="border-t pt-4 text-sm"><summary className="cursor-pointer text-muted-foreground">Reported verification records</summary><pre className="mt-4 max-h-80 overflow-auto rounded-xl bg-muted/50 p-4 text-xs">{JSON.stringify(review.processing, null, 2)}</pre></details><a href="/verify" target="_blank" rel="noopener noreferrer" className="justify-self-start text-sm text-primary">Verify an evidence packet locally</a></>}
        {view === "done" && <><p role="status" className="text-sm text-emerald-700">Saved for separate payment approval.</p><div><Action onClick={() => { navigate("bills"); openInvoice(billId); }}>Open bill draft</Action></div></>}
      </>}
    </section>
  </Panel>;
}
