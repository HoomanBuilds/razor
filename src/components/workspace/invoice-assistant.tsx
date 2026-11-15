"use client";

import { appHref } from "@/lib/demo-scope";

import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, FileText } from "lucide-react";
import { PortableEvidenceExport } from "@/components/verification/packet-export";
import { FinanceInsightsPanel } from "./finance-insights";
import { api, RequestError } from "@/lib/api";
import { dateLabel, microUsd } from "@/lib/format";
import { useWorkspace } from "./context";
import { useAction, useResource } from "./hooks";
import { Action, Address, control, Empty, Field, Panel, Status } from "./shared";
import { focusWorkspaceForm } from "./page-metrics";

type Analysis = { id: string; draft: Record<string, unknown>; verification: Record<string, unknown>; documentHash: string; retainedId: string | null; invoiceSource: string | null };
type RetainedDraft = { id: string; createdAt: string; expiresAt: string; draft: Record<string, unknown>; verification: Record<string, unknown>; documentHash: string };
const textField = (value: Record<string, unknown>, key: string) => typeof value[key] === "string" ? value[key] as string : "";
export function Assistant() {
  const { base } = useWorkspace();
  return <InvoiceAssistant key={base}/>;
}
function InvoiceAssistant() {
  const { base, recipients, revision, refresh, navigate, invoiceReview, analyzeInvoice, organization } = useWorkspace();
  const manageDocuments = !!organization.permissions?.includes("documents:manage"), prepare = !!organization.permissions?.includes("payments:prepare") && !!organization.permissions?.includes("recipients:read");
  const [draftPage, setDraftPage] = useState(1), [view, setView] = useState<"input" | "review" | "evidence" | "export" | "delete">("input");
  const configResource = useResource<{ ready: boolean; provider: string; retentionDays: number; missing: string[] }>(manageDocuments ? `${base}/assistant/config` : null, revision), config = configResource.data;
  const savedResource = useResource<{ drafts: RetainedDraft[]; page: number; total: number; totalPages: number; hasMore: boolean }>(manageDocuments ? `${base}/assistant/drafts?page=${draftPage}` : null, revision), saved = savedResource.data;
  const { busy, error, run, setError } = useAction();
  const [analysis, setAnalysis] = useState<Analysis | null>(null), [evidence, setEvidence] = useState<{ id: string; body: string } | null>(null), [confirmed, setConfirmed] = useState(false);
  const active = useRef(true), currentSource = useRef<string | null>(null);
  currentSource.current = invoiceReview?.sourceFingerprint || null;
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  useEffect(() => { setConfirmed(false); setEvidence(null); }, [invoiceReview?.sourceFingerprint, analysis?.id]);
  const value = (key: string) => analysis ? textField(analysis.draft, key) : "";
  const valid = analysis && analysis.invoiceSource === (invoiceReview?.sourceFingerprint || null);
  const show = (next: typeof view) => { setView(next); setConfirmed(false); setError(""); };
  if (!manageDocuments) return <FinanceInsightsPanel/>;
  return <Panel title={valid && view !== "input" ? view === "review" ? "Review invoice" : view === "delete" ? "Delete private draft" : view === "export" ? "Export evidence" : "Verification evidence" : "Private invoice analysis"} tone="white">
    <section aria-busy={!!busy} className="grid gap-5">
      {(error || configResource.error) && <p role="alert" className="text-sm text-destructive">{error || configResource.error}</p>}
      {valid && view !== "input" ? <>
        <button type="button" disabled={!!busy} onClick={() => show(view === "review" ? "input" : "review")} className="inline-flex items-center gap-1 justify-self-start text-sm text-muted-foreground"><ChevronLeft size={16}/>{view === "review" ? "Invoice analysis" : "Invoice review"}</button>
        <div className="flex flex-wrap items-start justify-between gap-4 rounded-2xl bg-muted/50 p-5"><div><h3 className="font-medium">{value("supplier") || "Unknown supplier"}</h3>{value("reference") && <p className="mt-1 text-sm text-muted-foreground">{value("reference")}</p>}</div><p className="break-all text-xl font-medium">{value("amount") || "Amount missing"} <span className="text-sm text-muted-foreground">{value("currency")}</span></p></div>
        {view === "review" && <>
          {Array.isArray(analysis.draft.warnings) && analysis.draft.warnings.map((warning, index) => <p role="status" key={index} className="text-sm text-amber-800">{String(warning)}</p>)}
          {value("currency") !== "USDC" && <p role="status" className="text-sm text-amber-800">Agree the USDC amount separately. No automatic conversion.</p>}
          {prepare ? <form key={`${analysis.id}:${analysis.invoiceSource}`} className="grid gap-5" onChange={event => { if (!(event.target instanceof HTMLInputElement) || event.target.type !== "checkbox") setConfirmed(false); }} onSubmit={event => { event.preventDefault(); if (!confirmed) return; const values = new FormData(event.currentTarget); void run("bill", async () => { let amount: string; try { amount = microUsd(String(values.get("amount"))); } catch (cause) { throw new RequestError((cause as Error).message, 400, "INVALID_AMOUNT"); } if (invoiceReview) await api(`${base}/intake/${invoiceReview.id}/prepare`, { sourceFingerprint: invoiceReview.sourceFingerprint, agreedUSDC: String(values.get("amount")), maxFee: "1", title: values.get("title"), reviewConfirmed: true }); else await api(`${base}/bills`, { recipientId: values.get("recipient"), reference: values.get("reference"), title: values.get("title"), amount, maxFee: "1000000", documentHash: analysis.documentHash, evidence: analysis.retainedId ? `Reviewed private analysis ${analysis.retainedId}` : "Private extraction reviewed without retained analysis", lineItems: Array.isArray(analysis.draft.lineItems) ? analysis.draft.lineItems : [] }); if (active.current) { refresh(); navigate("bills"); } }); }}>
            <fieldset className="grid gap-5 sm:grid-cols-2" disabled={!!busy}>
              <Field label="Confirmed payee"><select name="recipient" className={control} required defaultValue={invoiceReview?.recipientId ?? ""} disabled={!!invoiceReview}><option value="">Choose payee</option>{recipients.map(recipient => <option key={recipient.id} value={recipient.id}>{recipient.name}</option>)}</select></Field>
              <Field label="Invoice reference"><input name="reference" className={control} required defaultValue={invoiceReview?.reference ?? value("reference")} readOnly={!!invoiceReview} maxLength={120}/></Field>
              <div className="sm:col-span-2"><Field label="Description"><input name="title" className={control} required defaultValue={value("supplier") ? `Invoice from ${value("supplier")}` : "Reviewed invoice"} maxLength={240}/></Field></div>
              <Field label="Agreed amount (USDC)"><input name="amount" className={control} required inputMode="decimal" pattern="[0-9]+(\.[0-9]{1,6})?" defaultValue={value("currency") === "USDC" ? value("amount") : ""}/></Field>
              <div className="self-center rounded-xl bg-muted/50 p-4 text-sm"><p className="text-xs text-muted-foreground">Company payment cost ceiling</p><p className="mt-1">1.00 USDC</p></div>
              <label className="flex items-start gap-3 text-sm sm:col-span-2"><input type="checkbox" required checked={confirmed} onChange={event => setConfirmed(event.target.checked)} className="mt-1"/>I reviewed the supplier, reference, currency and agreed USDC amount. Save a draft for separate approval.</label>
              <div className="flex justify-end border-t pt-5 sm:col-span-2"><Action busy={busy === "bill"} disabled={!recipients.length || !!busy || !confirmed}>Save bill draft</Action></div>
            </fieldset>
          </form> : <p className="text-sm text-muted-foreground">Payment preparation permission is required to create a bill.</p>}
          <div className="flex flex-wrap gap-4 border-t pt-4"><button type="button" disabled={!!busy} className="text-sm text-primary" onClick={() => show("evidence")}>Verification evidence</button>{analysis.retainedId && <><button type="button" disabled={!!busy} className="text-sm text-primary" onClick={() => show("export")}>Export</button><button type="button" disabled={!!busy} className="ml-auto text-sm text-destructive" onClick={() => show("delete")}>Delete draft</button></>}</div>
        </>}
        {view === "evidence" && <><Field as="div" label="Source document hash"><Address value={analysis.documentHash} label="document hash"/></Field><details className="text-sm"><summary className="cursor-pointer text-muted-foreground">Extraction and verification records</summary><pre className="mt-4 max-h-96 overflow-auto rounded-xl bg-muted/50 p-4 text-xs">{JSON.stringify({ draft: analysis.draft, verification: analysis.verification }, null, 2)}</pre></details>{analysis.retainedId && <><div><Action disabled={!!busy} busy={busy === "invoice-evidence"} onClick={() => void run("invoice-evidence", async () => { const result = await api(`${base}/assistant/drafts/${analysis.retainedId}/evidence`); if (active.current) setEvidence({ id: analysis.retainedId!, body: JSON.stringify(result, null, 2) }); })}>Load retained evidence</Action></div>{evidence?.id === analysis.retainedId && <pre className="max-h-96 overflow-auto rounded-xl bg-muted/50 p-4 text-xs">{evidence.body}</pre>}</>}</>}
        {view === "export" && analysis.retainedId && <><a className="justify-self-start text-sm text-primary" href={appHref(`/api${base}/assistant/drafts/${analysis.retainedId}/evidence?download=1`)} download>Download private analysis JSON</a><PortableEvidenceExport key={analysis.retainedId} endpoint={`${base}/assistant/drafts/${analysis.retainedId}`}/></>}
        {view === "delete" && analysis.retainedId && <form className="grid gap-5" onSubmit={event => { event.preventDefault(); void run("delete", async () => { await api(`${base}/assistant/drafts/${analysis.retainedId}`, undefined, "DELETE"); if (active.current) { setAnalysis(null); setEvidence(null); show("input"); refresh(); } }); }}><label className="flex items-start gap-3 text-sm"><input type="checkbox" required className="mt-1" disabled={!!busy}/>Delete this retained draft and its evidence. Existing bills remain.</label><div className="flex justify-end"><Action disabled={!!busy} busy={busy === "delete"}>Delete private draft</Action></div></form>}
      </> : <>
        <div className="flex flex-wrap items-center justify-between gap-3"><Status value={config?.ready ? "ready" : configResource.loading ? "checking" : configResource.error ? "unavailable" : "setup_required"}/>{config?.ready && <span className="text-xs text-muted-foreground">{config.retentionDays ? `Encrypted retention · ${config.retentionDays} days` : "Session only"}</span>}</div>
        {!config?.ready && !configResource.loading && <p role="status" className="text-sm text-muted-foreground">Private analysis is unavailable. Manual invoice entry is available.</p>}
        {config?.missing.length ? <details className="text-xs text-muted-foreground"><summary className="cursor-pointer">Operator setup</summary><p className="mt-3">{config.missing.join(", ")}</p></details> : null}
        {invoiceReview && <div className="flex items-center justify-between gap-4 rounded-xl bg-muted/50 p-4 text-sm"><span>{invoiceReview.reference}</span><button type="button" disabled={!!busy} className="text-primary" onClick={() => { analyzeInvoice(null); setAnalysis(null); }}>Clear source</button></div>}
        <form className="grid gap-4" onSubmit={event => { event.preventDefault(); const values = new FormData(event.currentTarget), source = currentSource.current; void run("analyze", async () => { const text = String(values.get("text")).trim(); const result = await api<{ id: string | null; draft: Record<string, unknown>; verification: Record<string, unknown> }>(`${base}/assistant/analyze`, { text }); const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)); if (!active.current || source !== currentSource.current) return; setAnalysis({ ...result, invoiceSource: source, id: result.id ?? crypto.randomUUID(), retainedId: result.id, documentHash: Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, "0")).join("") }); show("review"); refresh(); }); }}><Field label="Invoice text"><textarea key={invoiceReview?.id || "manual"} name="text" className={control} defaultValue={invoiceReview?.text ?? ""} required minLength={20} maxLength={20000} rows={6} disabled={!!busy} placeholder="Paste the invoice text"/></Field><div className="flex flex-wrap items-center justify-end gap-4">{prepare && <button type="button" disabled={!!busy} className="text-sm text-muted-foreground" onClick={() => { navigate("bills"); focusWorkspaceForm("bill-compose"); }}>Enter manually</button>}<Action busy={busy === "analyze"} disabled={!config?.ready || !!busy}>Analyze privately</Action></div></form>
        <div className="grid gap-4 border-t pt-5"><h3 className="text-sm font-medium">Retained drafts</h3>{savedResource.error && <p role="alert" className="text-sm text-destructive">{savedResource.error}</p>}{savedResource.loading ? <Empty>Loading drafts...</Empty> : !saved?.drafts.length ? <Empty>No retained drafts.</Empty> : <div className="divide-y rounded-2xl border px-4">{saved.drafts.map(draft => <button key={draft.id} type="button" disabled={!!busy} className="flex w-full items-center gap-3 py-4 text-left" onClick={() => { analyzeInvoice(null); setAnalysis({ ...draft, retainedId: draft.id, invoiceSource: null }); show("review"); }}><FileText size={18} className="shrink-0 text-muted-foreground"/><div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{textField(draft.draft, "supplier") || "Invoice draft"}</p><p className="mt-1 truncate text-xs text-muted-foreground">{textField(draft.draft, "reference") || dateLabel(draft.createdAt)} · Expires {dateLabel(draft.expiresAt)}</p></div><ChevronRight size={16} className="shrink-0"/></button>)}</div>}{saved && saved.totalPages > 1 && <div className="flex items-center justify-between gap-3 text-sm"><button type="button" disabled={!!busy || savedResource.loading || saved.page <= 1} onClick={() => setDraftPage(saved.page - 1)}>Previous</button><span className="text-xs text-muted-foreground">{saved.page} / {saved.totalPages}</span><button type="button" disabled={!!busy || savedResource.loading || !saved.hasMore} onClick={() => setDraftPage(saved.page + 1)}>Next</button></div>}</div>
      </>}
    </section>
  </Panel>;
}
