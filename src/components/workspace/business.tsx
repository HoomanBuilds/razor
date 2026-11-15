"use client";

import { WORKSPACE_NAVIGATION_EVENT } from "@/lib/workspace-access";
import { sortInvoices } from "@/lib/invoice-register";
import { proportion } from "@/lib/payment-activity";

import { useEffect, useState } from "react";
import { TaskDrawer, openTaskDrawer, closeTaskDrawer } from "./task-drawer";
import { ChevronLeft, Plus, Upload } from "lucide-react";
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
import { PurchaseMatchFields, purchaseMatchInput } from "./vendor-commitments";
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
  const [selectedBill, setSelectedBill] = useState(() => typeof window === "undefined" ? "" : new URLSearchParams(window.location.search).get("invoice") ?? "");
  const [reviewBusy, setReviewBusy] = useState(false);
  const [draftEdited, setDraftEdited] = useState(false);
  const [approvalBillId, setApprovalBillId] = useState<string | null>(() => typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("reviewBill"));
  const { base, recipients, recipientsLoading, recipientsError, organization, revision, refresh, navigate } = useWorkspace();
  const canRead = organization.permissions?.includes("payments:read") === true;
  const canPrepare = organization.permissions?.includes("payments:prepare") === true;
  const { data, error: loadError, loading, refreshing } = useResource<{ bills: Bill[] }>(canRead ? `${base}/bills` : null, revision);
  const { busy, error, run } = useAction();
  const selected = data?.bills.find(bill => bill.id === selectedBill);
  const focused = !!selectedBill || approvalBillId !== null;
  useEffect(() => {
    let frame = 0;
    const readLocation = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const params = new URLSearchParams(window.location.search);
        if (params.get("section") !== "bills" || reviewBusy) return;
        setApprovalBillId(params.get("reviewBill"));
        setSelectedBill(params.get("invoice") ?? "");
      });
    };
    window.addEventListener(WORKSPACE_NAVIGATION_EVENT, readLocation);
    window.addEventListener("popstate", readLocation);
    return () => { cancelAnimationFrame(frame); window.removeEventListener(WORKSPACE_NAVIGATION_EVENT, readLocation); window.removeEventListener("popstate", readLocation); };
  }, [reviewBusy]);
  useEffect(() => { if (focused) document.getElementById("bill-focus")?.scrollIntoView({ block: "start" }); }, [focused, selectedBill, approvalBillId]);
  if (!canRead) return null;
  return <div id="bills-content" className="grid min-w-0 gap-6">
    {focused ? <div id="bill-focus" className="grid gap-5 scroll-mt-6">
      {approvalBillId !== null ? <><button type="button" className="flex min-h-10 items-center gap-1 justify-self-start text-sm text-primary" disabled={reviewBusy} onClick={() => setApprovalBillId(null)}><ChevronLeft size={16} />{selectedBill ? "Invoice" : "Invoices"}</button><div id="bill-batch-review"><PaymentManagementPanel mode="bills" initialBillId={approvalBillId} onBusyChange={setReviewBusy} /></div></> : <BillTerms key={selectedBill} id={selectedBill} bill={selected} close={() => setSelectedBill("")} review={() => setApprovalBillId(selectedBill)} />}
    </div> : <>
      <div className="hidden sm:block"><PageMetrics items={[
        { label: "Outstanding invoices", value: loadError ? "Unavailable" : data ? usd(data.bills.reduce((sum, bill) => sum + BigInt(bill.remainingLiability), 0n)) : null, asset: "USDC" },
        { label: "Recorded invoices", value: loadError ? "Unavailable" : data?.bills.length },
        { label: "Settled invoices", value: loadError ? "Unavailable" : data?.bills.filter(bill => BigInt(bill.remainingLiability) === 0n).length, progress: data && !loadError ? { value: proportion(data.bills.filter(bill => BigInt(bill.remainingLiability) === 0n).length, data.bills.length), label: "Settled / recorded", detail: `${data.bills.filter(bill => BigInt(bill.remainingLiability) === 0n).length} / ${data.bills.length}` } : undefined },
      ]} /></div>
      <div className="flex flex-wrap items-end justify-between gap-5">
        <div className="sm:hidden"><p className="text-xs text-muted-foreground">Outstanding</p><p className="mt-2 flex items-center gap-2 text-3xl font-medium tracking-tight tabular-nums"><TokenLogo symbol="USDC" size={24} />{loadError ? "Unavailable" : data ? usd(data.bills.reduce((sum, bill) => sum + BigInt(bill.remainingLiability), 0n)) : <span className="h-8 w-28 animate-pulse rounded bg-muted" />}</p></div>
        <div className="flex flex-wrap items-center gap-3">{canPrepare && <Action type="button" onClick={() => openTaskDrawer("bill-create-flow")}><Plus size={15} />New invoice</Action>}<button type="button" className="min-h-10 text-sm text-primary" onClick={() => setApprovalBillId("")}>Review batch</button></div>
      </div>
      {loadError ? <div role="alert" className="flex items-center justify-between gap-3 rounded-xl bg-red-50 p-4 text-sm text-destructive"><p>{loadError}</p><button type="button" onClick={refresh} className="underline">Retry</button></div> : null}
      <section id="invoice-register" className="min-w-0 rounded-3xl border bg-white px-5 sm:px-6" aria-label="Invoices">
        {loading ? <div role="status" className="grid gap-6 py-6">{[0, 1, 2].map(index => <div key={index} className="h-14 animate-pulse rounded-lg bg-muted" />)}<span className="sr-only">Loading invoices</span></div> : !data ? null : !data.bills.length ? <div className="py-12 text-center text-sm text-muted-foreground">No invoices yet.</div> : <div className="divide-y">{sortInvoices(data.bills).map(bill => {
          const remaining = BigInt(bill.remainingLiability), adjusted = remaining !== BigInt(bill.amount);
          const status = ["paid", "partially_paid", "settled", "cleared", "credited", "partially_settled", "disputed"].includes(bill.status) ? bill.status : bill.payment?.status ?? bill.status;
          return <article key={bill.id} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-2 py-5 sm:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(8rem,0.8fr)_auto]">
            <div className="min-w-0"><button type="button" className="text-left text-sm font-medium hover:text-primary" onClick={() => setSelectedBill(bill.id)}>{recordedPayee(bill.payment, recipients.find(recipient => recipient.id === bill.recipient_id))}</button><p className="mt-1.5 text-xs text-muted-foreground">{bill.reference}</p>{bill.due_date && remaining > 0n && <p className="mt-1.5 text-xs text-muted-foreground sm:hidden">Due {dateLabel(bill.due_date, organization.timezone)}</p>}</div>
            <div className="hidden sm:block"><Status value={status} />{bill.due_date && remaining > 0n && <p className="mt-1.5 text-xs text-muted-foreground">Due {dateLabel(bill.due_date, organization.timezone)}</p>}</div>
            <div className="text-right"><p className="font-medium tabular-nums">{usd(remaining > 0n ? bill.remainingLiability : bill.amount)}</p>{adjusted && remaining > 0n && <p className="mt-1.5 text-xs text-muted-foreground">remaining</p>}</div>
            <div className="col-span-2 flex items-center justify-between gap-3 sm:col-span-1 sm:justify-end"><span className="sm:hidden"><Status value={status} /></span><button type="button" className="min-h-9 text-sm text-primary" aria-label={`Open ${bill.reference}`} onClick={() => setSelectedBill(bill.id)}>{status === "disputed" || status === "held" ? "Review hold" : remaining > 0n ? "Review" : "View"}</button></div>
          </article>;
        })}</div>}
      </section>
      <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-muted-foreground">{data && !loadError && <span>{data.bills.length} invoices</span>}<button type="button" className="ml-auto min-h-10 text-primary" onClick={() => { navigate("procurement"); focusWorkspaceForm("vendor-commitments"); }}>Purchase commitments</button></div>
    </>}
    {canPrepare && <TaskDrawer id="bill-create-flow" title="New invoice"><form id="bill-compose" onChangeCapture={() => setDraftEdited(true)} aria-busy={!!busy} className="grid gap-5" onSubmit={event => {
      event.preventDefault(); const form = event.currentTarget, values = new FormData(form);
      void run("create", async () => {
        await api(`${base}/bills`, { recipientId: values.get("recipient"), title: values.get("title"), reference: values.get("reference"), amount: dollars(values.get("amount")), maxFee: dollars(values.get("fee"), true), dueDate: values.get("due") ? companyTimeToIso(String(values.get("due")), organization.timezone) : undefined, evidence: values.get("evidence") || undefined, projectReference: values.get("project") || undefined, costCenterReference: values.get("costCenter") || undefined, ...purchaseMatchInput(values) });
        form.reset(); setDraftEdited(false); closeTaskDrawer("bill-create-flow", true); refresh();
      });
    }}>
      <fieldset disabled={!!busy} className="grid min-w-0 gap-5 sm:grid-cols-2">
        <div className="grid gap-2"><Field label="Supplier"><select name="recipient" required className={control} disabled={!!busy || recipientsLoading || !!recipientsError}><option value="">{recipientsLoading ? "Loading suppliers..." : "Choose a supplier"}</option>{recipients.map(recipient => <option key={recipient.id} value={recipient.id}>{recipient.name}</option>)}</select></Field>{organization.permissions?.includes("recipients:manage") && <button type="button" disabled={!!busy} className="justify-self-start text-xs text-primary" onClick={() => { if (draftEdited && !window.confirm("Discard this invoice draft and add a supplier?")) return; navigate("recipients"); focusWorkspaceForm("payee-compose"); }}>Add supplier</button>}</div>
        <Field label="Reference"><input name="reference" className={control} required maxLength={120} placeholder="INV-1042" /></Field>
        <div className="sm:col-span-2"><Field label="Description"><input name="title" className={control} required maxLength={240} placeholder="Design services" /></Field></div>
        <div className="sm:col-span-2"><Field label="Net amount (USDC)"><input name="amount" className={`${control} text-xl tabular-nums`} required inputMode="decimal" placeholder="0.00" /></Field></div>
        <details onInvalidCapture={event => { event.currentTarget.open = true; }} className="group border-y py-4 sm:col-span-2"><summary className="cursor-pointer text-sm text-muted-foreground">Due date, costs & notes</summary><div className="mt-5 grid gap-4 sm:grid-cols-2"><Field label="Due date" hint={organization.timezone}><input name="due" type="datetime-local" className={control} /></Field><Field label="Cost limit (USDC)"><input name="fee" className={control} required inputMode="decimal" defaultValue="1.00" /></Field><Field label="Project"><input name="project" className={control} maxLength={120} /></Field><Field label="Cost center"><input name="costCenter" className={control} maxLength={120} /></Field><div className="sm:col-span-2"><Field label="Notes or acceptance evidence"><textarea name="evidence" className={control} maxLength={5000} rows={2} /></Field></div></div></details>
        <PurchaseMatchFields />
      </fieldset>
      {recipientsError && <p role="alert" className="text-sm text-destructive">{recipientsError}</p>}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <div className="flex justify-end border-t pt-5"><Action busy={busy === "create"} disabled={!!busy || !recipients.length || recipientsLoading || !!recipientsError || refreshing}>Save draft</Action></div>
    </form></TaskDrawer>}
  </div>;
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
  const [errorLocation, setErrorLocation] = useState<"csv" | "save">("save");
  const [reviewRunId, setReviewRunId] = useState(() => typeof window === "undefined" ? "" : new URLSearchParams(window.location.search).get("reviewRun") ?? "");
  const [executionRunId, setExecutionRunId] = useState("");
  const [runView, setRunView] = useState<"list" | "review" | "execution">(() => typeof window !== "undefined" && new URLSearchParams(window.location.search).get("reviewRun") ? "review" : "list");
  const selected = Object.entries(items).filter(([, value]) => value.trim());
  const usesDefaultFee = !selected.length || selected.some(([id]) => importedRows[id]?.maxFee === undefined);
  let selectedTotal: bigint | null = 0n, selectedFees: bigint | null = 0n;
  try {
    for (const [id, amount] of selected) {
      selectedTotal += BigInt(microUsd(amount));
      selectedFees += BigInt(microUsd(importedRows[id]?.maxFee ?? fee, true));
    }
  } catch { selectedTotal = null; selectedFees = null; }
  const showReview = (id: string) => { setReviewRunId(id); setRunView("review"); };
  const showExecution = (id: string) => { setExecutionRunId(id); setRunView("execution"); };
  useEffect(() => { if (reviewRunId && !loading && runView === "review") focusWorkspaceForm("payroll-review"); }, [reviewRunId, loading, runView]);
  useEffect(() => { if (executionRunId && runView === "execution") document.getElementById("payroll-execution")?.scrollIntoView({ block: "start" }); }, [executionRunId, runView]);
  if (!canRead) return null;
  return <div className="grid min-w-0 gap-7">
    <div hidden={runView !== "list"} className="grid gap-7"><PageMetrics items={[
      { label: "Recorded pay runs", value: data?.runs.length ?? (loadError ? "Unavailable" : null) },
      { label: "Prepared net entitlement", value: data ? usd(data.runs.reduce((sum, payrun) => sum + BigInt(payrun.total), 0n)) : loadError ? "Unavailable" : null, asset: "USDC",  },
      { label: "Draft pay runs", value: data ? data.runs.filter(payrun => payrun.status === "draft").length : loadError ? "Unavailable" : null, progress: data ? { value: proportion(data.runs.filter(payrun => payrun.status === "draft").length, data.runs.length), label: "Draft / recorded", detail: `${data.runs.filter(payrun => payrun.status === "draft").length} / ${data.runs.length}` } : undefined },
    ]} />
    <Panel title="Pay runs" tone="white" action={canPrepare ? <Action type="button" onClick={() => openTaskDrawer("payroll-create-flow")}><Plus size={15} />New pay run</Action> : undefined}>
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
            </div></details><div className="mt-3 flex items-center justify-between gap-4"><button type="button" className="shrink-0 text-xs text-primary" onClick={() => reviewFirst ? showExecution(payrun.id) : showReview(payrun.id)}>{reviewFirst ? "Delivery progress" : "Review amounts"}</button></div></div>
          </article>;
        })}
      </div>}
    </Panel>
    </div>{runView !== "list" && <button type="button" className="inline-flex w-fit items-center gap-1 text-sm text-primary" onClick={() => { if (!document.querySelector('#payroll-review [aria-busy="true"], #payroll-execution [aria-busy="true"]')) setRunView("list"); }}><ChevronLeft size={16} />Pay runs</button>}
    {reviewRunId && <div hidden={runView !== "review"} id="payroll-review" className="scroll-mt-8"><PaymentManagementPanel mode="payroll" initialRunId={reviewRunId} onRunChange={setReviewRunId} /></div>}
    {executionRunId && <div hidden={runView !== "execution"} id="payroll-execution" className="scroll-mt-8"><PayrollExecution key={executionRunId} runId={executionRunId} active={runView === "execution"} onReview={() => showReview(executionRunId)} /></div>}
    {canPrepare && <TaskDrawer id="payroll-create-flow" title="New pay run">
      <form id="payroll-compose" aria-busy={!!busy} className="grid gap-7"
          onSubmit={(event) => {
            event.preventDefault();
            setErrorLocation("save");
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
          <section className="grid gap-4"><Field label="Pay-run reference"><input name="reference" className={control} required placeholder="November payroll" maxLength={120} /></Field><div className="grid gap-4 sm:grid-cols-2"><Field label="Period start"><input name="start" type="date" className={control} required /></Field><Field label="Period end"><input name="end" type="date" className={control} required /></Field></div><details className="text-sm"><summary className="cursor-pointer text-muted-foreground">Schedule payment (optional)</summary><div className="mt-4"><Field label="Scheduled payment" hint={`Company time: ${organization.timezone}`}><input name="scheduled" type="datetime-local" className={control} /></Field></div></details></section>
          <section className="grid min-w-0 gap-4 border-t pt-6"><div className="flex flex-wrap items-center justify-between gap-3"><div><h3 className="text-sm font-medium">Net pay (USDC)</h3></div><div role="group" aria-label="Amount entry method" className="flex rounded-xl bg-muted p-1">{(["manual", "csv"] as const).map(mode => <button key={mode} type="button" aria-pressed={entryMode === mode} onClick={() => setEntryMode(mode)} className={`rounded-lg px-3 py-2 text-xs font-medium ${entryMode === mode ? "bg-white text-foreground shadow-sm" : "text-muted-foreground"}`}>{mode === "manual" ? "Enter amounts" : "Import CSV"}</button>)}</div></div>
            {entryMode === "csv" && <div className="grid gap-4 rounded-xl border bg-white p-4"><label className="flex w-fit cursor-pointer items-center gap-2 rounded-xl border px-4 py-2.5 text-sm font-medium focus-within:ring-2 focus-within:ring-primary"><Upload size={15} />{busy === "csv" ? "Reading CSV..." : "Choose CSV file"}<input type="file" accept=".csv,text/csv" className="sr-only" disabled={!!busy || !!recipientsLoading || !!recipientsError} onChange={event => {
              const input = event.currentTarget, file = input.files?.[0];
              if (!file) return;
              setErrorLocation("csv");
              void run("csv", async () => {
                try {
                  const { parsePayrollDetailsCsv } = await import("@/lib/csv");
                  const parsed = parsePayrollDetailsCsv(await file.text(), recipients);
                  setItems(Object.fromEntries(Object.entries(parsed).map(([id, item]) => [id, item.amount])));
                  setImportedRows(parsed); setImportSelection(null); setCsvFilename(file.name);
                } finally { input.value = ""; }
              });
            }} /></label>{error && errorLocation === "csv" && <p role="alert" className="text-sm text-destructive">{error}</p>}{csvFilename && <p role="status" className="break-words text-xs text-muted-foreground">Loaded {csvFilename}</p>}<details className="text-xs text-muted-foreground"><summary className="cursor-pointer">CSV columns and adjustments</summary><p className="mt-3 leading-5">Required: recipient_id or email, amount (net USDC). Optional: base_amount, bonus_amount, adjustment_amount, note and max_fee. Bonuses or corrections need base_amount and a note. The amount must match their net total.</p></details><div className="border-t pt-3"><button type="button" className="text-sm text-primary" onClick={() => { closeTaskDrawer("payroll-create-flow"); openTaskDrawer("payroll-import-flow"); }}>Map columns or resume a saved import</button></div></div>}
            {importSelection && <p role="status" className="rounded-xl bg-primary/5 p-3 text-xs leading-5">Reviewed import</p>}
            {Object.keys(importedRows).length > 0 && <button type="button" className="justify-self-start text-xs text-primary" onClick={() => { setItems({}); setImportedRows({}); setImportSelection(null); setCsvFilename(""); setEntryMode("manual"); }}>Clear imported amounts</button>}
            {recipientsLoading ? <Empty>Loading payees...</Empty> : recipientsError ? <div role="alert" className="rounded-xl border p-4 text-sm text-destructive">Payees could not be loaded. {recipientsError}</div> : !recipients.length ? <Empty><p>Add a payee to prepare payroll.</p>{organization.permissions?.includes("recipients:manage") && <Action type="button" className="mt-4" onClick={() => { closeTaskDrawer("payroll-create-flow"); navigate("recipients"); }}><Plus size={15} />Add payee</Action>}</Empty> : <div className="divide-y rounded-xl border bg-white px-4">
              {recipients.map(recipient => {
                const token = assets.data?.tokens.find(value => value.assetId === recipient.primary_asset || recipient.primary_asset === "USDC" && value.symbol === "USDC" && value.blockchain === recipient.primary_network);
                const components = importedRows[recipient.id]?.baseAmount !== undefined;
                return <div key={recipient.id} className="grid grid-cols-[minmax(0,1fr)_112px] items-center gap-3 py-4"><div className="min-w-0"><p className="text-sm font-medium">{recipient.name}<span className="ml-2 text-xs font-normal capitalize text-muted-foreground">{recipient.kind}</span></p><div className="mt-2"><AssetIdentity symbol={token?.symbol || (recipient.primary_asset === "USDC" ? "USDC" : "Selected asset")} network={recipient.primary_network} assetId={recipient.primary_asset} size={20} /></div>{recipient.preference_status !== "confirmed" && <p className="mt-2 text-xs text-amber-800">Receiving details need confirmation before approval.</p>}</div><input className={`${control} text-right tabular-nums`} aria-label={`Net USDC for ${recipient.name}`} inputMode="decimal" placeholder="-" value={items[recipient.id] ?? ""} readOnly={components} onChange={event => {
                  setImportSelection(null);
                  setItems(previous => ({ ...previous, [recipient.id]: event.target.value }));
                  setImportedRows(previous => previous[recipient.id] ? { ...previous, [recipient.id]: { ...previous[recipient.id], amount: event.target.value } } : previous);
                }} />{(components || importedRows[recipient.id]?.maxFee) && <p className="col-span-2 text-xs text-muted-foreground">{[components && "Imported components", importedRows[recipient.id]?.maxFee && `Cost limit ${usd(microUsd(importedRows[recipient.id].maxFee!, true))}`].filter(Boolean).join(" · ")}</p>}</div>;
              })}
            </div>}
          </section>
          {usesDefaultFee ? <div className="flex items-center justify-between gap-4 border-t pt-5"><label htmlFor="payroll-cost-limit" className="text-sm font-medium">Default cost limit</label><div className="relative w-28 shrink-0"><span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-sm text-muted-foreground">$</span><input id="payroll-cost-limit" name="fee" aria-label="Default routing cost limit in USDC" className={`${control} pl-7 text-right tabular-nums`} value={fee} onChange={event => setFee(event.target.value)} required inputMode="decimal" /></div></div> : <input type="hidden" name="fee" value={fee} />}
        </fieldset>
        <footer className="grid gap-5 border-t pt-5">{error && errorLocation === "save" && <p role="alert" className="text-sm text-destructive">{error}</p>}<div aria-live="polite" className="flex items-center justify-between gap-4"><div><p className="text-sm text-muted-foreground">{selected.length} {selected.length === 1 ? "recipient" : "recipients"}</p><p className="mt-1 text-xs text-muted-foreground">{selectedFees === null ? "Check cost limits" : `Costs up to ${usd(selectedFees)}`}</p></div><p className="flex min-w-0 items-center gap-2 text-2xl font-semibold tabular-nums"><TokenLogo symbol="USDC" size={24} /><span className="min-w-0 break-words">{selectedTotal === null ? "Check amounts" : usd(selectedTotal)}</span></p></div><div className="flex items-center justify-between gap-4"><button type="button" className="text-sm text-muted-foreground" disabled={!!busy} onClick={() => closeTaskDrawer("payroll-create-flow")}>Close</button><Action className="min-w-36" busy={busy === "create"} disabled={!!busy || !!recipientsLoading || !!recipientsError || !selected.length || selectedTotal === null}>Save draft</Action></div></footer>
      </form>
    </TaskDrawer>}
    {canPrepare && <TaskDrawer id="payroll-import-flow" title="Import payroll"><PayrollImport onUse={(rows, selection) => { setImportedRows(rows); setItems(Object.fromEntries(Object.entries(rows).map(([id, value]) => [id, value.amount]))); setImportSelection(selection); setEntryMode("csv"); closeTaskDrawer("payroll-import-flow"); openTaskDrawer("payroll-create-flow"); }} onInvalidated={() => { if (importSelection) { setImportedRows({}); setItems({}); setImportSelection(null); } }} onOpenRun={id => { showReview(id); closeTaskDrawer("payroll-import-flow", true); }} /></TaskDrawer>}
  </div>;
}
