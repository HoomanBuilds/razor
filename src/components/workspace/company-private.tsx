"use client";

import { useState } from "react";
import { api } from "@/lib/api";
import { COMPANY_REVIEW_MAX_BYTES, parseCompanyReview, type CompanyReview } from "@/lib/company-private/schema";
import { useWorkspace } from "./context";
import { useAction } from "./hooks";
import { Action, control, DataTable, Field, Panel } from "./shared";

export function CompanyPrivateProcessing() {
  const { base, organization, recipients, refresh, navigate } = useWorkspace();
  const allowed = ["company:read", "payments:read", "payments:prepare", "documents:manage"].every(permission => organization.permissions?.includes(permission));
  const [review, setReview] = useState<CompanyReview | null>(null), [fileError, setFileError] = useState("");
  const [reading, setReading] = useState(false), [confirmed, setConfirmed] = useState(false), [notice, setNotice] = useState("");
  const { busy, error, run } = useAction();
  const payees = recipients.filter(value => value.preference_status === "confirmed" && value.confirmed_at);
  async function choose(file?: File) {
    setReview(null); setFileError(""); setConfirmed(false); setNotice("");
    if (!file) return;
    setReading(true);
    try {
      if (file.size > COMPANY_REVIEW_MAX_BYTES) throw new Error();
      setReview(parseCompanyReview(await file.text()));
    } catch { setFileError("Choose a valid company-operated review JSON file up to 256 KB. The file has not been uploaded."); }
    finally { setReading(false); }
  }
  return <Panel title="Process privately on your company computer" description="An optional company-operated mode keeps original invoices, the full extraction and your NEAR AI key outside Razor's hosted application.">
    <div className="grid min-w-0 grid-cols-1 gap-5">
      <p className="text-sm text-muted-foreground">Your computer verifies the required NEAR AI gateway and model identity, encrypts input and verifies signed output using the same private client as hosted analysis. Your own NEAR AI account pays for inference. Original files and local review artifacts remain on your computer until you delete them; the review file contains plaintext extracted fields. Revoke your key through your NEAR AI account. No key is entered in this page.</p>
      <details className="min-w-0 rounded-lg border p-4 text-sm"><summary className="cursor-pointer font-medium">Run the company-operated tool</summary><div className="mt-3 grid min-w-0 grid-cols-1 gap-3">
        <p>Use Node.js 24.22.1 or newer and the reviewed Razor source with its installed dependencies. Set your own <code>NEAR_AI_API_KEY</code>, <code>NEAR_AI_MODEL</code>, <code>NEAR_AI_MODEL_COMPOSE_SHA256</code> and <code>NEAR_AI_GATEWAY_COMPOSE_SHA256</code> only in that computer&apos;s environment. The command has no Razor endpoint or hosted fallback. PDF processing also needs the documented local PDF tools.</p>
        <pre className="max-w-full overflow-x-auto rounded-lg bg-muted p-3 text-xs">node --max-old-space-size=512 --import tsx scripts/process-invoice-private.ts --input /absolute/invoice.pdf --output /absolute/review.json --packet /absolute/evidence.json</pre>
        <p>TXT, PDF, PNG and JPEG files use bounded reading and processing. The output must use a new absolute path. Evidence export contains encrypted wire data by default, without plaintext or decryption keys. Use <code>--packet-mode metadata</code> for redacted evidence or omit <code>--packet</code>. Files are saved privately with mode 0600. Missing keys or failed verification stop processing. Manual invoice entry remains available.</p>
        <a href="/verify" target="_blank" rel="noopener noreferrer" className="w-fit text-primary">Open the local evidence verifier</a>
        <p className="text-xs text-muted-foreground">The evidence verifier reports individual claim limits. A signed encrypted response does not independently authenticate separately supplied decrypted fields or prove that an invoice is correct.</p>
      </div></details>
      {!allowed ? <p className="text-sm text-muted-foreground">A finance preparer with document access can import explicitly reviewed fields.</p> : <>
        <Field label="Open a local company review file" hint="JSON only, up to 256 KB. Reading this file sends nothing to Razor."><input type="file" accept="application/json,.json" disabled={reading || !!busy} onChange={event => void choose(event.target.files?.[0])} /></Field>
        {reading && <p role="status" className="text-sm">Reading the local review file...</p>}
        {fileError && <p role="alert" className="text-sm text-destructive">{fileError}</p>}
        {review && <div className="grid min-w-0 grid-cols-1 gap-4 rounded-lg border p-4">
          <p className="break-all text-xs text-muted-foreground">Source SHA-256: {review.source.sha256}. {review.source.kind.toUpperCase()}, {review.source.bytes.toLocaleString()} bytes. Company tool reported model {review.processing.model}, processed {new Date(review.processedAt).toLocaleString()}. This file and its verification metadata are exporter assertions and can be edited; Razor has not independently verified these plaintext fields.</p>
          <dl className="grid min-w-0 grid-cols-1 gap-3 text-sm sm:grid-cols-2"><div><dt className="text-muted-foreground">Supplier observed</dt><dd className="break-words">{review.draft.supplier || "Missing"}</dd></div><div><dt className="text-muted-foreground">Reference observed</dt><dd className="break-words">{review.draft.reference || "Missing"}</dd></div><div><dt className="text-muted-foreground">Printed amount and currency</dt><dd>{review.draft.amountPrinted || review.draft.amount || "Missing"} {review.draft.currency || "Unconfirmed"}</dd></div><div><dt className="text-muted-foreground">Model confidence</dt><dd>{review.draft.confidence === null ? "Not supplied" : `${Math.round(review.draft.confidence * 100)}% - a model estimate`}</dd></div></dl>
          <dl className="grid min-w-0 grid-cols-1 gap-3 text-sm sm:grid-cols-3">{[["Amount due observed", review.draft.amount], ["Due date observed", review.draft.dueDate], ["Subtotal", review.draft.subtotal], ["Tax", review.draft.tax], ["Withholding", review.draft.withholding], ["Deposit", review.draft.deposit]].map(([label, value]) => <div key={label}><dt className="text-muted-foreground">{label}</dt><dd>{value ?? "Missing"}</dd></div>)}</dl>
          {review.draft.warnings.map((warning, index) => <p key={index} className="text-xs text-amber-900">{warning}</p>)}
          {review.draft.paymentDetails && <p className="break-words text-xs text-amber-900">The document contains payment instructions. They are untrusted observations and will not be imported or used to change a receiving profile.</p>}
          {review.draft.lineItems.length > 0 && <details className="min-w-0"><summary className="cursor-pointer text-xs font-medium">Inspect extracted original-currency line items</summary><div className="mt-3"><DataTable columns={["Description", "Quantity", "Unit price", "Total"]}>{review.draft.lineItems.map((item, index) => <tr key={index}><td className="max-w-64 break-words">{item.description}</td><td>{item.quantity ?? "Missing"}</td><td>{item.unitPrice ?? "Missing"}</td><td>{item.total ?? "Missing"}</td></tr>)}</DataTable></div></details>}
          <form key={`${review.source.sha256}:${review.processedAt}`} className="grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-2" onChange={event => { const target = event.nativeEvent.target; if (!(target instanceof HTMLInputElement) || target.name !== "reviewConfirmed") setConfirmed(false); }} onSubmit={event => {
            event.preventDefault(); if (!confirmed) return; const values = new FormData(event.currentTarget);
            void run("import-local-review", async () => {
              const dueDate = String(values.get("dueDate") ?? "");
              const result = await api<{ billId: string; message: string }>(`${base}/company-private/reviewed-invoices`, { sourceSha256: review.source.sha256, sourceKind: review.source.kind,
                recipientId: values.get("recipient"), reference: values.get("reference"), title: values.get("title"), agreedUSDC: values.get("amount"), maxFeeUSDC: values.get("fee"), ...(dueDate ? { dueDate } : {}), reviewConfirmed: true });
              setNotice(result.message); setConfirmed(false); refresh();
            });
          }}>
            <fieldset disabled={!!busy} className="contents">
              <Field label="Confirmed company payee"><select name="recipient" className={control} required defaultValue=""><option value="">Choose an existing payee</option>{payees.map(payee => <option key={payee.id} value={payee.id}>{payee.name}</option>)}</select></Field>
              <Field label="Reviewed invoice reference"><input name="reference" className={control} required maxLength={120} defaultValue={review.draft.reference && review.draft.reference.length <= 120 ? review.draft.reference : ""} /></Field>
              <Field label="Reviewed bill description"><input name="title" className={control} required maxLength={240} defaultValue={review.draft.supplier ? `Invoice from ${review.draft.supplier}` : "Company-reviewed invoice"} /></Field>
              <Field label="Explicitly agreed obligation (USDC)" hint="Foreign-currency amounts are never converted automatically."><input name="amount" className={control} required inputMode="decimal" defaultValue={review.draft.currency === "USDC" ? review.draft.amount ?? "" : ""} /></Field>
              <Field label="Maximum payment cost (USDC)" hint="A cost ceiling for later route review, not an actual fee."><input name="fee" className={control} required inputMode="decimal" defaultValue="1" /></Field>
              <Field label="Reviewed due date (UTC, optional)"><input name="dueDate" type="date" className={control} defaultValue={review.draft.dueDate ?? ""} /></Field>
              <p className="text-xs leading-5 text-muted-foreground sm:col-span-2">Creating the draft sends only the source hash/type and the reviewed payee, reference, description, agreed USDC amount, cost ceiling and due date above. The raw document, complete extraction, payment instructions, model credentials and local evidence file are excluded. These selected fields are stored in the ordinary company bill record.</p>
              <label className="flex items-start gap-2 text-xs sm:col-span-2"><input name="reviewConfirmed" type="checkbox" required checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />I compared these fields with my original document, selected the confirmed payee and explicitly agreed the USDC amount. This creates a draft for separate approval.</label>
              <div className="sm:col-span-2"><Action busy={busy === "import-local-review"} disabled={!!busy || !confirmed || !payees.length}>Create reviewed bill draft</Action></div>
            </fieldset>
          </form>
        </div>}
      </>}
      {notice && <p role="status" className="text-sm">{notice}</p>}
      {notice && <button type="button" className="w-fit text-sm text-primary" onClick={() => navigate("bills")}>Open the company bill history</button>}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    </div>
  </Panel>;
}
