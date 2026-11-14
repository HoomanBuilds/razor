"use client";

import { useState } from "react";
import { api, ACCESS_CHANGED_EVENT, RequestError, SESSION_EXPIRED_EVENT } from "@/lib/api";
import type { ExtractedInvoice } from "@/server/assistant/extraction";
import { useWorkspace } from "./context";
import { useAction, useResource } from "./hooks";
import { Action, control, Empty, Field, Panel, Status } from "./shared";

interface Summary {
  id: string; filename: string; mediaType: string; bytes: number; sourceHash: string;
  status: string; revision: number; billId: string | null; expiresAt: string;
  error: { code: string; message: string } | null;
}
interface InvoiceDocument extends Summary {
  text: string; needsVision: boolean; similarDocumentIds: string[];
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
  const { base, organization, recipients, revision, refresh, navigate } = useWorkspace();
  const allowed = organization.permissions?.includes("documents:manage") === true;
  const prepare = organization.permissions?.includes("payments:prepare") === true && organization.permissions?.includes("recipients:read") === true;
  const [selectedId, setSelectedId] = useState(""), [localRevision, setLocalRevision] = useState(0), [page, setPage] = useState(1), [notice, setNotice] = useState("");
  const config = useResource<Configuration>(allowed ? `${base}/documents/config` : null, revision);
  const history = useResource<{ documents: Summary[]; page: number; totalPages: number; total: number; hasMore: boolean }>(allowed ? `${base}/documents?page=${page}&pageSize=10` : null, revision + localRevision);
  const selected = useResource<{ document: InvoiceDocument }>(allowed && selectedId ? `${base}/documents/${selectedId}` : null, revision + localRevision);
  const { busy, error, run } = useAction(), document = selected.data?.document, draft = document?.analysis?.draft;
  function changed() { setLocalRevision(value => value + 1); refresh(); }
  async function mutate(path: string, body: unknown, method?: string) {
    try { return await api(path, body, method); }
    finally { changed(); }
  }
  if (!allowed) return null;
  const processing = !!document && ["processing", "analyzing"].includes(document.status);
  return <Panel title="Invoice files" description="Upload a PDF or invoice photo, review its source and save a bill draft. Payment approval remains a separate step.">
    {config.error && <p role="alert" className="mb-4 text-sm text-destructive">{config.error}</p>}
    <p className="mb-4 text-xs leading-5 text-muted-foreground">PDF, PNG or JPEG, up to 3 MB. PDFs support up to 8 pages. Originals, source text and file review drafts are retained encrypted for {config.data?.retentionDays ?? 7} days. Razor's application server can read these files. Verified private analysis uses NEAR AI Cloud.</p>
    {config.data && !config.data.processor.ready && <p className="mb-4 text-sm text-amber-900">PDF extraction needs server setup. You can still upload an image or save an original and enter its invoice fields manually.</p>}
    <Field label={busy === "upload" ? "Saving and reading invoice..." : "Upload an invoice"} hint="Uploading never approves payment or changes the payee's receiving address.">
      <input type="file" className={control} accept="application/pdf,image/png,image/jpeg" disabled={!!busy} onChange={event => {
        const file = event.currentTarget.files?.[0]; event.currentTarget.value = "";
        if (!file) return;
        void run("upload", async () => {
          if (file.size > 3 * 1024 * 1024) throw new Error("Choose an invoice file no larger than 3 MB");
          setNotice("");
          try { const result = await upload(base, file); setSelectedId(result.document.id); setNotice(result.duplicate ? "This file is already saved. Open its existing review below." : "Invoice saved. Review the source before preparing a bill."); }
          finally { changed(); }
        });
      }} />
    </Field>
    {notice && <p role="status" className="mt-3 text-sm">{notice}</p>}
    {history.error && <p role="alert" className="mt-4 text-sm text-destructive">{history.error}</p>}
    <div className="mt-5 grid gap-2">{history.loading ? <Empty>Loading invoice files...</Empty> : !history.data?.documents.length ? <Empty>No retained invoice files yet.</Empty> : history.data.documents.map(item => <button type="button" key={item.id} disabled={!!busy} onClick={() => { setSelectedId(item.id); setNotice(""); }} aria-pressed={selectedId === item.id} className={`flex min-w-0 flex-wrap items-center justify-between gap-3 rounded-lg border p-3 text-left ${selectedId === item.id ? "border-primary bg-muted" : "hover:bg-muted/50"}`}><span className="min-w-0 break-all text-sm">{item.filename}<span className="mt-1 block text-xs text-muted-foreground">{Math.ceil(item.bytes / 1024)} KB · Expires {new Date(item.expiresAt).toLocaleDateString()}</span></span><Status value={item.status} /></button>)}</div>
    {history.data && history.data.totalPages > 1 && <nav aria-label="Invoice file pages" className="mt-4 flex items-center justify-between gap-3"><Action type="button" disabled={!!busy || history.data.page <= 1} onClick={() => setPage(history.data!.page - 1)}>Previous files</Action><span className="text-xs">Page {history.data.page} of {history.data.totalPages}</span><Action type="button" disabled={!!busy || !history.data.hasMore} onClick={() => setPage(history.data!.page + 1)}>Next files</Action></nav>}
    {selected.error && <p role="alert" className="mt-4 text-sm text-destructive">{selected.error}</p>}
    {selected.loading && <p role="status" className="mt-4 text-sm">Loading source review...</p>}
    {document && <div className="mt-6 space-y-5 rounded-lg border p-4">
      <div className="flex flex-wrap justify-between gap-3"><h3 className="break-all text-sm font-semibold">Review {document.filename}</h3><a className="text-sm text-primary" href={`/api${base}/documents/${document.id}/original`} download>Download original</a></div>
      <p className="break-all font-mono text-xs text-muted-foreground">Source SHA-256: {document.sourceHash}</p>
      {document.error && <p role="status" className="text-sm text-amber-900">{document.error.message}</p>}
      {document.similarDocumentIds.length > 0 && <p role="alert" className="text-sm text-amber-900">Another saved file has matching normalized source text. Check existing bills before creating another obligation.</p>}
      <div className="flex flex-wrap gap-3"><Action type="button" disabled={!!busy} onClick={changed}>Refresh saved status</Action>{!document.billId && <><Action type="button" busy={busy === "extract"} disabled={!!busy || processing || document.mediaType !== "application/pdf" || !config.data?.processor.ready} onClick={() => void run("extract", async () => { await mutate(`${base}/documents/${document.id}/extract`, { revision: document.revision }); })}>Retry PDF extraction</Action><Action type="button" busy={busy === "analyze"} disabled={!!busy || processing || !config.data?.privateAi.ready} onClick={() => void run("analyze", async () => { await mutate(`${base}/documents/${document.id}/analyze`, { revision: document.revision }); })}>Analyze privately</Action></>}</div>
      {!config.data?.privateAi.ready && !document.billId && <p className="text-sm text-muted-foreground">Private model analysis needs configuration. Source download, manual text correction and reviewed bill preparation remain available.</p>}
      <details open={!document.analysis} className="text-sm"><summary className="cursor-pointer font-medium">Source text and manual correction</summary><form key={`${document.id}:${document.revision}:text`} className="mt-3 grid gap-3" onSubmit={event => { event.preventDefault(); const body = new FormData(event.currentTarget); void run("text", async () => { await mutate(`${base}/documents/${document.id}/text`, { revision: document.revision, text: body.get("text") }, "PUT"); }); }}><Field label="Invoice text" hint="For scans, copy the relevant text from the original if private image analysis is unavailable. Saving corrected text replaces any prior extraction draft."><textarea name="text" className={`${control} min-h-40 font-mono text-xs`} maxLength={20000} defaultValue={document.text} required readOnly={!!document.billId || processing} /></Field>{!document.billId && <Action disabled={!!busy || processing} busy={busy === "text"}>Save reviewed source text</Action>}</form></details>
      {draft && <div className="space-y-3 text-sm"><p>Printed amount: {draft.amountPrinted || draft.amount || "Needs review"} {draft.currency || "Currency not identified"}</p>{draft.warnings.length > 0 && <ul className="list-disc space-y-1 pl-5 text-amber-900">{draft.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>}<details><summary className="cursor-pointer">Inspect extracted fields and verification</summary><pre className="mt-3 max-h-64 overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-3 text-xs">{JSON.stringify(document.analysis, null, 2)}</pre></details></div>}
      {document.billId ? <div className="flex flex-wrap items-center gap-3"><p className="text-sm">A reviewed bill draft is already linked to this source.</p><Action type="button" onClick={() => navigate("bills")}>Open bills</Action></div> : prepare && <form key={`${document.id}:${document.revision}:review`} className="grid gap-4 sm:grid-cols-2" onSubmit={event => {
        event.preventDefault(); const body = new FormData(event.currentTarget);
        void run("review", async () => {
          await mutate(`${base}/documents/${document.id}/review`, { revision: document.revision, sourceHash: document.sourceHash, recipientId: body.get("recipient"), reference: body.get("reference"), title: body.get("title"), agreedUSDC: body.get("amount"), maxFee: body.get("fee"), ...(body.get("dueDate") ? { dueDate: body.get("dueDate") } : {}), reviewConfirmed: true });
          setNotice("Reviewed bill draft saved. Its normal financial approval is still required.");
        });
      }}>
        <Field label="Confirmed payee"><select name="recipient" className={control} required disabled={!!busy || processing}><option value="">Choose the separately confirmed payee</option>{recipients.map(recipient => <option key={recipient.id} value={recipient.id}>{recipient.name}</option>)}</select></Field>
        <Field label="Invoice reference"><input name="reference" className={control} required maxLength={120} defaultValue={draft?.reference ?? ""} disabled={!!busy || processing} /></Field>
        <Field label="Description"><input name="title" className={control} required maxLength={240} defaultValue={draft?.supplier ? `Invoice from ${draft.supplier}` : "Reviewed invoice"} disabled={!!busy || processing} /></Field>
        <Field label="Agreed net USDC"><input name="amount" className={control} required inputMode="decimal" defaultValue={draft?.currency === "USDC" ? draft.amount ?? "" : ""} disabled={!!busy || processing} /></Field>
        <Field label="Maximum payment cost (USDC)"><input name="fee" className={control} required inputMode="decimal" defaultValue="1" disabled={!!busy || processing} /></Field>
        <Field label="Due date"><input name="dueDate" type="date" className={control} defaultValue={draft?.dueDate ?? ""} disabled={!!busy || processing} /></Field>
        <label className="flex items-start gap-2 text-sm sm:col-span-2"><input type="checkbox" required disabled={!!busy || processing} className="mt-1" />I checked the original document, supplier, reference, line items and agreed USDC amount. Invoice wallet details do not replace a confirmed receiving profile.</label>
        <div className="sm:col-span-2"><Action busy={busy === "review"} disabled={!!busy || processing || !recipients.length}>Save reviewed bill draft</Action></div>
      </form>}
      {!prepare && !document.billId && <p className="text-sm text-muted-foreground">A finance operator with payee access and payment-preparation permission must create the reviewed bill.</p>}
      <div className="border-t pt-4"><p className="mb-3 text-xs text-muted-foreground">Delete removes this private original, source text and linked analysis. Saved bills and payment history remain.</p><Action type="button" disabled={!!busy || processing} busy={busy === "delete"} onClick={() => void run("delete", async () => { await mutate(`${base}/documents/${document.id}`, { revision: document.revision }, "DELETE"); setSelectedId(""); setNotice("Private invoice source deleted. Existing bills remain available."); })}>Delete private source</Action></div>
    </div>}
    {error && <p role="alert" className="mt-4 text-sm text-destructive">{error}</p>}
  </Panel>;
}
