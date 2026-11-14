"use client";

import { useState } from "react";
import { Plus } from "lucide-react";
import { TokenLogo } from "@/components/assets/asset-identity";
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
import type { Bill, Payment, PayrollRun, Recipient } from "./types";
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
  const [approvalBillId, setApprovalBillId] = useState<string | null>(null);
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
  if (!canRead) return null;
  return (
    <div className="grid min-w-0 gap-7">
      <PageMetrics items={[
        {label:"Outstanding invoices",value:data ? usd(data.bills.reduce((sum,bill) => sum + BigInt(bill.remainingLiability),0n)) : loadError ? "Unavailable" : null,asset:"USDC"},
        {label:"Recorded invoices",value:data?.bills.length ?? (loadError ? "Unavailable" : null)},
        {label:"Settled invoices",value:data ? data.bills.filter(bill => BigInt(bill.remainingLiability) === 0n).length : loadError ? "Unavailable" : null},
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
      {canPrepare && <Panel
        title="Add an invoice"
        description="Record the supplier, amount and due date."
        help="Approval creates one linked payment with a fixed net entitlement and fee ceiling. Recording an invoice does not fund or pay it."
      >
        <form
          id="bill-compose"
          className="scroll-mt-8 grid gap-4 md:grid-cols-3"
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
              form.reset();
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
          <div className="md:col-span-3">
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
          <div className="flex items-center gap-4 md:col-span-3">
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
      </Panel>}
      <Panel title="Purchase matching" description="Link invoices to approved supplier commitments." collapsible><VendorCommitments key={base}/></Panel>
      {approvalBillId !== null && (
        <PaymentManagementPanel mode="bills" initialBillId={approvalBillId} />
      )}
      {selectedBill && (
        <BillTerms id={selectedBill} close={() => setSelectedBill("")} />
      )}

    </div>
  );
}

export function Payroll() {
  const { base, recipients, organization, revision, refresh, navigate } =
    useWorkspace();
  const canRead = organization.permissions?.includes("payments:read") === true;
  const canPrepare = organization.permissions?.includes("payments:prepare") === true;
  const {
    data,
    error: loadError,
    loading,
  } = useResource<{ runs: PayrollRun[] }>(canRead ? `${base}/payroll` : null, revision);
  const { busy, error, run, setError } = useAction();
  const [items, setItems] = useState<Record<string, string>>({});
  const [importedRows, setImportedRows] = useState<Record<string, PayrollCsvItem>>({});
  const [importSelection, setImportSelection] = useState<ImportSelection | null>(null);
  const [reviewRunId, setReviewRunId] = useState("");
  const [executionRunId, setExecutionRunId] = useState("");
  if (!canRead) return null;
  return (
    <div className="grid min-w-0 gap-7">
      <PageMetrics items={[
        {label:"Recorded pay runs",value:data?.runs.length ?? (loadError ? "Unavailable" : null)},
        {label:"Prepared net entitlement",value:data ? usd(data.runs.reduce((sum,run) => sum + BigInt(run.total),0n)) : loadError ? "Unavailable" : null,asset:"USDC",detail:"Across all recorded pay runs"},
        {label:"Draft pay runs",value:data ? data.runs.filter(run => run.status === "draft").length : loadError ? "Unavailable" : null},
      ]}/>
      <Panel
        title="Pay runs"
        tone="white"
        description="Prepare, review and follow your team's payments."
        help="A pay run remains incomplete until every recipient has a reconciled delivery."
        action={canPrepare ? <Action type="button" onClick={() => focusWorkspaceForm("payroll-compose")}><Plus size={15}/>New pay run</Action> : undefined}
      >
        {loadError && <p role="alert">{loadError}</p>}
        {loading ? (
          <Empty>Loading pay runs...</Empty>
        ) : !data?.runs.length ? (
          <Empty>Saved pay runs appear here for review and approval.</Empty>
        ) : (
          <div className="grid gap-4">
            {data.runs.map((payrun) => (
              <article key={payrun.id} className="rounded-2xl border bg-muted/50 p-5">
                <div className="flex flex-wrap items-center justify-between gap-4">
                  <div>
                    <h3 className="flex items-center gap-2 text-base font-medium"><TokenLogo symbol="USDC" size={20}/>{payrun.reference}</h3>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {dateLabel(payrun.period_start)} -{" "}
                      {dateLabel(payrun.period_end)} · {payrun.items.length}{" "}
                      recipients
                    </p>
                  </div>
                  <div className="text-right">
                    <div className="font-semibold tabular-nums">
                      {usd(payrun.total)}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Costs up to {usd(payrun.maxFees)}
                    </p>
                  </div>
                  <Status value={payrun.status} />
                  <button
                    className="text-sm text-primary"
                    onClick={() => setReviewRunId(payrun.id)}
                  >
                    Review run
                  </button>
                  <button
                    className="text-sm text-primary"
                    onClick={() => setExecutionRunId(payrun.id)}
                  >
                    Execute run
                  </button>
                </div>
                <details className="mt-4 border-t pt-3"><summary className="cursor-pointer text-xs font-medium text-muted-foreground">View {payrun.items.length} recipients and delivery status</summary><div className="mt-4 grid gap-3">
                  {payrun.items.map((item) => (
                    <div
                      className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-white px-4 py-3 text-sm"
                      key={item.id}
                    >
                      <span>
                        {recordedPayee(item.payment, recipients.find(
                          (recipient) => recipient.id === item.recipient_id,
                        ))}
                      </span>
                      <span className="ml-auto tabular-nums">
                        {usd(item.amount)}
                      </span>
                      <Status value={item.remainingLiability === "0" ? "paid" : BigInt(item.deliveredAmount)>0n ? "partially_paid" : item.payment?.status ?? "draft"} /><p className="mt-1 text-xs text-muted-foreground">{usd(item.deliveredAmount)} delivered; {usd(item.remainingLiability)} remains</p>
                    </div>
                  ))}
                </div></details>
              </article>
            ))}
          </div>
        )}
      </Panel>

      {canPrepare && <Panel
        title="Prepare a pay run"
        description="Set the pay period and each recipient's net amount."
        help="Amounts are net USDC entitlements. Recipients receive their preferred supported asset, with an approved USDC backup where consented. Company routing fees remain separate."
      >
        <form
          id="payroll-compose"
          className="scroll-mt-8 grid gap-5"
          onSubmit={(event) => {
            event.preventDefault();
            const form = event.currentTarget,
              values = new FormData(form);
            void run("create", async () => {
              const selected = Object.entries(items).filter(
                ([, value]) => value,
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
              setReviewRunId(result.run.id);
              form.reset();
              refresh();
            });
          }}
        >
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Pay-run reference">
              <input
                name="reference"
                className={control}
                required
                placeholder="November payroll"
                maxLength={120}
              />
            </Field>
            <Field label="Period start">
              <input name="start" type="date" className={control} required />
            </Field>
            <Field label="Period end">
              <input name="end" type="date" className={control} required />
            </Field>
            <Field label="Scheduled payment" hint={organization.timezone}>
              <input
                name="scheduled"
                type="datetime-local"
                className={control}
              />
            </Field>
          </div>
          {!recipients.length ? (
            <Empty>Add employees or contractors to prepare payroll.</Empty>
          ) : (
            <DataTable
              columns={["Payee", "Relationship", "Primary network", "Net USDC"]}
            >
              {recipients.map((recipient) => (
                <tr key={recipient.id}>
                  <td className="font-medium">{recipient.name}</td>
                  <td className="capitalize">{recipient.kind}</td>
                  <td>{recipient.primary_network}</td>
                  <td>
                    <input
                      className={`${control} max-w-40`}
                      aria-label={`Amount for ${recipient.name}`}
                      inputMode="decimal"
                      placeholder="0.00"
                      value={items[recipient.id] ?? ""}
                      readOnly={importedRows[recipient.id]?.baseAmount !== undefined}
                      title={importedRows[recipient.id]?.baseAmount !== undefined ? "Imported components stay together. Save the draft, then adjust its base, bonus or correction in the review." : undefined}
                      onChange={(event) => {
                        setImportSelection(null);
                        setItems(previous => ({ ...previous, [recipient.id]: event.target.value }));
                        setImportedRows(previous => previous[recipient.id] ? { ...previous, [recipient.id]: { ...previous[recipient.id], amount: event.target.value } } : previous);
                      }}
                    />
                    {importedRows[recipient.id]?.baseAmount !== undefined && <p className="mt-1 max-w-56 text-xs text-muted-foreground">Imported base, bonus and correction are preserved. Edit their amounts in the saved run review.</p>}
                  </td>
                </tr>
              ))}
            </DataTable>
          )}
          <div className="flex flex-wrap items-end gap-4">
            <div className="w-56">
              <Field label="Manual default cost cap (USDC)" hint={importSelection ? "Reviewed import row caps apply to this run." : undefined}>
                <input
                  name="fee"
                  className={control}
                  defaultValue="1.00"
                  required
                  inputMode="decimal"
                />
              </Field>
            </div>
            <Action busy={busy === "create"} disabled={!recipients.length}>
              Save pay run
            </Action>
            <label className="cursor-pointer text-sm text-primary">
              Import amounts from CSV
              <input
                type="file"
                accept=".csv,text/csv"
                className="sr-only"
                onChange={async (event) => {
                  const file = event.target.files?.[0];
                  if (!file) return;
                  const { parsePayrollDetailsCsv } = await import("@/lib/csv");
                  try {
                    const parsed = parsePayrollDetailsCsv(
                      await file.text(),
                      recipients,
                    );
                    setItems(Object.fromEntries(Object.entries(parsed).map(([recipientId, item]) => [recipientId, item.amount])));
                    setImportedRows(parsed);
                    setImportSelection(null);
                    setError("");
                  } catch (cause) {
                    setError((cause as Error).message);
                  }
                  event.target.value = "";
                }}
              />
            </label>
          </div>
          <details className="text-xs text-muted-foreground"><summary className="cursor-pointer font-medium">CSV format and adjustments</summary><p className="mt-3 leading-5">
            CSV columns: recipient_id or email, amount (net USDC). Optional: base_amount, bonus_amount, adjustment_amount, note and max_fee. A bonus or correction needs base_amount and a note; an amount column must match their net total. Fill the pay period above after import.
          </p></details>
        </form>
        {error && (
          <p role="alert" className="mt-4 text-sm text-destructive">
            {error}
          </p>
        )}
      </Panel>}
      {canPrepare && <Panel title="Import payroll" description="Bring a pay run from a CSV file." collapsible><PayrollImport onUse={(rows, selection) => { setImportedRows(rows); setItems(Object.fromEntries(Object.entries(rows).map(([id, value]) => [id, value.amount]))); setImportSelection(selection); }} onInvalidated={() => { if (importSelection) { setImportedRows({}); setItems({}); setImportSelection(null); } }} onOpenRun={setReviewRunId} /></Panel>}
      {reviewRunId && (
        <PaymentManagementPanel mode="payroll" initialRunId={reviewRunId} />
      )}
      {executionRunId && <PayrollExecution key={executionRunId} runId={executionRunId} onReview={() => setReviewRunId(executionRunId)} />}

    </div>
  );
}
