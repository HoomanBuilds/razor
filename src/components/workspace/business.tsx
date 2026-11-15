"use client";

import { proportion } from "@/lib/payment-activity";

import { useEffect, useState } from "react";
import { TaskDrawer, openTaskDrawer, closeTaskDrawer } from "./task-drawer";
import { FileSpreadsheet, Plus, Upload } from "lucide-react";
import { AssetIdentity, TokenLogo } from "@/components/assets/asset-identity";
import { PageMetrics, focusWorkspaceForm } from "./page-metrics";
import { companyTimeToIso } from "@/lib/company-time";
import { api, RequestError } from "@/lib/api";
import { dateLabel, microUsd, usd } from "@/lib/format";
import { useWorkspace } from "./context";
import { useAction, useResource } from "./hooks";
import {
  Action,
  control,
  DataTable,
  Empty,
  Field,
  Panel,
  Status,
} from "./shared";
import type { Bill, Payment, PayrollRun, Recipient, Token } from "./types";
import type { PayrollCsvItem } from "@/lib/csv";
import { BillTerms } from "./bill-terms";
import { PaymentManagementPanel } from "./payment-management";
import { PayrollImport, type ImportSelection } from "./payroll-import";
import { PurchaseMatchFields, PurchaseMatchReview, purchaseMatchInput, VendorCommitments } from "./vendor-commitments";
import { PayrollExecution } from "./payroll-execution";

function dollars(value: FormDataEntryValue | null, allowZero = false): string {
  try {
    return microUsd(String(value ?? ""), allowZero);
  } catch (cause) {
    throw new RequestError((cause as Error).message, 400, "INVALID_AMOUNT");
  }
}

function recordedPayee(payment: Payment | null, recipient?: Recipient) {
  const saved = payment as (Payment & { recipientName?: string; recipient_version?: number }) | null;
  return saved?.recipientName ?? (saved?.recipient_version === recipient?.version ? recipient?.name : null) ?? "Recorded payee";
}

export function Bills() {
  const [selectedBill, setSelectedBill] = useState("");
  const [approvalBillId, setApprovalBillId] = useState<string | null>(() => typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("reviewBill"));
  const { base, recipients, organization, revision, refresh, navigate } =
    useWorkspace();
  const canRead = organization.permissions?.includes("payments:read") === true;
  const canPrepare = organization.permissions?.includes("payments:prepare") === true;
  const canApprove = organization.permissions?.includes("payments:approve") === true;
  const {
    data,
    error: loadError,
    loading,
  } = useResource<{ bills: Bill[] }>(canRead ? `${base}/bills` : null, revision);
  const { busy, error, run } = useAction();
  useEffect(() => { if (selectedBill) document.getElementById("bill-review")?.scrollIntoView({block:"start"}); }, [selectedBill]);
  useEffect(() => { if (approvalBillId !== null && !loading) focusWorkspaceForm("bill-batch-review"); }, [approvalBillId, loading]);
  if (!canRead) return null;
  return (
    <div className="grid min-w-0 gap-7">
      <PageMetrics items={[
        {label:"Outstanding invoices",value:data ? usd(data.bills.reduce((sum,bill) => sum + BigInt(bill.remainingLiability),0n)) : loadError ? "Unavailable" : null,asset:"USDC"},
        {label:"Recorded invoices",value:data?.bills.length ?? (loadError ? "Unavailable" : null)},
        {label:"Settled invoices",value:data ? data.bills.filter(bill => BigInt(bill.remainingLiability) === 0n).length : loadError ? "Unavailable" : null,progress:data ? {value:proportion(data.bills.filter(bill => BigInt(bill.remainingLiability) === 0n).length,data.bills.length),label:"Settled / recorded",detail:`${data.bills.filter(bill => BigInt(bill.remainingLiability) === 0n).length} / ${data.bills.length}`} : undefined},
      ]}/>
      <Panel
        title="Invoice register"
        tone="white"
        description="Track supplier invoices from draft to settlement."
        action={<div className="flex flex-wrap items-center gap-3">{canPrepare && <Action type="button" onClick={() => focusWorkspaceForm("bill-compose")}><Plus size={15}/>New invoice</Action>}
          <button
            className="text-sm text-primary"
            onClick={() => setApprovalBillId("")}
          >
            Review invoice batch
          </button></div>
        }
      >
        {loadError && <p role="alert">{loadError}</p>}
        {loading ? (
          <Empty>Loading bills...</Empty>
        ) : !data?.bills.length ? (
          <Empty>Your first invoice will appear here.</Empty>
        ) : (
          <DataTable
            columns={["Invoice", "Payee", "Amount", "Due", "Status", "Action"]}
          >
            {data.bills.map((bill) => (
              <tr key={bill.id}>
                <td>
                  <div className="font-medium">{bill.reference}</div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    {bill.title}
                  </div>
                  {(bill.project_reference || bill.cost_center_reference) && <p className="mt-1 text-xs text-muted-foreground">{[bill.project_reference && `Project: ${bill.project_reference}`, bill.cost_center_reference && `Cost center: ${bill.cost_center_reference}`].filter(Boolean).join(" · ")}</p>}
                  <PurchaseMatchReview value={bill.vendorCommitment ?? null} />
                </td>
                <td>
                  {recordedPayee(bill.payment, recipients.find(
                    (recipient) => recipient.id === bill.recipient_id,
                  ))}
                </td>
                <td className="tabular-nums">{usd(bill.amount)}{BigInt(bill.acceptedCreditAmount ?? "0") > 0n && <p className="mt-1 text-xs text-muted-foreground">Accepted supplier credits {usd(bill.acceptedCreditAmount!)}</p>}{BigInt(bill.setoffAmount) > 0n && <p className="mt-1 text-xs text-muted-foreground">Noncash setoff {usd(bill.setoffAmount)}</p>}{BigInt(bill.fundedClearingAmount ?? "0") > 0n && <p className="mt-1 text-xs text-muted-foreground">Escrow-backed settlement {usd(bill.fundedClearingAmount!)}<br/>Company credit rights are separate from delivered tokens.</p>}{(BigInt(bill.acceptedCreditAmount ?? "0") > 0n || BigInt(bill.setoffAmount) > 0n || BigInt(bill.fundedClearingAmount ?? "0") > 0n) && <p className="mt-1 text-xs text-muted-foreground">Delivered {usd(bill.deliveredAmount)} · remaining {usd(bill.remainingLiability)}</p>}</td>
                <td>{dateLabel(bill.due_date, organization.timezone)}</td>
                <td>
                  <Status
                    value={
                      ["paid", "partially_paid", "settled", "cleared", "credited", "partially_settled"].includes(bill.status)
                        ? bill.status
                        : (bill.payment?.status ?? bill.status)
                    }
                  />
                </td>
                <td>
                  <div className="flex flex-wrap gap-2">
                    <button
                      className="text-xs text-primary"
                      onClick={() => setSelectedBill(bill.id)}
                    >
                      {canPrepare ? "Manage terms" : "View terms"}
                    </button>
                    {canApprove && bill.payment?.status === "draft" &&
                      bill.status !== "disputed" && (
                        <Action
                          disabled={!!busy}
                          onClick={() => setApprovalBillId(bill.id)}
                        >
                          Review approval
                        </Action>
                      )}
                    {bill.payment && (
                      <button
                        className="text-primary"
                        onClick={() => navigate("payments")}
                      >
                        View payment
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </DataTable>
        )}
      </Panel>
      {approvalBillId !== null && <div id="bill-batch-review" className="scroll-mt-8"><PaymentManagementPanel mode="bills" initialBillId={approvalBillId}/></div>}
      {selectedBill && <div id="bill-review" className="scroll-mt-8"><BillTerms id={selectedBill} close={() => setSelectedBill("")}/></div>}
      {canPrepare && <TaskDrawer id="bill-create-flow" title="Add an invoice" description="Record the supplier invoice and supporting payment terms."><Panel
        title="Add an invoice"
        description="Record the supplier, amount and due date."
        help="Approval creates one linked payment with a fixed net entitlement and fee ceiling. Recording an invoice does not fund or pay it."
      >
        <form
          id="bill-compose" aria-busy={!!busy}
          className="grid gap-4 sm:grid-cols-2"
          onSubmit={(event) => {
            event.preventDefault();
            const form = event.currentTarget,
              values = new FormData(form);
            void run("create", async () => {
              await api(`${base}/bills`, {
                recipientId: values.get("recipient"),
                title: values.get("title"),
                reference: values.get("reference"),
                amount: dollars(values.get("amount")),
                maxFee: dollars(values.get("fee"), true),
                dueDate: values.get("due")
                  ? companyTimeToIso(
                      String(values.get("due")),
                      organization.timezone,
                    )
                  : undefined,
                evidence: values.get("evidence") || undefined,
                projectReference: values.get("project") || undefined,
                costCenterReference: values.get("costCenter") || undefined,
                ...purchaseMatchInput(values),
              });
              form.reset();closeTaskDrawer("bill-create-flow",true);
              refresh();
            });
          }}
        >
          <Field label="Supplier or contractor">
            <select name="recipient" required className={control}>
              <option value="">Choose a payee</option>
              {recipients.map((recipient) => (
                <option key={recipient.id} value={recipient.id}>
                  {recipient.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Invoice reference">
            <input
              name="reference"
              className={control}
              required
              maxLength={120}
              placeholder="INV-1042"
            />
          </Field>
          <Field label="Description">
            <input
              name="title"
              className={control}
              required
              maxLength={240}
              placeholder="Design services"
            />
          </Field>
          <Field label="Net amount (USDC)">
            <input
              name="amount"
              className={control}
              required
              inputMode="decimal"
              placeholder="1200.00"
            />
          </Field>
          <Field label="Maximum payment cost (USDC)">
            <input
              name="fee"
              className={control}
              required
              inputMode="decimal"
              defaultValue="1.00"
            />
          </Field>
          <Field label="Due date" hint={organization.timezone}>
            <input name="due" type="datetime-local" className={control} />
          </Field>
          <Field label="Project reference (optional)">
            <input name="project" className={control} maxLength={120} />
          </Field>
          <Field label="Cost center (optional)">
            <input name="costCenter" className={control} maxLength={120} />
          </Field>
          <PurchaseMatchFields />
          <div className="sm:col-span-2">
            <Field label="Acceptance evidence or notes">
              <textarea
                name="evidence"
                className={control}
                maxLength={5000}
                rows={2}
                placeholder="Link or reference to the approved work"
              />
            </Field>
          </div>
          <div className="flex items-center gap-4 sm:col-span-2">
            <Action busy={busy === "create"} disabled={!recipients.length}>
              Save draft
            </Action>
            {organization.permissions?.includes("recipients:manage") && <button
              type="button"
              className="text-sm text-primary"
              onClick={() => navigate("recipients")}
            >
              Add a payee
            </button>}
            {organization.permissions?.includes("documents:manage") && <button
              type="button"
              className="text-sm text-primary"
              onClick={() => navigate("assistant")}
            >
              Analyze an invoice privately
            </button>}
          </div>
        </form>
        {error && (
          <p role="alert" className="mt-4 text-sm text-destructive">
            {error}
          </p>
        )}
      </Panel></TaskDrawer>}
      <Panel title="Purchase matching" description="Link invoices to approved supplier commitments." collapsible><VendorCommitments key={base}/></Panel>


    </div>
  );
}

export function Payroll() {
  const { base, recipients, recipientsLoading, recipientsError, organization, revision, refresh, navigate } = useWorkspace();
  const canRead = organization.permissions?.includes("payments:read") === true;
  const canPrepare = organization.permissions?.includes("payments:prepare") === true;
  const { data, error: loadError, loading } = useResource<{ runs: PayrollRun[] }>(canRead ? `${base}/payroll` : null, revision);
  const assets = useResource<{ tokens: Token[] }>(canPrepare ? "/assets" : null, revision);
  const { busy, error, run } = useAction();
  const [items, setItems] = useState<Record<string, string>>({});
  const [importedRows, setImportedRows] = useState<Record<string, PayrollCsvItem>>({});
  const [importSelection, setImportSelection] = useState<ImportSelection | null>(null);
  const [entryMode, setEntryMode] = useState<"manual" | "csv">("manual");
  const [csvFilename, setCsvFilename] = useState("");
  const [fee, setFee] = useState("1.00");
  const [reviewRunId, setReviewRunId] = useState(() => typeof window === "undefined" ? "" : new URLSearchParams(window.location.search).get("reviewRun") ?? "");
  const [executionRunId, setExecutionRunId] = useState("");
  const selected = Object.entries(items).filter(([, value]) => value.trim());
  let selectedTotal: bigint | null = 0n, selectedFees: bigint | null = 0n;
  try {
    for (const [id, amount] of selected) {
      selectedTotal += BigInt(microUsd(amount));
      selectedFees += BigInt(microUsd(importedRows[id]?.maxFee ?? fee, true));
    }
  } catch { selectedTotal = null; selectedFees = null; }
  const showReview = (id: string) => { setExecutionRunId(""); setReviewRunId(id); };
  const showExecution = (id: string) => { setReviewRunId(""); setExecutionRunId(id); };
  useEffect(() => { if (reviewRunId && !loading) focusWorkspaceForm("payroll-review"); }, [reviewRunId, loading]);
  useEffect(() => { if (executionRunId) document.getElementById("payroll-execution")?.scrollIntoView({ block: "start" }); }, [executionRunId]);
  if (!canRead) return null;
  return <div className="grid min-w-0 gap-7">
    <PageMetrics items={[
      { label: "Recorded pay runs", value: data?.runs.length ?? (loadError ? "Unavailable" : null) },
      { label: "Prepared net entitlement", value: data ? usd(data.runs.reduce((sum, payrun) => sum + BigInt(payrun.total), 0n)) : loadError ? "Unavailable" : null, asset: "USDC", detail: "Across all recorded pay runs" },
      { label: "Draft pay runs", value: data ? data.runs.filter(payrun => payrun.status === "draft").length : loadError ? "Unavailable" : null, progress: data ? { value: proportion(data.runs.filter(payrun => payrun.status === "draft").length, data.runs.length), label: "Draft / recorded", detail: `${data.runs.filter(payrun => payrun.status === "draft").length} / ${data.runs.length}` } : undefined },
    ]} />
    <Panel title="Pay runs" tone="white" description="Prepare, review and follow your team's payments." action={canPrepare ? <Action type="button" onClick={() => openTaskDrawer("payroll-create-flow")}><Plus size={15} />New pay run</Action> : undefined}>
      {loadError && <p role="alert" className="mb-4 text-sm text-destructive">Pay runs are unavailable. {loadError}</p>}
      {loading ? <Empty>Loading pay runs...</Empty> : !data ? <Empty>Refresh the workspace to load pay runs.</Empty> : !data.runs.length ? <Empty>Saved pay runs appear here for review and approval.</Empty> : <div className="divide-y rounded-2xl border bg-white">
        {data.runs.map(payrun => {
          const complete = payrun.items.length > 0 && payrun.items.every(item => item.remainingLiability === "0");
          const reviewFirst = !complete && payrun.items.every(item => BigInt(item.deliveredAmount) === 0n && (!item.payment || ["draft", "cancelled"].includes(item.payment.status)));
          return <article key={payrun.id} className="p-4 sm:p-5">
            <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_auto]">
              <div className="min-w-0"><div className="flex flex-wrap items-center gap-3"><h3 className="text-base font-medium">{payrun.reference}</h3><Status value={complete ? "paid" : payrun.status} /></div><p className="mt-2 text-xs text-muted-foreground">{dateLabel(payrun.period_start)} - {dateLabel(payrun.period_end)} · {payrun.items.length} recipients</p>{payrun.scheduled_for && <p className="mt-1 text-xs text-muted-foreground">Scheduled {dateLabel(payrun.scheduled_for, organization.timezone)}</p>}</div>
              <div className="flex items-center justify-between gap-5 sm:justify-end"><div className="sm:text-right"><p className="flex items-center gap-2 text-lg font-semibold tabular-nums"><TokenLogo symbol="USDC" size={18} />{usd(payrun.total)}</p><p className="mt-1 text-xs text-muted-foreground">Costs up to {usd(payrun.maxFees)}</p></div><Action type="button" onClick={() => reviewFirst ? showReview(payrun.id) : showExecution(payrun.id)}>{reviewFirst ? "Review run" : complete ? "View delivery" : "Continue run"}</Action></div>
            </div>
            <div className="mt-5 border-t pt-4"><details><summary className="cursor-pointer text-xs font-medium text-muted-foreground">Recipients and delivery ({payrun.items.length})</summary><div className="mt-4 divide-y rounded-xl bg-muted/40 px-4">
              {payrun.items.map(item => <div key={item.id} className="grid gap-3 py-4 sm:grid-cols-[minmax(0,1fr)_auto]"><div><p className="text-sm font-medium">{recordedPayee(item.payment, recipients.find(recipient => recipient.id === item.recipient_id))}</p><p className="mt-1 text-xs text-muted-foreground">{usd(item.deliveredAmount)} delivered · {usd(item.remainingLiability)} remaining</p></div><div className="flex items-center justify-between gap-4"><p className="text-sm font-medium tabular-nums">{usd(item.amount)}</p><Status value={item.remainingLiability === "0" ? "paid" : BigInt(item.deliveredAmount) > 0n ? "partially_paid" : item.payment?.status ?? "draft"} /></div></div>)}
            </div></details><div className="mt-3 flex items-center justify-between gap-4"><p className="text-xs text-muted-foreground">{reviewFirst ? "Review amounts and receiving details before approval." : "Completion requires a reconciled delivery for every recipient."}</p><button type="button" className="shrink-0 text-xs text-primary" onClick={() => reviewFirst ? showExecution(payrun.id) : showReview(payrun.id)}>{reviewFirst ? "Delivery progress" : "Review amounts"}</button></div></div>
          </article>;
        })}
      </div>}
    </Panel>
    {reviewRunId && <div id="payroll-review" className="scroll-mt-8"><PaymentManagementPanel mode="payroll" initialRunId={reviewRunId} /></div>}
    {executionRunId && <div id="payroll-execution" className="scroll-mt-8"><PayrollExecution key={executionRunId} runId={executionRunId} onReview={() => showReview(executionRunId)} /></div>}
    {canPrepare && <TaskDrawer id="payroll-create-flow" title="New pay run" description="Set your team's net pay, then save a draft for review and approval.">
      <form id="payroll-compose" aria-busy={!!busy} className="grid gap-7"
          onSubmit={(event) => {
            event.preventDefault();
            const form = event.currentTarget,
              values = new FormData(form);
            void run("create", async () => {
              const selected = Object.entries(items).filter(
                ([, value]) => value.trim(),
              );
              if (!selected.length)
                throw new RequestError(
                  "Add at least one recipient amount.",
                  400,
                  "EMPTY_RUN",
                );
              const terms = {
                reference: values.get("reference"),
                periodStart: values.get("start"),
                periodEnd: values.get("end"),
                scheduledFor: values.get("scheduled")
                  ? companyTimeToIso(
                      String(values.get("scheduled")),
                      organization.timezone,
                    )
                  : undefined,
              };
              const payload = {
                ...terms,
                items: selected.map(([recipientId, value]) => {
                  const imported = importedRows[recipientId], adjustment = imported?.adjustmentAmount;
                  return {
                    recipientId,
                    amount: dollars(value),
                    maxFee: dollars(imported?.maxFee ?? values.get("fee"), true),
                    note: imported?.note,
                    ...(imported?.baseAmount !== undefined ? { baseAmount: dollars(imported.baseAmount, true), bonusAmount: dollars(imported.bonusAmount ?? "0", true), adjustmentAmount: adjustment?.startsWith("-") ? `-${dollars(adjustment.slice(1), true)}` : dollars(adjustment ?? "0", true) } : {}),
                  };
                }),
              };
              const result = importSelection
                ? await api<{ run: PayrollRun }>(`${base}/payroll-import/drafts/${importSelection.id}/commit`, { ...terms, expectedVersion: importSelection.version, reviewToken: importSelection.reviewToken, confirmed: true })
                : await api<{ run: PayrollRun }>(`${base}/payroll`, payload);
              setItems({});
              setImportedRows({});
              setImportSelection(null);
              setFee("1.00");
              setCsvFilename("");
              showReview(result.run.id);closeTaskDrawer("payroll-create-flow",true);
              form.reset();
              refresh();
            });
          }}
        >

        <fieldset disabled={!!busy} className="grid min-w-0 gap-7">
          <section className="grid gap-4"><h3 className="text-sm font-medium">Run details</h3><Field label="Pay-run reference"><input name="reference" className={control} required placeholder="November payroll" maxLength={120} /></Field><div className="grid gap-4 sm:grid-cols-2"><Field label="Period start"><input name="start" type="date" className={control} required /></Field><Field label="Period end"><input name="end" type="date" className={control} required /></Field></div><details className="text-sm"><summary className="cursor-pointer text-muted-foreground">Schedule payment (optional)</summary><div className="mt-4"><Field label="Scheduled payment" hint={`Company time: ${organization.timezone}`}><input name="scheduled" type="datetime-local" className={control} /></Field></div></details></section>
          <section className="grid min-w-0 gap-4 border-t pt-6"><div className="flex flex-wrap items-center justify-between gap-3"><div><h3 className="text-sm font-medium">Recipient amounts</h3><p className="mt-1 text-xs text-muted-foreground">Enter net USDC pay. Leave an amount blank to exclude a payee.</p></div><div role="group" aria-label="Amount entry method" className="flex rounded-xl bg-muted p-1">{(["manual", "csv"] as const).map(mode => <button key={mode} type="button" aria-pressed={entryMode === mode} onClick={() => setEntryMode(mode)} className={`rounded-lg px-3 py-2 text-xs font-medium ${entryMode === mode ? "bg-white text-foreground shadow-sm" : "text-muted-foreground"}`}>{mode === "manual" ? "Enter amounts" : "Import CSV"}</button>)}</div></div>
            {entryMode === "csv" && <div className="grid gap-4 rounded-xl border bg-white p-4"><div className="flex items-start gap-3"><FileSpreadsheet className="mt-1 shrink-0 text-primary" size={20} /><div><p className="text-sm font-medium">Import a standard payroll CSV</p><p className="mt-1 text-xs leading-5 text-muted-foreground">Use recipient_id or email with amount in USDC. Uploaded amounts replace the current selection.</p></div></div><label className="flex w-fit cursor-pointer items-center gap-2 rounded-xl border px-4 py-2.5 text-sm font-medium focus-within:ring-2 focus-within:ring-primary"><Upload size={15} />{busy === "csv" ? "Reading CSV..." : "Choose CSV file"}<input type="file" accept=".csv,text/csv" className="sr-only" disabled={!!busy || !!recipientsLoading || !!recipientsError} onChange={event => {
              const input = event.currentTarget, file = input.files?.[0];
              if (!file) return;
              void run("csv", async () => {
                try {
                  const { parsePayrollDetailsCsv } = await import("@/lib/csv");
                  const parsed = parsePayrollDetailsCsv(await file.text(), recipients);
                  setItems(Object.fromEntries(Object.entries(parsed).map(([id, item]) => [id, item.amount])));
                  setImportedRows(parsed); setImportSelection(null); setCsvFilename(file.name);
                } finally { input.value = ""; }
              });
            }} /></label>{csvFilename && <p role="status" className="break-words text-xs text-muted-foreground">Loaded {csvFilename}</p>}<details className="text-xs text-muted-foreground"><summary className="cursor-pointer">CSV columns and adjustments</summary><p className="mt-3 leading-5">Required: recipient_id or email, amount (net USDC). Optional: base_amount, bonus_amount, adjustment_amount, note and max_fee. Bonuses or corrections need base_amount and a note. The amount must match their net total.</p></details><div className="border-t pt-3"><button type="button" className="text-sm text-primary" onClick={() => { closeTaskDrawer("payroll-create-flow"); openTaskDrawer("payroll-import-flow"); }}>Map columns or resume a saved import</button><p className="mt-1 text-xs text-muted-foreground">For other column names, number formats, row corrections and saved mappings.</p></div></div>}
            {importSelection && <p role="status" className="rounded-xl bg-primary/5 p-3 text-xs leading-5">Reviewed import loaded. Its exact row amounts and cost caps will be used. Editing an amount switches this to a manual draft.</p>}
            {Object.keys(importedRows).length > 0 && <button type="button" className="justify-self-start text-xs text-primary" onClick={() => { setItems({}); setImportedRows({}); setImportSelection(null); setCsvFilename(""); setEntryMode("manual"); }}>Clear imported amounts and enter manually</button>}
            {recipientsLoading ? <Empty>Loading payees...</Empty> : recipientsError ? <div role="alert" className="rounded-xl border p-4 text-sm text-destructive">Payees could not be loaded. {recipientsError}</div> : !recipients.length ? <Empty><p>Add a payee to prepare payroll.</p>{organization.permissions?.includes("recipients:manage") && <Action type="button" className="mt-4" onClick={() => { closeTaskDrawer("payroll-create-flow"); navigate("recipients"); }}><Plus size={15} />Add payee</Action>}</Empty> : <div className="divide-y rounded-xl border bg-white px-4">
              {recipients.map(recipient => {
                const token = assets.data?.tokens.find(value => value.assetId === recipient.primary_asset || recipient.primary_asset === "USDC" && value.symbol === "USDC" && value.blockchain === recipient.primary_network);
                const components = importedRows[recipient.id]?.baseAmount !== undefined;
                return <div key={recipient.id} className="grid gap-3 py-4 sm:grid-cols-[minmax(0,1fr)_180px]"><div className="min-w-0"><p className="text-sm font-medium">{recipient.name}<span className="ml-2 text-xs font-normal capitalize text-muted-foreground">{recipient.kind}</span></p><div className="mt-2"><AssetIdentity symbol={token?.symbol || (recipient.primary_asset === "USDC" ? "USDC" : "Selected asset")} network={recipient.primary_network} assetId={recipient.primary_asset} size={20} /></div>{recipient.preference_status !== "confirmed" && <p className="mt-2 text-xs text-amber-800">Receiving details need confirmation before approval.</p>}</div><Field label="Net pay (USDC)"><input className={`${control} tabular-nums`} aria-label={`Net USDC for ${recipient.name}`} inputMode="decimal" placeholder="0.00" value={items[recipient.id] ?? ""} readOnly={components} onChange={event => {
                  setImportSelection(null);
                  setItems(previous => ({ ...previous, [recipient.id]: event.target.value }));
                  setImportedRows(previous => previous[recipient.id] ? { ...previous, [recipient.id]: { ...previous[recipient.id], amount: event.target.value } } : previous);
                }} /></Field>{components && <p className="text-xs leading-5 text-muted-foreground sm:col-span-2">Imported base, bonus and correction are preserved. Edit these components in the saved run review.</p>}</div>;
              })}
            </div>}
          </section>
          <section className="grid gap-4 border-t pt-6"><h3 className="text-sm font-medium">Payment settings</h3><div className="grid gap-4 sm:grid-cols-[200px_minmax(0,1fr)]"><Field label="Default cost ceiling (USDC)"><input name="fee" className={control} value={fee} onChange={event => setFee(event.target.value)} required inputMode="decimal" /></Field><p className="text-xs leading-5 text-muted-foreground sm:pt-7">Maximum company routing cost per recipient, separate from net pay. Imported row caps take precedence. Receiving assets follow each payee's confirmed preferences.</p></div></section>
        </fieldset>
        <footer className="grid gap-4 border-t pt-5"><div aria-live="polite" className="flex flex-wrap items-end justify-between gap-3"><p className="text-sm text-muted-foreground">{selected.length} {selected.length === 1 ? "recipient" : "recipients"} selected</p><div className="min-w-0 text-right"><p className="break-words text-lg font-semibold tabular-nums">{selectedTotal === null ? "Check entered amounts" : `${usd(selectedTotal)} net USDC`}</p><p className="mt-1 text-xs text-muted-foreground">{selectedFees === null ? "Enter valid amounts and cost caps to see the total." : `Maximum costs ${usd(selectedFees)}`}</p></div></div>{error && <p role="alert" className="rounded-xl bg-destructive/5 p-3 text-sm text-destructive">{error}</p>}<div className="flex flex-wrap items-center justify-between gap-3"><button type="button" className="text-sm text-muted-foreground" disabled={!!busy} onClick={() => closeTaskDrawer("payroll-create-flow")}>Close</button><Action busy={busy === "create"} disabled={!!busy || !!recipientsLoading || !!recipientsError || !selected.length || selectedTotal === null}>Save draft</Action></div><p className="text-xs text-muted-foreground">Saving a draft does not approve or send payments.</p></footer>
      </form>
    </TaskDrawer>}
    {canPrepare && <TaskDrawer id="payroll-import-flow" title="Import payroll" description="Map your spreadsheet, confirm its number format and review each allocation." wide><PayrollImport onUse={(rows, selection) => { setImportedRows(rows); setItems(Object.fromEntries(Object.entries(rows).map(([id, value]) => [id, value.amount]))); setImportSelection(selection); setEntryMode("csv"); closeTaskDrawer("payroll-import-flow"); openTaskDrawer("payroll-create-flow"); }} onInvalidated={() => { if (importSelection) { setImportedRows({}); setItems({}); setImportSelection(null); } }} onOpenRun={id => { showReview(id); closeTaskDrawer("payroll-import-flow", true); }} /></TaskDrawer>}
  </div>;
}
