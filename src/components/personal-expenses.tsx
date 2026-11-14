"use client";

import { useState } from "react";
import { api, RequestError } from "@/lib/api";
import { usdcInput, usd } from "@/lib/format";
import type { personalExpenseOverview } from "@/server/expenses/service";
import { useAction, useResource } from "./workspace/hooks";
import { Action, control, Empty, Field, Panel, Status } from "./workspace/shared";

type Overview = ReturnType<typeof personalExpenseOverview>;
type Expense = Overview["expenses"][number];
function fields(form: FormData, replacesExpenseId?: string | null) {
  return { merchant: String(form.get("merchant")), receiptReference: String(form.get("reference")), expenseDate: String(form.get("date")), amountUSDC: String(form.get("amount")), purpose: String(form.get("purpose")), costCenter: String(form.get("center") ?? ""), ...(replacesExpenseId ? { replacesExpenseId } : {}) };
}
function ExpenseFields({ value }: { value?: Expense }) {
  return <><Field label="Merchant"><input name="merchant" className={control} required maxLength={160} defaultValue={value?.fields.merchant} /></Field><Field label="Receipt number or reference"><input name="reference" className={control} required maxLength={120} defaultValue={value?.fields.receiptReference} /></Field><Field label="Receipt date"><input name="date" type="date" className={control} required defaultValue={value?.fields.expenseDate ?? new Date().toISOString().slice(0, 10)} /></Field><Field label="Requested reimbursement (USDC)" hint="Explicitly agree this amount. Receipt currencies are never converted automatically."><input name="amount" className={control} required inputMode="decimal" defaultValue={value?.fields.amountUSDC} /></Field><Field label="Cost centre"><input name="center" className={control} maxLength={120} defaultValue={value?.fields.costCenter} /></Field><div className="sm:col-span-2"><Field label="Business purpose"><textarea name="purpose" className={control} required minLength={3} maxLength={2000} rows={2} defaultValue={value?.fields.purpose} /></Field></div></>;
}

export function PersonalExpenses() {
  const [revision, setRevision] = useState(0), [page, setPage] = useState(1), [requestKey, setRequestKey] = useState("");
  const resource = useResource<Overview>(`/personal-expenses?page=${page}`, revision), { busy, error, run } = useAction();
  const [notice, setNotice] = useState("");
  const refresh = () => setRevision(value => value + 1), data = resource.data;
  return <Panel title="My expense receipts" description="Submit your own business receipts to a payer with a confirmed employee or contractor profile. You can see only your own expense requests and reimbursement history.">
    <div className="grid min-w-0 grid-cols-1 gap-5">
      {data?.profiles.length ? <details className="min-w-0 rounded-lg border p-4"><summary className="cursor-pointer text-sm font-medium">Submit a private expense receipt</summary><form className="mt-4 grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-2" onChange={() => setRequestKey(crypto.randomUUID())} onSubmit={event => {
        event.preventDefault(); const form = event.currentTarget, values = new FormData(form), receipt = values.get("receipt"), recipientId = String(values.get("profile"));
        void run("upload", async () => {
          if (!(receipt instanceof File) || !receipt.size || receipt.size > 3 * 1024 * 1024) throw new Error("Choose a PDF, PNG or JPEG receipt up to 3 MB");
          const body = new FormData(); body.set("file", receipt); body.set("fields", JSON.stringify(fields(values)));
          const response = await fetch(`/api/personal-expenses/profiles/${encodeURIComponent(recipientId)}/upload`, { method: "POST", credentials: "same-origin", headers: { "X-Expense-Request-Key": requestKey || crypto.randomUUID() }, body });
          let result: { error?: string; code?: string };
          try { result = await response.json(); } catch { throw new Error("The upload response was interrupted. Refresh your expense history before retrying the same file."); }
          if (!response.ok) throw new RequestError(result.error ?? "The receipt could not be submitted", response.status, result.code ?? "EXPENSE_UPLOAD_FAILED");
          form.reset(); setRequestKey(crypto.randomUUID()); setNotice("Receipt submitted for company review. It has no approval or payment authority."); refresh();
        });
      }}><fieldset disabled={!!busy} className="contents">
        <div className="sm:col-span-2"><Field label="Payer and confirmed receiving profile"><select name="profile" className={control} required><option value="">Choose your company profile</option>{data.profiles.map(profile => <option key={profile.id} value={profile.id}>{profile.companyName} · {profile.name}</option>)}</select></Field></div>
        <ExpenseFields />
        <div className="sm:col-span-2"><Field label="Private receipt (PDF, PNG or JPEG, up to 3 MB)"><input name="receipt" type="file" accept="application/pdf,image/png,image/jpeg" required className={`${control} h-auto`} /></Field></div>
        <label className="flex items-start gap-2 text-sm sm:col-span-2"><input type="checkbox" required />I supplied the requested USDC amount and checked this receipt and purpose. The payer must review it before any payment.</label>
        <p className="text-xs text-muted-foreground sm:col-span-2">Razor receives plaintext and retains encrypted originals under the company's document policy. Company document managers with payment access can inspect receipts. No AI processing runs automatically. Receipts use the same file-type, page, image, memory and retention limits as company invoice uploads.</p>
        <div><Action busy={busy === "upload"}>Submit expense for review</Action></div>
      </fieldset></form><details className="mt-4"><summary className="cursor-pointer text-xs">Current company expense policies</summary><div className="mt-3 grid gap-3">{data.profiles.map(profile => <p key={profile.id} className="text-xs">{profile.companyName}: {profile.policy.enabled ? "Submissions enabled" : "Paused"}; per expense {profile.policy.perExpenseLimit ? usd(profile.policy.perExpenseLimit) : "no configured cap"}; per person per UTC submission month {profile.policy.monthlyPersonLimit ? usd(profile.policy.monthlyPersonLimit) : "no configured cap"}. Cost centre {profile.policy.requireCostCenter ? "required" : "optional"}{profile.policy.costCenters.length ? `: ${profile.policy.costCenters.join(", ")}` : "."}</p>)}</div></details></details> : data && <Empty>Ask your payer to confirm an active employee or contractor receiving profile before submitting a new expense. Your retained history remains available below.</Empty>}
      <Action type="button" disabled={!!busy || resource.refreshing} onClick={refresh}>Refresh my expenses</Action>
      {resource.loading ? <Empty>Loading your expense requests...</Empty> : !data?.expenses.length ? <Empty>No expense receipts submitted yet.</Empty> : data.expenses.map(expense => <article key={expense.id} className="grid min-w-0 grid-cols-1 gap-3 rounded-lg border p-4">
        <div className="flex flex-wrap items-center justify-between gap-3"><h3 className="font-medium">{expense.fields.merchant} · {usdcInput(expense.amount)} USDC</h3><Status value={expense.status} /></div>
        <p className="text-xs text-muted-foreground">{expense.companyName} · {expense.fields.receiptReference} · {expense.fields.expenseDate}</p><p className="whitespace-pre-wrap break-words text-sm">{expense.fields.purpose}</p>
        {expense.review && <p className="whitespace-pre-wrap break-words rounded bg-muted p-3 text-sm">Company review: {expense.review.note}</p>}
        {expense.receipt ? <a className="w-fit text-sm text-primary" href={`/api/personal-expenses/${expense.id}/original`} download>Download my retained receipt</a> : <p className="text-xs text-muted-foreground">The original receipt was deleted, expired or not retained. Financial and decision history remain available.</p>}
        {expense.reimbursement && <div className="grid gap-2 text-sm"><Status value={expense.reimbursement.status} /><p>Delivered {usd(expense.reimbursement.deliveredAmount)} · noncash setoff {usd(expense.reimbursement.setoffAmount)} · still owed {usd(expense.reimbursement.remainingLiability)}.</p>{expense.reimbursement.needsReview && <p className="text-amber-900">The linked reimbursement needs company review. Cancelled or partial payments do not create another full expense claim.</p>}</div>}
        {!expense.billId && ["submitted", "returned", "receipt_failed"].includes(expense.status) && <div><Action type="button" disabled={!!busy} onClick={() => void run(`cancel:${expense.id}`, async () => { await api(`/personal-expenses/${expense.id}/cancel`, { expectedVersion: expense.version }); refresh(); })}>Cancel unaccepted request</Action></div>}
        {!expense.billId && expense.receipt && data.profiles.some(profile => profile.id === expense.recipientId) && ["returned", "rejected", "cancelled", "receipt_failed"].includes(expense.status) && <details className="min-w-0"><summary className="cursor-pointer text-sm text-primary">Revise and resubmit the same request</summary><form key={expense.version} className="mt-4 grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-2" onSubmit={event => {
          event.preventDefault(); const values = new FormData(event.currentTarget);
          void run(`correct:${expense.id}`, async () => { await api(`/personal-expenses/${expense.id}/correction`, { ...fields(values, expense.replacesExpenseId), expectedVersion: expense.version }, "PUT"); setNotice("The same expense request was revised and returned to company review. Its original receipt and earlier decisions remain linked."); refresh(); });
        }}><ExpenseFields value={expense} /><div><Action disabled={!!busy} busy={busy === `correct:${expense.id}`}>Resubmit corrected request</Action></div></form></details>}
        {expense.events.length > 0 && <details><summary className="cursor-pointer text-xs">My submission and decision history</summary><div className="mt-3 grid gap-3">{expense.events.map((item, index) => <p key={`${item.at}:${index}`} className="whitespace-pre-wrap break-words text-xs">{item.decision} · {new Date(item.at).toLocaleString()}: {item.note}</p>)}</div></details>}
      </article>)}
      {data && data.total > 0 && <div className="flex items-center justify-between gap-3"><Action type="button" disabled={page <= 1 || resource.refreshing} onClick={() => setPage(value => value - 1)}>Previous requests</Action><span className="text-xs">Page {page} · {data.total} requests</span><Action type="button" disabled={!data.hasMore || resource.refreshing} onClick={() => setPage(value => value + 1)}>Next requests</Action></div>}
      {notice && <p role="status" className="text-sm">{notice}</p>}{(error || resource.error) && <p role="alert" className="text-sm text-destructive">{error || resource.error}</p>}
    </div>
  </Panel>;
}
