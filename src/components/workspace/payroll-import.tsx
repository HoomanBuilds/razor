"use client";

import { useMemo, useState } from "react";
import { ChevronLeft, Upload } from "lucide-react";
import { microUsd, usd } from "@/lib/format";
import { api } from "@/lib/api";
import { TokenLogo } from "@/components/assets/asset-identity";
import { defaultImportSettings, importFields, parsePayrollTable, suggestPayrollColumns, validateImportSettings, type ImportField, type ImportSettings, type PayrollImportPreview } from "@/lib/payroll-import";
import type { PayrollCsvItem } from "@/lib/csv";
import { useWorkspace } from "./context";
import { useAction, useResource } from "./hooks";
import { Action, control, DataTable, Field } from "./shared";

export interface ImportSelection { id: string; version: number; reviewToken: string }
interface Draft extends ImportSelection { source: string; filename: string; settings: ImportSettings; resolutions: Record<string, string>; corrections: Record<string, Partial<Record<ImportField, string>>>; preview: PayrollImportPreview; runId: string | null; expiresAt: string }
interface Template { id: string; name: string; version: number; headers: string[]; settings: ImportSettings }
interface DraftSummary { id: string; filename: string; version: number; runId: string | null; expired: boolean; updatedAt: string }
interface MappingSuggestion { mapping: ImportSettings["mapping"]; confidence: Partial<Record<ImportField, number>>; warnings: string[]; requiresReview: true; verification: { provider: string; model: string; ok: boolean }; retained: false }
const labels: Record<ImportField, string> = { recipientId: "Recipient ID", email: "Email", name: "Name (display only)", amount: "Final net USDC", baseAmount: "Base net USDC", bonusAmount: "Bonus", adjustmentAmount: "Signed correction", currency: "Currency", note: "Note / explanation", maxFee: "Maximum routing cost" };

export function PayrollImport({ onUse, onInvalidated, onOpenRun }: { onUse: (items: Record<string, PayrollCsvItem>, selection: ImportSelection) => void; onInvalidated: () => void; onOpenRun: (id: string) => void }) {
  const { base, recipients, organization, navigate, revision: workspaceRevision } = useWorkspace();
  const { busy, error, run, setError } = useAction();
  const [revision, setRevision] = useState(0), [source, setSource] = useState(""), [filename, setFilename] = useState("");
  const [settings, setSettings] = useState<ImportSettings>({ ...defaultImportSettings, mapping: {} });
  const [resolutions, setResolutions] = useState<Record<string, string>>({}), [corrections, setCorrections] = useState<Record<string, Partial<Record<ImportField, string>>>>({});
  const [draft, setDraft] = useState<Draft | null>(null), [requestKey, setRequestKey] = useState("");
  const [dirty, setDirty] = useState(false), [formatConfirmed, setFormatConfirmed] = useState(false), [reviewConfirmed, setReviewConfirmed] = useState(false);
  const [templateId, setTemplateId] = useState(""), [templateName, setTemplateName] = useState(""), [page, setPage] = useState(1), [notice, setNotice] = useState("");
  const [step, setStep] = useState<"file" | "mapping" | "review">("file");
  const [editingRowNumber, setEditingRowNumber] = useState<number | null>(null);
  const [rowTab, setRowTab] = useState<"edit" | "source">("edit");
  const [invitation, setInvitation] = useState("");
  const [suggestion, setSuggestion] = useState<MappingSuggestion | null>(null), [suggestionConfirmed, setSuggestionConfirmed] = useState(false);
  const templates = useResource<{ templates: Template[] }>(`${base}/payroll-import/templates`, revision);
  const drafts = useResource<{ drafts: DraftSummary[] }>(`${base}/payroll-import/drafts`, revision + workspaceRevision);
  const table = useMemo<{ headers: string[]; rows: Record<string, string>[]; error: string }>(() => {
    if (!source) return { headers: [], rows: [], error: "" };
    try { return { ...parsePayrollTable(source, settings.delimiter), error: "" }; }
    catch (cause) { return { headers: [], rows: [], error: (cause as Error).message }; }
  }, [source, settings.delimiter]);
  function invalidate(format = false) { setDirty(true); setReviewConfirmed(false); setNotice(""); onInvalidated(); if (format) setFormatConfirmed(false); }
  function changeSettings(next: ImportSettings) { setSettings(next); setSuggestion(null); setSuggestionConfirmed(false); invalidate(true); }
  async function savePreview() {
    if (!formatConfirmed) throw new Error("Confirm the mapped columns and number format before previewing.");
    const payload = { source, filename, settings, resolutions, corrections };
    const response = draft ? await api<{ draft: Draft }>(`${base}/payroll-import/drafts/${draft.id}`, { ...payload, expectedVersion: draft.version }, "PUT") : await api<{ draft: Draft }>(`${base}/payroll-import/drafts`, { ...payload, requestKey });
    setDraft(response.draft); setDirty(false); setReviewConfirmed(false); setPage(1); setRevision(value => value + 1); setStep("review"); setEditingRowNumber(null);
    return response.draft;
  }
  function restore(saved: Draft) {
    setSource(saved.source); setFilename(saved.filename); setSettings(saved.settings); setResolutions(saved.resolutions); setCorrections(saved.corrections); setDraft(saved); setSuggestion(null); setSuggestionConfirmed(false); setFormatConfirmed(false); setReviewConfirmed(false); setDirty(true); setPage(1); setStep("mapping"); setNotice(""); onInvalidated();
  }
  const selectedTemplate = templates.data?.templates.find(value => value.id === templateId);
  const committedRunId = draft?.runId || drafts.data?.drafts.find(value => value.id === draft?.id)?.runId;
  const result = draft?.preview;
  const orderedRows = [...(result?.rows ?? [])].sort((a, b) => Number(b.errors.length > 0) - Number(a.errors.length > 0) || Number(b.warnings.length > 0) - Number(a.warnings.length > 0) || a.rowNumber - b.rowNumber);
  const visibleRows = orderedRows.slice((page - 1) * 25, page * 25);
  const editingRow = result?.rows.find(row => row.rowNumber === editingRowNumber);
  const selectedRecipientId = editingRow ? resolutions[editingRow.rowNumber] ?? editingRow.recipientId : null;
  return <div aria-busy={!!busy} className="grid min-w-0 gap-6">
    {source && <div className="flex items-center justify-between gap-4 border-b pb-4"><div className="min-w-0"><p className="truncate text-sm font-medium" title={filename}>{filename}</p><p className="mt-1 text-xs text-muted-foreground">USDC · {settings.decimal === "." ? "Decimal point" : "Decimal comma"}{settings.thousands ? ` · ${settings.thousands === " " ? "Space" : settings.thousands} grouping` : ""}</p></div><button type="button" disabled={!!busy} className="shrink-0 text-sm text-primary" onClick={() => { setEditingRowNumber(null); setStep(step === "review" ? "mapping" : "file"); }}>{step === "review" ? "Change setup" : "Change file"}</button></div>}
    <div className="grid gap-5">
      {templates.error || drafts.error ? <p role="alert" className="text-sm text-destructive">{templates.error || drafts.error}</p> : null}
      <section hidden={step !== "file"}>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field as="div" label="Payroll CSV" hint="UTF-8 · up to 500 KB / 1,000 rows"><label className="flex min-h-11 cursor-pointer items-center justify-center gap-2 rounded-xl border bg-white px-4 py-2.5 text-sm font-medium focus-within:ring-2 focus-within:ring-primary"><Upload size={16} />{busy === "upload" ? "Reading CSV..." : "Choose CSV file"}<input type="file" accept=".csv,text/csv,text/plain" className="sr-only" disabled={!!busy} onChange={event => {
          const input = event.currentTarget, file = input.files?.[0];
          input.value = "";
          if (!file) return;
          void run("upload", async () => {
            if (file.size > 500_000) throw new Error("Upload a CSV smaller than 500 KB.");
            let text: string;
            try { text = new TextDecoder("utf-8", { fatal: true }).decode(await file.arrayBuffer()); }
            catch { throw new Error("Export the spreadsheet as UTF-8 CSV, then upload it again."); }
            const next = { ...defaultImportSettings, mapping: {} };
            try { next.mapping = suggestPayrollColumns(parsePayrollTable(text, next.delimiter).headers); } catch {}
            setSource(text); setFilename(file.name); setSettings(next); setDraft(null); setSuggestion(null); setSuggestionConfirmed(false); setRequestKey(crypto.randomUUID()); setResolutions({}); setCorrections({}); setTemplateId(""); setTemplateName(""); setFormatConfirmed(false); setReviewConfirmed(false); setDirty(true); setNotice(""); setStep("mapping"); onInvalidated(); input.value = "";
          });
        }} /></label></Field>
        <Field label="Resume a saved import"><select className={control} value="" disabled={!!busy || drafts.loading} onChange={event => {
          const id = event.target.value; if (!id) return;
          const saved = drafts.data?.drafts.find(value => value.id === id);
          if (saved?.runId) { onOpenRun(saved.runId); return; }
          void run("resume", async () => restore((await api<{ draft: Draft }>(`${base}/payroll-import/drafts/${id}`)).draft));
        }}><option value="">Choose a saved import</option>{drafts.data?.drafts.map(value => <option key={value.id} value={value.id} disabled={value.expired && !value.runId}>{value.filename}{value.runId ? " (pay run saved)" : value.expired ? " (expired)" : ` (v${value.version})`}</option>)}</select></Field>
      </div>
      </section>
      {source ? <section hidden={step !== "mapping"} className="grid gap-5">

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Column delimiter"><select className={control} value={settings.delimiter} disabled={!!busy} onChange={event => changeSettings({ ...settings, delimiter: event.target.value as ImportSettings["delimiter"] })}><option value=",">Comma</option><option value=";">Semicolon</option><option value={"\t"}>Tab</option><option value="|">Pipe</option></select></Field>
          <Field label="Decimal separator"><select className={control} value={settings.decimal} disabled={!!busy} onChange={event => changeSettings({ ...settings, decimal: event.target.value as ImportSettings["decimal"] })}><option value=".">Point, for example 1200.50</option><option value=",">Comma, for example 1200,50</option></select></Field>
          <Field label="Thousands separator"><select className={control} value={settings.thousands} disabled={!!busy} onChange={event => changeSettings({ ...settings, thousands: event.target.value as ImportSettings["thousands"] })}><option value="">None</option><option value=",">Comma</option><option value=".">Point</option><option value=" ">Space</option><option value="'">Apostrophe</option></select></Field>
          <Field label="Default routing cost cap (USDC)" hint="Use the selected number format."><input className={control} value={settings.defaultMaxFee} disabled={!!busy} onChange={event => changeSettings({ ...settings, defaultMaxFee: event.target.value })} /></Field>
        </div>
        {table.error ? <p role="alert" className="text-sm text-destructive">{table.error}</p> : <>
          <div className="flex flex-wrap items-end gap-3"><Field label="Saved column mapping"><select className={control} value={templateId} disabled={!!busy} onChange={event => {
            const id = event.target.value, value = templates.data?.templates.find(template => template.id === id); setTemplateId(id); if (!value) return;
            try { validateImportSettings(value.settings, table.headers); setTemplateName(value.name); changeSettings(value.settings); if (JSON.stringify(value.headers) !== JSON.stringify(table.headers)) setNotice("These headers differ from the saved mapping. Review every selected column before confirming."); }
            catch (cause) { setError((cause as Error).message); }
          }}><option value="">Manual mapping</option>{templates.data?.templates.map(template => <option key={template.id} value={template.id}>{template.name} (v{template.version})</option>)}</select></Field><Action type="button" disabled={!!busy} onClick={() => changeSettings({ ...settings, mapping: suggestPayrollColumns(table.headers) })}>Match familiar headers</Action></div>
          {organization.permissions?.includes("documents:manage") && <details className="rounded-lg border p-4 text-sm"><summary className="cursor-pointer font-medium">Optional private column suggestions</summary><div className="mt-3 grid gap-3">
            <p className="text-xs leading-5 text-muted-foreground">Send only this file's column headers to verified NEAR AI Cloud. CSV data rows, recipient records and the filename are excluded. Header names themselves may contain sensitive information, so review them before requesting suggestions. This uses one company private-AI attempt. Manual mapping and Match familiar headers remain available.</p>
            <p className="break-words text-xs">Headers to send: {table.headers.join("; ")}</p>
            <div><Action type="button" disabled={!!busy || !table.headers.length} busy={busy === "suggest-columns"} onClick={() => void run("suggest-columns", async () => {
              setSuggestion(null); setSuggestionConfirmed(false);
              const result = await api<{ suggestion: MappingSuggestion }>(`${base}/payroll-import/suggest-mapping`, { headers: table.headers, requestKey: crypto.randomUUID() });
              setSuggestion(result.suggestion);
            })}>Suggest columns privately</Action></div>
            {suggestion && <div className="grid gap-3" role="status">
              <p className="text-xs text-muted-foreground">Verified {suggestion.verification.provider} response. Confidence is a model estimate, not a correctness guarantee. Suggestions are held in this page until you apply them; no saved import or financial record has changed.</p>
              {Object.keys(suggestion.mapping).length ? <DataTable columns={["Payroll field", "Suggested source column", "Model confidence"]}>{Object.entries(suggestion.mapping).map(([field, column]) => <tr key={field}><td>{labels[field as ImportField]}</td><td className="break-words">{column}</td><td>{Math.round((suggestion.confidence[field as ImportField] ?? 0) * 100)}%</td></tr>)}</DataTable> : <p>No reliable columns were suggested. Map them manually.</p>}
              {suggestion.warnings.map(warning => <p key={warning} className="text-xs text-amber-900">{warning}</p>)}
              {Object.keys(suggestion.mapping).length > 0 && <><label className="flex items-start gap-2 text-xs"><input type="checkbox" checked={suggestionConfirmed} disabled={!!busy} onChange={event => setSuggestionConfirmed(event.target.checked)} />I reviewed these column suggestions. I will confirm number formats, payees and exact amounts separately.</label><div><Action type="button" disabled={!!busy || !suggestionConfirmed} onClick={() => { changeSettings({ ...settings, mapping: suggestion.mapping }); setNotice("Reviewed suggestions applied. Confirm the mapping and number format, then refresh the exact row preview."); }}>Apply reviewed suggestions</Action></div></>}
              <div><button type="button" className="text-xs text-primary" disabled={!!busy} onClick={() => { setSuggestion(null); setSuggestionConfirmed(false); }}>Dismiss suggestions</button></div>
            </div>}
          </div></details>}
          <div className="grid gap-3 rounded-xl border bg-white p-4 sm:grid-cols-2 lg:grid-cols-3">{importFields.map(field => <Field key={field} label={labels[field]}><select className={control} value={settings.mapping[field] ?? ""} disabled={!!busy} onChange={event => changeSettings({ ...settings, mapping: { ...settings.mapping, [field]: event.target.value } })}><option value="">Not mapped{field === "currency" ? " (explicit USDC)" : ""}</option>{table.headers.map(header => <option key={header} value={header}>{header}</option>)}</select></Field>)}</div>
          <details className="text-sm"><summary className="cursor-pointer text-primary">Preview original columns</summary><div className="mt-3"><DataTable columns={table.headers}>{table.rows?.slice(0, 3).map((record, index) => <tr key={index}>{table.headers.map(header => <td key={header} className="max-w-64 break-words">{record[header]}</td>)}</tr>)}</DataTable></div></details>
          <div className="flex flex-wrap items-end gap-3"><Field label="Mapping name"><input className={control} value={templateName} maxLength={120} onChange={event => setTemplateName(event.target.value)} /></Field><Action type="button" disabled={!!busy || !templateName.trim()} busy={busy === "save-mapping"} onClick={() => void run("save-mapping", async () => {
            const response = await api<{ template: Template }>(`${base}/payroll-import/templates${selectedTemplate ? `/${selectedTemplate.id}` : ""}`, { name: templateName, headers: table.headers, settings, ...(selectedTemplate ? { expectedVersion: selectedTemplate.version } : {}) }, selectedTemplate ? "PUT" : "POST");
            setTemplateId(response.template.id); setRevision(value => value + 1); setNotice(`Saved mapping version ${response.template.version}.`);
          })}>{selectedTemplate ? "Update / rename mapping" : "Save mapping"}</Action>{selectedTemplate ? <button type="button" className="text-sm text-destructive" disabled={!!busy} onClick={() => void run("archive-mapping", async () => { await api(`${base}/payroll-import/templates/${selectedTemplate.id}`, undefined, "DELETE"); setTemplateId(""); setRevision(value => value + 1); })}>Archive mapping</button> : null}</div>
          <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={formatConfirmed} disabled={!!busy} onChange={event => { setFormatConfirmed(event.target.checked); setReviewConfirmed(false); onInvalidated(); }} />Columns and USDC number format confirmed</label>
          <div className="flex flex-wrap gap-3"><Action type="button" disabled={!!busy || !formatConfirmed} busy={busy === "preview"} onClick={() => void run("preview", async () => { await savePreview(); })}>Review rows</Action>{organization.permissions?.includes("recipients:manage") ? <button type="button" className="text-sm text-primary disabled:opacity-50" disabled={!!busy || !formatConfirmed} onClick={() => void run("payees", async () => { if (dirty || !draft) await savePreview(); navigate("recipients"); })}>Save draft and add / invite payees</button> : null}</div>
        </>}
        {result && <button type="button" className="justify-self-start text-sm text-primary" disabled={!!busy} onClick={() => setStep("review")}>Back to rows</button>}
      </section> : null}
      {result && step === "review" ? editingRow ? <div className="grid gap-5"><div className="flex items-center justify-between gap-4"><button type="button" className="inline-flex items-center gap-1 text-sm text-primary" disabled={!!busy} onClick={() => { setEditingRowNumber(null); setInvitation(""); }}><ChevronLeft size={16} />All rows</button><p className="text-sm text-muted-foreground">Row {editingRow.rowNumber}</p></div><div className="flex flex-wrap items-center justify-between gap-3"><h3 className="text-lg font-medium">{editingRow.recipientName || editingRow.values.name || "Unmatched payee"}</h3>{editingRow.item && <p className="flex items-center gap-2 text-lg font-semibold"><TokenLogo symbol="USDC" size={22} />{usd(microUsd(editingRow.item.amount))}</p>}</div><div role="group" aria-label="Import row sections" className="flex border-b">{(["edit", "source"] as const).map(tab => <button key={tab} type="button" disabled={!!busy} aria-pressed={rowTab === tab} onClick={() => setRowTab(tab)} className={`flex-1 border-b-2 pb-3 text-sm ${rowTab === tab ? "border-primary font-medium text-primary" : "border-transparent text-muted-foreground"}`}>{tab === "edit" ? "Edit allocation" : "Source data"}</button>)}</div>
        <div hidden={rowTab !== "edit"} className="grid gap-4"><Field label="Payee"><select className={control} disabled={!!busy || !!committedRunId} value={selectedRecipientId ?? ""} onChange={event => { setResolutions(previous => ({ ...previous, [editingRow.rowNumber]: event.target.value })); setInvitation(""); invalidate(); }}><option value="">Choose a payee</option>{recipients.map(recipient => <option key={recipient.id} value={recipient.id}>{recipient.name}{recipient.email && recipients.some(other => other.id !== recipient.id && other.name.trim().toLocaleLowerCase() === recipient.name.trim().toLocaleLowerCase()) ? ` (${recipient.email})` : ""}</option>)}</select></Field><div className="grid gap-4 sm:grid-cols-2">{(["amount", "maxFee", "note"] as const).map(field => <Field key={field} label={field === "amount" ? "Net pay (USDC)" : field === "maxFee" ? "Cost limit (USDC)" : "Note (optional)"}><input className={control} value={corrections[editingRow.rowNumber]?.[field] ?? (editingRow.values[field] || (field === "maxFee" ? settings.defaultMaxFee : ""))} disabled={!!busy || !!committedRunId} maxLength={field === "note" ? 500 : 100} onChange={event => { setCorrections(previous => ({ ...previous, [editingRow.rowNumber]: { ...previous[editingRow.rowNumber], [field]: event.target.value } })); invalidate(); }} /></Field>)}</div><details open={!!editingRow.values.baseAmount || !!corrections[editingRow.rowNumber]?.baseAmount || editingRow.errors.some(value => /base|bonus|correction/i.test(value))}><summary className="cursor-pointer text-sm text-muted-foreground">Pay breakdown</summary><div className="mt-4 grid gap-4 sm:grid-cols-2">{(["baseAmount", "bonusAmount", "adjustmentAmount"] as const).map(field => <Field key={field} label={labels[field]}><input className={control} value={corrections[editingRow.rowNumber]?.[field] ?? editingRow.values[field] ?? ""} disabled={!!busy || !!committedRunId} maxLength={100} onChange={event => { setCorrections(previous => ({ ...previous, [editingRow.rowNumber]: { ...previous[editingRow.rowNumber], [field]: event.target.value } })); invalidate(); }} /></Field>)}</div></details>{editingRow.values.currency && editingRow.values.currency !== "USDC" && <Field label="Currency correction"><input className={control} value={corrections[editingRow.rowNumber]?.currency ?? editingRow.values.currency ?? ""} placeholder="USDC" disabled={!!busy || !!committedRunId} maxLength={100} onChange={event => { setCorrections(previous => ({ ...previous, [editingRow.rowNumber]: { ...previous[editingRow.rowNumber], currency: event.target.value } })); invalidate(); }} /></Field>}{editingRow.errors.map(value => <p className="text-sm text-destructive" key={value}>{value}</p>)}{editingRow.warnings.map(value => <p className="text-sm text-amber-900" key={value}>{value}</p>)}{selectedRecipientId && organization.permissions?.includes("recipients:manage") && <button type="button" disabled={!!busy} className="justify-self-start text-sm text-primary" onClick={() => void run(`invite-${editingRow.rowNumber}`, async () => setInvitation((await api<{ invitationUrl: string }>(`${base}/recipients/${selectedRecipientId}/invite`, {})).invitationUrl))}>Get confirmation link</button>}{!committedRunId && <Action disabled={!!busy || !formatConfirmed} busy={busy === "preview"} onClick={() => void run("preview", async () => { await savePreview(); })}>Save correction</Action>}</div>
        <div hidden={rowTab !== "source"} className="grid gap-5"><Field label="Currency correction"><input className={control} value={corrections[editingRow.rowNumber]?.currency ?? editingRow.values.currency ?? ""} placeholder="USDC" disabled={!!busy || !!committedRunId} maxLength={100} onChange={event => { setCorrections(previous => ({ ...previous, [editingRow.rowNumber]: { ...previous[editingRow.rowNumber], currency: event.target.value } })); invalidate(); }} /></Field><dl className="divide-y text-sm">{Object.entries(editingRow.source).map(([column, value]) => <div key={column} className="grid grid-cols-2 gap-4 py-3"><dt className="break-words text-muted-foreground">{column}</dt><dd className="break-words">{value || "Empty"}</dd></div>)}</dl>{Object.keys(draft?.corrections[editingRow.rowNumber] ?? {}).length > 0 && <div><h4 className="text-sm font-medium">Saved corrections</h4><dl className="mt-3 grid gap-3 text-sm">{Object.entries(draft?.corrections[editingRow.rowNumber] ?? {}).map(([field, value]) => <div key={field} className="grid grid-cols-2 gap-4"><dt className="text-muted-foreground">{labels[field as ImportField]}</dt><dd className="break-words">{value || "Cleared"}</dd></div>)}</dl></div>}</div>
      </div> : <div className="grid gap-5"><div className="flex flex-wrap items-center justify-between gap-3"><p className="text-sm text-muted-foreground">{result.ready} of {result.total} ready</p><p className="flex items-center gap-2 text-xl font-semibold"><TokenLogo symbol="USDC" size={24} />{usd(result.principal)}</p></div>{dirty && <p role="status" className="text-sm text-amber-900">Changes need a fresh preview.</p>}
        <div className="divide-y border-y">{visibleRows.map(row => <div key={row.rowNumber} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 py-4"><div className="min-w-0"><p className="text-sm font-medium">{row.recipientName || row.values.name || row.values.email || `Row ${row.rowNumber}`}</p>{row.errors.length ? <p className="mt-2 text-xs text-destructive">{row.errors[0]}{row.errors.length > 1 ? ` (+${row.errors.length - 1})` : ""}</p> : row.warnings.length ? <p className="mt-2 text-xs text-amber-900">{row.warnings[0]}</p> : null}</div><div className="text-right"><p className="text-sm font-medium tabular-nums">{row.item ? usd(microUsd(row.item.amount)) : "Check amount"}</p><button type="button" className="mt-2 text-sm text-primary" disabled={!!busy} aria-label={`Edit import row for ${row.recipientName || row.values.email || row.rowNumber}`} onClick={() => { setEditingRowNumber(row.rowNumber); setRowTab("edit"); setInvitation(""); }}>Edit</button></div></div>)}</div>
        {result.total > 25 && <nav aria-label="Payroll import rows" className="flex items-center justify-between gap-3 text-sm"><button type="button" disabled={page === 1} className="text-primary disabled:opacity-50" onClick={() => setPage(value => value - 1)}>Previous</button><span>{page} / {Math.max(1, Math.ceil(result.total / 25))}</span><button type="button" disabled={page * 25 >= result.total} className="text-primary disabled:opacity-50" onClick={() => setPage(value => value + 1)}>Next</button></nav>}
        <div className="flex justify-between gap-4 text-sm text-muted-foreground"><span>Maximum costs</span><span>{usd(result.maxFees)}</span></div>
        {committedRunId ? <Action type="button" onClick={() => onOpenRun(committedRunId)}>Open pay run</Action> : <><label className="flex items-center gap-3 text-sm"><input type="checkbox" checked={reviewConfirmed} disabled={dirty || !!busy || !formatConfirmed || !result.canCommit} onChange={event => setReviewConfirmed(event.target.checked)} />Payees, amounts and cost limits reviewed</label><Action type="button" disabled={dirty || !!busy || !formatConfirmed || !reviewConfirmed || !result.canCommit} onClick={() => { if (!draft) return; onUse(Object.fromEntries(result.rows.map(row => [row.recipientId!, row.item!])), { id: draft.id, version: draft.version, reviewToken: draft.reviewToken }); }}>Use in pay run</Action></>}
        <button type="button" disabled={!!busy} className="justify-self-start text-sm text-muted-foreground" onClick={() => void run("delete", async () => { await api(`${base}/payroll-import/drafts/${draft!.id}`, undefined, "DELETE"); setDraft(null); setSource(""); setStep("file"); onInvalidated(); setRevision(value => value + 1); })}>Delete import source</button>
      </div> : null}
      {invitation && editingRow && step === "review" ? <Field label={`Confirmation link for ${recipients.find(recipient => recipient.id === selectedRecipientId)?.name ?? "selected payee"}`}><input className={control} value={invitation} readOnly onFocus={event => event.currentTarget.select()} /></Field> : null}
      {notice ? <p role="status" className="text-sm text-muted-foreground">{notice}</p> : null}
      {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
    </div>
  </div>;
}
