"use client";

import { invoiceSourceAmount } from "@/lib/invoice-register";
import { openInvoice } from "./invoice-navigation";
import { Upload } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { api, ACCESS_CHANGED_EVENT, RequestError, SESSION_EXPIRED_EVENT } from "@/lib/api";
import type { ExtractedInvoice } from "@/server/assistant/extraction";
import { useWorkspace } from "./context";
import { useAction, useResource } from "./hooks";
import { Action, control, Empty, Field, Status } from "./shared";
import { PurchaseMatchFields, purchaseMatchInput } from "./vendor-commitments";

interface Summary {
  id: string; filename: string; mediaType: string; bytes: number; sourceHash: string;
  status: string; revision: number; billId: string | null; expiresAt: string;
  error: { code: string; message: string } | null;
}
interface InvoiceDocument extends Summary {
  text: string; needsVision: boolean; similarDocumentIds: string[];
  sources: Array<{ provider: string; channelName: string; receivedAt: string }>;
  analysis: { id: string | null; draft: ExtractedInvoice; verification: unknown } | null;
}
interface Configuration {
  retentionDays: number; processor: { ready: boolean; missing: string[] };
  privateAi: { ready: boolean; missing: string[] };
}

async function upload(base: string, file: File): Promise<{ document: InvoiceDocument; duplicate: boolean }> {
  const body = new FormData(); body.set("file", file);
  const response = await fetch(`/api${base}/documents/upload`, { method: "POST", credentials: "same-origin", body, cache: "no-store" });
  let result;
  try { result = await response.json(); }
  catch { throw new RequestError("The upload response was interrupted. Check the file inbox before retrying", response.status, "DOCUMENT_UPLOAD_UNKNOWN"); }
  if (!response.ok) {
    if (response.status === 401) window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT));
    if (response.status === 403) window.dispatchEvent(new Event(ACCESS_CHANGED_EVENT));
    throw new RequestError(typeof result.error === "string" ? result.error : "The invoice file could not be uploaded", response.status, result.code || "DOCUMENT_UPLOAD_FAILED");
  }
  return result;
}

export function InvoiceDocumentIntake() {
  const uploadId = useId();
  const { base, organization, recipients, revision, refresh, navigate } = useWorkspace();
  const allowed = organization.permissions?.includes("documents:manage") === true;
  const prepare = organization.permissions?.includes("payments:prepare") === true && organization.permissions?.includes("recipients:read") === true;
  const [selectedId, setSelectedId] = useState(""), [localRevision, setLocalRevision] = useState(0), [page, setPage] = useState(1), [notice, setNotice] = useState("");
  const config = useResource<Configuration>(allowed ? `${base}/documents/config` : null, revision);
  const history = useResource<{ documents: Summary[]; page: number; totalPages: number; total: number; hasMore: boolean }>(allowed ? `${base}/documents?page=${page}&pageSize=10` : null, revision + localRevision);
  const selected = useResource<{ document: InvoiceDocument }>(allowed && selectedId ? `${base}/documents/${selectedId}` : null, revision + localRevision);
  const { busy, error, run, setError } = useAction(), document = selected.data?.document, draft = document?.analysis?.draft;
  function changed() { setLocalRevision(value => value + 1); refresh(); }
  async function mutate(path: string, body: unknown, method?: string) {
    try { return await api(path, body, method); }
    finally { changed(); }
  }
  const [view, setView] = useState<"review" | "source" | "tools">("review");
  useEffect(() => { setError(""); }, [selectedId, view, setError]);
  if (!allowed) return null;
  const processing = !!document && ["processing", "analyzing"].includes(document.status);
  const locked = !!busy || processing || selected.refreshing || !!selected.error;
  return <div className="grid min-w-0 gap-5" aria-busy={!!busy}>
    {config.error && <p role="alert" className="text-sm text-destructive">{config.error}</p>}
    {!selectedId ? <>
      <div className="grid gap-3">
        <input id={uploadId} type="file" className="peer sr-only" accept="application/pdf,image/png,image/jpeg" disabled={!!busy} onChange={event => {
          const file = event.currentTarget.files?.[0]; event.currentTarget.value = "";
          if (!file) return;
          void run("upload", async () => {
            if (file.size > 3 * 1024 * 1024) throw new Error("Choose an invoice file no larger than 3 MB");
            setNotice("");
            try { const result = await upload(base, file); setSelectedId(result.document.id); setView("review"); setNotice(result.duplicate ? "This file is already saved." : "Invoice saved."); }
            finally { changed(); }
          });
        }} />
        <label htmlFor={uploadId} className={`flex min-h-24 cursor-pointer items-center justify-center gap-3 rounded-2xl border border-dashed border-primary/25 bg-secondary/30 px-5 text-sm text-primary peer-focus-visible:ring-2 peer-focus-visible:ring-primary ${busy ? "pointer-events-none opacity-50" : "hover:bg-secondary/60"}`}><Upload size={20} />{busy === "upload" ? "Uploading..." : "Choose invoice"}</label>
        <p className="text-xs text-muted-foreground">PDF, PNG or JPEG · Up to 3 MB · PDFs up to 8 pages</p>
      </div>
      {config.data && <p className="text-xs text-muted-foreground">Encrypted retention: {config.data.retentionDays} days. Razor's server can read the files.</p>}
      {config.data && !config.data.processor.ready && <p className="text-xs text-amber-900">PDF extraction unavailable. Enter invoice fields manually.</p>}
      {history.error ? <p role="alert" className="text-sm text-destructive">{history.error}</p> : history.loading ? <Empty>Loading files...</Empty> : history.data?.documents.length ? <div className="divide-y">{history.data.documents.map(item => <button type="button" key={item.id} disabled={!!busy} onClick={() => { setSelectedId(item.id); setView("review"); setNotice(""); }} className="flex w-full min-w-0 flex-wrap items-center justify-between gap-3 py-4 text-left"><span className="min-w-0 break-words text-sm">{item.filename}<span className="mt-1 block text-xs text-muted-foreground">{Math.ceil(item.bytes / 1024)} KB · Expires {new Date(item.expiresAt).toLocaleDateString()}</span></span><Status value={item.status} /></button>)}</div> : history.data && <p className="py-8 text-center text-sm text-muted-foreground">No invoice files.</p>}
      {history.data && history.data.totalPages > 1 && <nav aria-label="Invoice file pages" className="flex items-center justify-between gap-3 text-sm"><button type="button" className="text-primary" disabled={!!busy || history.data.page <= 1} onClick={() => setPage(history.data!.page - 1)}>Previous</button><span className="text-xs">{history.data.page} / {history.data.totalPages}</span><button type="button" className="text-primary" disabled={!!busy || !history.data.hasMore} onClick={() => setPage(history.data!.page + 1)}>Next</button></nav>}
    </> : <>
      <button type="button" className="justify-self-start text-sm text-primary" disabled={!!busy} onClick={() => setSelectedId("")}>All files</button>
      {selected.error && <p role="alert" className="text-sm text-destructive">{selected.error}</p>}
      {selected.loading && <p role="status" className="text-sm">Loading invoice...</p>}
      {document && <>
        <div className="flex flex-wrap items-start justify-between gap-3"><h3 className="min-w-0 break-words text-base font-medium">{document.filename}</h3><Status value={document.status} /></div>
        {document.error && <p role="status" className="text-sm text-amber-900">{document.error.message}</p>}
        {document.similarDocumentIds.length > 0 && <p role="alert" className="text-sm text-amber-900">Matching source text exists. Check existing bills for duplicates.</p>}
        <div role="group" aria-label="File review sections" className="flex border-b">{(["review", "source", "tools"] as const).map(tab => <button key={tab} type="button" disabled={!!busy} aria-pressed={view === tab} className={`flex-1 border-b-2 pb-3 text-sm capitalize ${view === tab ? "border-primary text-primary" : "border-transparent text-muted-foreground"}`} onClick={() => setView(tab)}>{tab}</button>)}</div>
        <div hidden={view !== "review"} className="grid gap-5">
          {draft && <div className="grid gap-3 text-sm"><p>Printed amount: {invoiceSourceAmount(draft.amountPrinted || draft.amount || "Needs review")} {draft.currency || "Currency unidentified"}</p>{draft.warnings.length > 0 && <ul className="grid gap-2 text-amber-900">{draft.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>}</div>}
          {document.billId ? <div className="flex flex-wrap items-center justify-between gap-3"><p className="text-sm">Bill draft saved.</p><Action type="button" onClick={() => { navigate("bills"); if (document.billId) openInvoice(document.billId); }}>Open bill</Action></div> : prepare && <form key={`${document.id}:${document.revision}:review`} className="grid gap-5" onSubmit={event => {
            event.preventDefault(); const body = new FormData(event.currentTarget);
            void run("review", async () => {
              await mutate(`${base}/documents/${document.id}/review`, { revision: document.revision, sourceHash: document.sourceHash, recipientId: body.get("recipient"), reference: body.get("reference"), title: body.get("title"), agreedUSDC: body.get("amount"), maxFee: body.get("fee"), ...(body.get("dueDate") ? { dueDate: body.get("dueDate") } : {}), ...purchaseMatchInput(body), reviewConfirmed: true });
              setNotice("Draft saved for approval.");
            });
          }}>
            <fieldset disabled={locked} className="grid min-w-0 gap-5 sm:grid-cols-2"><Field label="Supplier"><select name="recipient" className={control} required><option value="">Choose a confirmed payee</option>{recipients.map(recipient => <option key={recipient.id} value={recipient.id}>{recipient.name}</option>)}</select></Field>
            <Field label="Reference"><input name="reference" className={control} required maxLength={120} defaultValue={draft?.reference ?? ""} /></Field>
            <Field label="Description"><input name="title" className={control} required maxLength={240} defaultValue={draft?.supplier ? `Invoice from ${draft.supplier}` : "Reviewed invoice"} /></Field>
            <Field label="Agreed net amount (USDC)"><input name="amount" className={control} required inputMode="decimal" defaultValue={draft?.currency === "USDC" ? draft.amount ?? "" : ""} /></Field>
            <details onInvalidCapture={event => { event.currentTarget.open = true; }} className="border-y py-4 sm:col-span-2"><summary className="cursor-pointer text-sm text-muted-foreground">Due date & costs</summary><div className="mt-4 grid gap-4 sm:grid-cols-2"><Field label="Cost limit (USDC)"><input name="fee" className={control} required inputMode="decimal" defaultValue="1" /></Field><Field label="Due date"><input name="dueDate" type="date" className={control} defaultValue={draft?.dueDate ?? ""} /></Field></div></details>
            <PurchaseMatchFields />
            <label className="flex items-start gap-2 text-sm sm:col-span-2"><input type="checkbox" required className="mt-1" />I checked the original, supplier, reference, items and agreed USDC amount. Wallet details use the confirmed receiving profile.</label></fieldset>
            <div className="flex justify-end border-t pt-5"><Action busy={busy === "review"} disabled={locked || !recipients.length}>Save draft</Action></div>
          </form>}
          {!prepare && !document.billId && <p className="text-sm text-muted-foreground">Payment-preparation and payee permissions are required.</p>}
        </div>
        <div hidden={view !== "source"} className="grid gap-5"><a className="justify-self-start text-sm text-primary" href={`/api${base}/documents/${document.id}/original`} download>Download original</a><form key={`${document.id}:${document.revision}:text`} className="grid gap-4" onSubmit={event => { event.preventDefault(); const body = new FormData(event.currentTarget); void run("text", async () => { await mutate(`${base}/documents/${document.id}/text`, { revision: document.revision, text: body.get("text") }, "PUT"); }); }}><Field label="Source text"><textarea name="text" className={`${control} min-h-64 text-sm`} maxLength={20000} defaultValue={document.text} required readOnly={!!document.billId || locked} /></Field>{!document.billId && <div className="flex justify-end"><Action disabled={locked} busy={busy === "text"}>Save corrected text</Action></div>}</form>{draft && <details className="text-xs"><summary className="cursor-pointer text-muted-foreground">Extracted fields & verification</summary><pre className="mt-3 max-h-64 overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-3">{JSON.stringify(document.analysis, null, 2)}</pre></details>}</div>
        <div hidden={view !== "tools"} className="grid gap-5"><div className="flex flex-wrap gap-4"><button type="button" className="min-h-10 text-sm text-primary" disabled={!!busy} onClick={changed}>Refresh status</button>{!document.billId && <><Action type="button" busy={busy === "extract"} disabled={locked || document.mediaType !== "application/pdf" || !config.data?.processor.ready} onClick={() => void run("extract", async () => { await mutate(`${base}/documents/${document.id}/extract`, { revision: document.revision }); })}>Retry extraction</Action><Action type="button" busy={busy === "analyze"} disabled={locked || !config.data?.privateAi.ready} onClick={() => void run("analyze", async () => { await mutate(`${base}/documents/${document.id}/analyze`, { revision: document.revision }); })}>Analyze privately</Action></>}</div>{!config.data?.privateAi.ready && !document.billId && <p className="text-xs text-muted-foreground">Private analysis unavailable.</p>}{document.sources.map((source, index) => <p className="text-xs text-muted-foreground" key={index}>{source.channelName} · {source.provider} · {new Date(source.receivedAt).toLocaleString()}</p>)}<details className="text-xs text-muted-foreground"><summary className="cursor-pointer">Source fingerprint</summary><p className="mt-3 break-all font-mono">{document.sourceHash}</p></details><div className="grid gap-3 border-t pt-5"><p className="text-xs text-muted-foreground">Deletes the source and analysis. Saved bills remain.</p><button type="button" className="justify-self-start min-h-10 text-sm text-destructive" disabled={locked} onClick={() => void run("delete", async () => { await mutate(`${base}/documents/${document.id}`, { revision: document.revision }, "DELETE"); setSelectedId(""); setNotice("Private source deleted."); })}>{busy === "delete" ? "Deleting..." : "Delete private source"}</button></div></div>
      </>}
    </>}
    {notice && <p role="status" className="text-sm text-primary">{notice}</p>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
  </div>;
}
