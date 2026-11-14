"use client";

import { useState } from "react";
import { api } from "@/lib/api";
import { usdcInput, usd } from "@/lib/format";
import type { companyExpense, listCompanyExpenses } from "@/server/expenses/service";
import { useWorkspace } from "./context";
import { useAction, useResource } from "./hooks";
import { Action, control, DataTable, Empty, Field, Panel, Status } from "./shared";

type Overview = ReturnType<typeof listCompanyExpenses>;
type Detail = ReturnType<typeof companyExpense>;

export function ExpensesPanel() {
  const { base, organization, revision, refresh, navigate } = useWorkspace();
  const allowed = ["payments:read", "documents:manage"].every(value => organization.permissions?.includes(value));
  const prepare = !!organization.permissions?.includes("payments:prepare"), manage = !!organization.permissions?.includes("company:manage");
  const [page, setPage] = useState(1), [selected, setSelected] = useState(""), [notice, setNotice] = useState("");
  const overview = useResource<Overview>(allowed ? `${base}/expenses?page=${page}` : null, revision);
  const detail = useResource<{ expense: Detail }>(allowed && selected ? `${base}/expenses/${selected}` : null, revision);
  const { busy, error, run } = useAction(), data = overview.data, current = detail.data?.expense;
  if (!allowed) return null;
  return <Panel title="Staff expenses and reimbursements" description="Review private receipts and explicitly requested USDC amounts. Accepting an expense prepares a bill draft; ordinary payment approvals and funding still apply.">
    <div className="grid min-w-0 grid-cols-1 gap-5">
      <p className="text-xs leading-5 text-muted-foreground">Receipts share the company file inbox's encrypted storage, retention and processing limits. Staff see their own requests. Company document managers with payment-read access can review receipts. Receipt amounts never create automatic FX or payment authority.</p>
      {manage && data && <details className="min-w-0 rounded-lg border p-4"><summary className="cursor-pointer text-sm font-medium">Company expense policy</summary><form key={data.policy.version} className="mt-4 grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-2" onSubmit={event => {
        event.preventDefault(); const values = new FormData(event.currentTarget);
        void run("policy", async () => {
          await api(`${base}/expenses/policy`, { expectedVersion: data.policy.version, enabled: values.get("enabled") === "on", perExpenseLimitUSDC: String(values.get("perExpense")).trim() || null, monthlyPersonLimitUSDC: String(values.get("monthly")).trim() || null, requireCostCenter: values.get("requireCenter") === "on", costCenters: String(values.get("centers")).split("\n").map(value => value.trim()).filter(Boolean) }, "PUT");
          setNotice("Expense policy saved. Existing paid liabilities remain unchanged; unaccepted requests are checked against this version."); refresh();
        });
      }}>
        <Field label="Maximum per expense (USDC, optional)"><input name="perExpense" inputMode="decimal" className={control} defaultValue={data.policy.perExpenseLimit ? usdcInput(data.policy.perExpenseLimit) : ""} /></Field>
        <Field label="Maximum per person per UTC month (USDC, optional)"><input name="monthly" inputMode="decimal" className={control} defaultValue={data.policy.monthlyPersonLimit ? usdcInput(data.policy.monthlyPersonLimit) : ""} /></Field>
        <div className="sm:col-span-2"><Field label="Permitted cost centres, one per line" hint="An empty list permits any supplied cost centre. Existing history keeps the originally reviewed value."><textarea name="centers" rows={3} className={control} defaultValue={data.policy.costCenters.join("\n")} /></Field></div>
        <label className="flex items-start gap-2 text-sm"><input name="enabled" type="checkbox" defaultChecked={data.policy.enabled} />Allow submissions and acceptance</label>
        <label className="flex items-start gap-2 text-sm"><input name="requireCenter" type="checkbox" defaultChecked={data.policy.requireCostCenter} />Require a cost centre</label>
        <p className="text-xs text-muted-foreground sm:col-span-2">Version {data.policy.version}. {data.policy.timeBasis}. Submitted, returned and accepted requests consume the allowance; rejected/cancelled unaccepted requests do not. This is an application review policy, separate from treasury funds and onchain spending limits.</p>
        <div><Action disabled={!!busy} busy={busy === "policy"}>Save expense policy</Action></div>
      </form></details>}
      {overview.loading ? <Empty>Loading company expenses...</Empty> : !data?.expenses.length ? <Empty>Confirmed employees and contractors can submit receipts from their personal payment workspace.</Empty> : <DataTable columns={["Staff / receipt", "Requested", "Review", "Reimbursement", "Action"]}>{data.expenses.map(expense => <tr key={expense.id}>
        <td><p>{expense.submitterName}</p><p className="text-xs">{expense.fields.merchant} · {expense.fields.receiptReference}</p><p className="text-xs text-muted-foreground">{expense.fields.expenseDate} · {expense.fields.costCenter || "No cost centre"}</p></td>
        <td>{usd(expense.amount)} USDC</td><td><Status value={expense.supersededBy ? "superseded" : expense.status} /></td>
        <td>{expense.reimbursement ? <><Status value={expense.reimbursement.status} /><p className="text-xs">Delivered {usd(expense.reimbursement.deliveredAmount)} · remaining {usd(expense.reimbursement.remainingLiability)}</p></> : <span className="text-xs text-muted-foreground">No reimbursement bill</span>}</td>
        <td><button type="button" className="text-sm text-primary" onClick={() => { setSelected(expense.id); setNotice(""); }}>Inspect expense</button></td>
      </tr>)}</DataTable>}
      {data && data.total > 0 && <div className="flex items-center justify-between gap-3"><Action type="button" disabled={page <= 1 || overview.refreshing} onClick={() => setPage(value => value - 1)}>Previous expenses</Action><span className="text-xs">Page {page} · {data.total} requests</span><Action type="button" disabled={!data.hasMore || overview.refreshing} onClick={() => setPage(value => value + 1)}>Next expenses</Action></div>}
      {detail.loading && <Empty>Loading the receipt and review history...</Empty>}
      {current && <div className="grid min-w-0 grid-cols-1 gap-4 rounded-lg border p-4">
        <h3 className="font-medium">{current.submitterName}: {current.fields.merchant}</h3>
        <p className="text-sm">{usdcInput(current.amount)} USDC requested · {current.fields.expenseDate} · receipt {current.fields.receiptReference}</p>
        <p className="whitespace-pre-wrap break-words text-sm">Purpose: {current.fields.purpose}</p><p className="text-sm">Cost centre: {current.fields.costCenter || "Not supplied"}. Receiving profile version {current.recipientVersion}.</p>
        <p className="text-xs text-muted-foreground">Uploaded {new Date(current.submittedAt).toLocaleString()} · original UTC allowance month {current.policyMonth}.{current.replacesExpenseId ? " This is a linked corrected request." : ""}{current.supersededBy ? " Superseded by its successor; this original cannot create another reimbursement." : ""}</p>
        {current.receipt ? <><a className="w-fit text-sm text-primary" href={`/api${base}/expenses/${current.id}/original`} download>Download private receipt</a><p className="text-xs text-muted-foreground">{current.receipt.filename} · retained until {new Date(current.receipt.expiresAt).toLocaleString()}. {current.receipt.error?.message}</p>{current.receipt.text && <Field label="Extracted receipt text for human review"><textarea className={control} readOnly rows={5} value={current.receipt.text} /></Field>}</> : <p className="text-sm text-amber-900">The original receipt was deleted, expired or could not be retained. It cannot be accepted without a retained receipt. Request a corrected submission or reject it.</p>}
        {current.reimbursement && <div className="grid gap-2 text-sm"><p>Delivered {usd(current.reimbursement.deliveredAmount)} · noncash setoff {usd(current.reimbursement.setoffAmount)} · remaining liability {usd(current.reimbursement.remainingLiability)}.</p>{current.reimbursement.needsReview && <p className="text-amber-900">The linked bill has changed, cancelled payments or noncash setoff. Review its original installments and recovery before another payment. This request cannot create a second reimbursement.</p>}<button type="button" className="w-fit text-primary" onClick={() => navigate("bills")}>Open bills for payment approvals and recovery</button></div>}
        {prepare && ["submitted", "returned"].includes(current.status) && <form key={`${current.id}:${current.version}`} className="grid min-w-0 grid-cols-1 gap-4 rounded-lg border p-4 sm:grid-cols-2" onSubmit={event => {
          event.preventDefault(); const values = new FormData(event.currentTarget);
          void run("review", async () => { await api(`${base}/expenses/${current.id}/review`, { reviewToken: current.reviewToken, decision: values.get("decision"), note: values.get("note"), maxFeeUSDC: values.get("fee"), confirmed: true }); setNotice("Expense review saved. Any prepared reimbursement remains a bill draft requiring normal payment approval."); refresh(); });
        }}>
          <Field label="Review decision"><select name="decision" className={control}><option value="accept" disabled={!current.receipt}>Accept and prepare bill draft</option><option value="return">Return for staff correction</option><option value="reject">Reject request</option></select></Field>
          <Field label="Maximum routing cost (USDC)"><input name="fee" inputMode="decimal" className={control} defaultValue="1" required /></Field>
          <div className="sm:col-span-2"><Field label="Decision note shared with the staff member"><textarea name="note" className={control} minLength={3} maxLength={2000} required rows={2} /></Field></div>
          <label className="flex items-start gap-2 text-sm sm:col-span-2"><input type="checkbox" required />I reviewed the receipt, requested USDC amount, staff profile and current company policy. Acceptance prepares a draft and does not send money.</label>
          <div><Action disabled={!!busy || detail.refreshing} busy={busy === "review"}>Save expense review</Action></div>
        </form>}
        <details><summary className="cursor-pointer text-sm font-medium">Submission and decision history</summary><div className="mt-3 grid gap-3">{current.events.map((item, index) => <div key={`${item.at}:${index}`} className="rounded border p-3 text-xs"><p>{item.decision} · {new Date(item.at).toLocaleString()}</p><p className="mt-1 whitespace-pre-wrap break-words">{item.note}</p></div>)}{current.history.map(item => <div key={item.version} className="rounded border p-3 text-xs"><p>Requested version {item.version} · {usd(item.amount)} USDC</p><p className="mt-1 whitespace-pre-wrap break-words">{item.fields.purpose}</p></div>)}</div></details>
      </div>}
      {notice && <p role="status" className="text-sm">{notice}</p>}
      {(error || overview.error || detail.error) && <p role="alert" className="text-sm text-destructive">{error || overview.error || detail.error}</p>}
    </div>
  </Panel>;
}
