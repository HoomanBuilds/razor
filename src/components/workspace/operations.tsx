"use client";

import { useEffect, useState } from "react";
import { Bell, Check, ChevronDown, Clock3, Plus, RefreshCw, Settings2, Wallet } from "lucide-react";
import { formatInTimeZone } from "date-fns-tz";
import { companyTimeToIso } from "@/lib/company-time";
import { api, RequestError } from "@/lib/api";
import { dateLabel, microUsd, usdcInput, usd } from "@/lib/format";
import { signNearActions, type NearWalletAction } from "@/lib/near-actions";
import type {
  AgentMandate,
  Notice,
  RecurringRuleView,
} from "@/server/operations/types";
import { TaskDrawer, closeTaskDrawer, openTaskDrawer } from "./task-drawer";
import { focusWorkspaceForm } from "./page-metrics";
import { StandingMandatesPanel } from "./standing-mandates";
import { useWorkspace } from "./context";
import { useAction, useResource } from "./hooks";
import {
  Action,
  Address,
  control,
  Empty,
  Field,
  Status,
} from "./shared";

interface Overview {
  paused: boolean;
  canManage: boolean;
  canManageMandate: boolean;
  unread: number;
  worker: {
    configured: boolean;
    accountId: string | null;
    network: string | null;
    treasuryAccountId: string | null;
  };
  jobs: {
    id: string;
    kind: string;
    status: string;
    run_at: string;
    last_error: string | null;
    result: string | null;
  }[];
  recurring: RecurringRuleView[];
  notices: Notice[];
  mandate: AgentMandate | null;
  templates: {
    bills: { id: string; reference: string; amount: string }[];
    payroll: { id: string; reference: string }[];
  };
}

interface PageInfo { page: number; pageSize: number; total: number; hasMore: boolean }

function PageControls({ value, loading, label, change }: { value: PageInfo | null; loading: boolean; label: string; change: (page: number) => void }) {
  if (!value || value.total <= value.pageSize) return null;
  return <nav aria-label={label} className="mt-4 flex flex-wrap items-center gap-3 text-sm"><p className="mr-auto text-xs text-muted-foreground">{value.total ? (value.page - 1) * value.pageSize + 1 : 0}-{Math.min(value.page * value.pageSize, value.total)} of {value.total}</p><button type="button" className="min-h-10 rounded-full px-3 text-primary disabled:opacity-50" disabled={loading || value.page <= 1} onClick={()=>change(value.page - 1)}>Previous</button><span>Page {value.page}</span><button type="button" className="min-h-10 rounded-full px-3 text-primary disabled:opacity-50" disabled={loading || !value.hasMore} onClick={()=>change(value.page + 1)}>Next</button></nav>;
}

function amount(value: FormDataEntryValue | null) {
  try {
    return microUsd(String(value));
  } catch (error) {
    throw new RequestError((error as Error).message, 422, "INVALID_AMOUNT");
  }
}

const secondary = "border bg-white text-foreground hover:bg-muted";
const jobNames: Record<string, string> = {
  recurring: "Create recurring draft",
  due_payment: "Review due payment",
  reconcile_payment: "Check payment delivery",
  reconcile_funding: "Verify incoming funds",
  execute_approved: "Execute approved payment",
  purge_assistant: "Clean up expired private drafts",
};

export function OperationsPanel() {
  const { base } = useWorkspace();
  return <OperationsWorkspace key={base} />;
}

function OperationsWorkspace() {
  const { base, organization, revision, refresh, navigate, notify } = useWorkspace();
  const canRead = !!organization.permissions?.includes("payments:read");
  const canPrepare = !!organization.permissions?.includes("payments:prepare");
  const canPurge = !!organization.permissions?.includes("documents:manage");
  const resource = useResource<Overview>(canRead ? `${base}/operations/overview` : null, revision);
  const { busy, error, run, setError } = useAction();
  const [view, setView] = useState<"inbox" | "work" | "recurring">("inbox");
  const [kind, setKind] = useState<"bill" | "payroll">("bill");
  const [cadence, setCadence] = useState<"days" | "months">("months");
  const [jobsPage, setJobsPage] = useState(1), [rulesPage, setRulesPage] = useState(1), [noticesPage, setNoticesPage] = useState(1), [sourcesPage, setSourcesPage] = useState(1);
  const [jobStatus, setJobStatus] = useState<"all" | "attention" | "pending" | "completed">("attention");
  const [ruleStatus, setRuleStatus] = useState<"all" | "active" | "paused" | "held">("all");
  const [noticeStatus, setNoticeStatus] = useState<"all" | "unread">("unread");
  const jobs = useResource<PageInfo & { jobs: Overview["jobs"] }>(canRead ? `${base}/operations/jobs?page=${jobsPage}&pageSize=25&status=${jobStatus}` : null, revision);
  const rules = useResource<PageInfo & { recurring: RecurringRuleView[] }>(canRead ? `${base}/operations/recurring?page=${rulesPage}&pageSize=25&status=${ruleStatus}` : null, revision);
  const notices = useResource<PageInfo & { notices: Notice[] }>(canRead ? `${base}/operations/notices?page=${noticesPage}&pageSize=25&status=${noticeStatus}` : null, revision);
  const sources = useResource<PageInfo & { templates: { id: string; reference: string }[] }>(canRead && canPrepare && resource.data?.canManage ? `${base}/operations/templates?kind=${kind}&page=${sourcesPage}&pageSize=25` : null, revision);
  const data = resource.data;
  const openPayments = (paymentId?: string) => { navigate("payments", paymentId); focusWorkspaceForm("payment-queue"); };
  useEffect(() => {
    const clamp = (value: PageInfo | null, current: number, update: (page: number) => void) => {
      if (value && current > Math.max(1, Math.ceil(value.total / value.pageSize))) update(Math.max(1, Math.ceil(value.total / value.pageSize)));
    };
    clamp(jobs.data, jobsPage, setJobsPage);
    clamp(rules.data, rulesPage, setRulesPage);
    clamp(notices.data, noticesPage, setNoticesPage);
    clamp(sources.data, sourcesPage, setSourcesPage);
  }, [jobs.data, jobsPage, rules.data, rulesPage, notices.data, noticesPage, sources.data, sourcesPage]);
  if (!canRead) return null;
  return <div className="grid min-w-0 gap-6" aria-busy={!!busy}>
    <header className="flex flex-wrap items-start justify-between gap-4 px-1">
      <div><h2 className="text-xl font-medium tracking-tight">Company operations</h2><p className="mt-1.5 text-sm text-muted-foreground">Keep recurring drafts and payment checks moving.</p></div>
      {data?.canManage && <Action disabled={!!busy} busy={busy === "tick"} onClick={() => void run("tick", async () => {
        const result = await api<{ processed: number }>(`${base}/operations/tick`, {});
        notify(`Checked ${result.processed} operations jobs.`); refresh();
      })}><RefreshCw size={15} aria-hidden="true" />{busy === "tick" ? "Checking due work..." : "Check due work"}</Action>}
    </header>
    {(resource.error || error) && <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-destructive/20 bg-red-50/40 p-4 text-sm text-destructive"><p>{error || resource.error}</p>{resource.error && <button type="button" className="min-h-10 font-medium underline underline-offset-4" disabled={!!busy} onClick={refresh}>Try again</button>}</div>}
    {resource.loading && <Empty>Loading company operations...</Empty>}
    {data && <>
      <div className="grid divide-y rounded-3xl border bg-white sm:grid-cols-3 sm:divide-x sm:divide-y-0">
        <div className="p-5 sm:p-6"><p className="mb-3 text-xs text-muted-foreground">Company payments</p><Status value={data.paused ? "paused" : "active"} /></div>
        <div className="p-5 sm:p-6"><p className="mb-3 flex items-center gap-2 text-xs text-muted-foreground"><Wallet size={14} aria-hidden="true" />Execution</p><p className="text-sm font-medium">{data.worker.configured ? "Restricted executor configured" : "Owner wallet required"}</p></div>
        <div className="p-5 sm:p-6"><p className="mb-3 flex items-center gap-2 text-xs text-muted-foreground"><Bell size={14} aria-hidden="true" />Unread notices</p><p className="text-xl font-medium tabular-nums">{data.unread}</p></div>
      </div>
      <p className="-mt-2 px-1 text-xs leading-5 text-muted-foreground">Recurring cycles create drafts for approval. Pausing stops new execution; delivery checks continue.</p>
      <section className="min-w-0 overflow-hidden rounded-3xl border bg-white">
        <div className="flex flex-wrap gap-1 border-b px-3 pt-3 sm:px-5" role="group" aria-label="Operations views">
          {([['inbox', 'Inbox'], ['work', 'Work queue'], ['recurring', 'Recurring drafts']] as const).map(([key, label]) => <button key={key} type="button" aria-pressed={view === key} aria-controls={`operations-${key}`} disabled={!!busy} onClick={() => setView(key)} className={`min-h-12 border-b-2 px-3 text-sm font-medium transition-colors disabled:opacity-50 ${view === key ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-foreground"}`}>{label}{key === "inbox" && data.unread > 0 && <span className="ml-2 rounded-full bg-muted px-2 py-0.5 text-[11px] text-foreground">{data.unread}</span>}</button>)}
        </div>
        <div id="operations-inbox" hidden={view !== "inbox"} className="p-5 sm:p-6">
          <div className="mb-5 flex flex-wrap items-start justify-between gap-4"><div><h3 className="text-base font-medium">Operations inbox</h3><p className="mt-1.5 text-xs leading-5 text-muted-foreground">Reading a notice marks it read only for you.</p></div><label className="w-full sm:w-44"><span className="sr-only">Notice status</span><select className={control} value={noticeStatus} disabled={!!busy} onChange={event => { setNoticeStatus(event.target.value as typeof noticeStatus); setNoticesPage(1); }}><option value="unread">Unread notices</option><option value="all">All notices</option></select></label></div>
          {notices.error && <div role="alert" className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl bg-red-50/40 p-4 text-sm text-destructive"><div><p>{notices.error}</p>{notices.data && <p className="mt-1 text-xs">Previous results are shown. Retry to load current records.</p>}</div><button type="button" className="min-h-10 underline underline-offset-4" disabled={!!busy} onClick={refresh}>Try again</button></div>}
          {notices.loading ? <Empty>Loading notices...</Empty> : notices.error && !notices.data ? <Empty>Notices unavailable. Retry to load your records.</Empty> : !notices.data?.notices.length ? <Empty>{noticeStatus === "unread" ? "You're caught up. Choose All notices to see earlier updates." : "Payment updates and recurring draft notices will appear here."}</Empty> : <div className="divide-y">{notices.data.notices.map(notice => <article key={notice.id} className="flex gap-3 py-5 first:pt-0 last:pb-0 sm:gap-4">
            <span className={`mt-1 grid size-8 shrink-0 place-items-center rounded-full ${notice.read_at ? "bg-muted text-muted-foreground" : "bg-secondary text-primary"}`}><Bell size={15} aria-hidden="true" /></span>
            <div className="min-w-0 flex-1"><div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1"><h4 className={`text-sm ${notice.read_at ? "text-muted-foreground" : "font-medium"}`}>{notice.title}</h4><time className="text-xs text-muted-foreground" dateTime={notice.created_at}>{dateLabel(notice.created_at, organization.timezone)}</time></div>
              {notice.payment && <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm"><span className="font-medium">{notice.payment.recipientName}</span><span className="text-muted-foreground">{notice.payment.reference}</span><span className="tabular-nums">{usd(notice.payment.amount)} USDC</span></div>}{!notice.payment && <p className="mt-2 max-w-2xl break-words text-xs leading-5 text-muted-foreground">{notice.body}</p>}
              <div className="mt-3 flex flex-wrap items-center gap-2"><button type="button" className="min-h-9 rounded-full pr-3 text-xs font-medium text-primary" onClick={() => openPayments(notice.payment && notice.entity_id ? notice.entity_id : undefined)}>{notice.payment ? "Open payment" : "Open payment queue"}</button>{!notice.read_at && <Action className={`${secondary} px-3 text-xs`} disabled={!!busy} busy={busy === notice.id} onClick={() => void run(notice.id, async () => { await api(`${base}/operations/notices/${notice.id}/read`, {}); refresh(); })}><Check size={13} aria-hidden="true" />Mark read</Action>}{notice.entity_id && <details className="text-xs text-muted-foreground"><summary className="cursor-pointer py-2">Notice details</summary><div className="space-y-3 py-2">{notice.payment && <p className="max-w-2xl break-words leading-5">{notice.body}</p>}<input aria-label="Notice record ID" className={`${control} font-mono text-xs`} readOnly value={notice.entity_id} onFocus={event => event.currentTarget.select()} /></div></details>}</div>
            </div>
          </article>)}</div>}
          <PageControls value={notices.data} loading={notices.loading || !!busy} label="Operations notices" change={setNoticesPage} />
        </div>
        <div id="operations-work" hidden={view !== "work"} className="p-5 sm:p-6">
          <div className="mb-5 flex flex-wrap items-start justify-between gap-4"><div><h3 className="text-base font-medium">Work queue</h3><p className="mt-1.5 text-xs leading-5 text-muted-foreground">Review blocked work, then requeue it after resolving the cause.</p></div><label className="w-full sm:w-48"><span className="sr-only">Work status</span><select className={control} value={jobStatus} disabled={!!busy} onChange={event => { setJobStatus(event.target.value as typeof jobStatus); setJobsPage(1); }}><option value="attention">Needs attention</option><option value="pending">Queued or running</option><option value="completed">Completed work</option><option value="all">All work</option></select></label></div>
          {jobs.error && <div role="alert" className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl bg-red-50/40 p-4 text-sm text-destructive"><div><p>{jobs.error}</p>{jobs.data && <p className="mt-1 text-xs">Previous results are shown. Retry to load current records.</p>}</div><button type="button" className="min-h-10 underline underline-offset-4" disabled={!!busy} onClick={refresh}>Try again</button></div>}
          {jobs.loading ? <Empty>Loading work queue...</Empty> : jobs.error && !jobs.data ? <Empty>Work queue unavailable. Retry to load your records.</Empty> : !jobs.data?.jobs.length ? <Empty>{jobStatus === "attention" ? "No work needs attention. Check due work to refresh the queue." : "No work in this view. Check due work or choose another status."}</Empty> : <div className="divide-y">{jobs.data.jobs.map(job => {
            let detail: { reason?: string; mode?: string } | null = null;
            try { const parsed: unknown = job.result ? JSON.parse(job.result) : null; if (parsed && typeof parsed === "object") detail = parsed; } catch {}
            const reason = job.last_error || (typeof detail?.reason === "string" ? detail.reason : null);
            return <article key={job.id} className="py-5 first:pt-0 last:pb-0">
              <div className="flex flex-wrap items-start justify-between gap-3"><div className="min-w-0"><h4 className="text-sm font-medium">{jobNames[job.kind] ?? job.kind.replaceAll("_", " ")}</h4><p className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground"><Clock3 size={13} aria-hidden="true" />{job.status === "completed" ? "Work completed" : `Next check ${dateLabel(job.run_at, organization.timezone)}`}</p></div><Status value={job.status === "blocked" && detail?.mode === "manual" ? "awaiting_wallet" : job.status} /></div>
              {reason && <p className="mt-3 max-w-3xl break-words text-sm leading-6 text-muted-foreground">{reason}</p>}
              <div className="mt-3 flex flex-wrap items-center gap-3">{job.status === "blocked" && detail?.mode === "manual" && <button type="button" className="min-h-9 text-xs font-medium text-primary" onClick={() => openPayments()}>Review payment queue</button>}{data.canManage && ["blocked", "failed"].includes(job.status) && <Action className={`${secondary} text-xs`} disabled={!!busy} busy={busy === job.id} onClick={() => void run(job.id, async () => { await api(`${base}/operations/jobs/${job.id}/retry`, {}); refresh(); })}>Requeue work</Action>}<details className="min-w-0 text-xs text-muted-foreground"><summary className="cursor-pointer py-2">Job details</summary><div className="mt-2 space-y-3"><div><p className="mb-2">Job ID</p><input aria-label="Job ID" className={`${control} font-mono text-xs`} readOnly value={job.id} onFocus={event => event.currentTarget.select()} /></div>{job.result && <pre className="max-h-48 max-w-full overflow-auto whitespace-pre-wrap break-all rounded-xl bg-muted p-3">{job.result}</pre>}</div></details></div>
            </article>;
          })}</div>}
          <PageControls value={jobs.data} loading={jobs.loading || !!busy} label="Work queue" change={setJobsPage} />
        </div>
        <div id="operations-recurring" hidden={view !== "recurring"} className="p-5 sm:p-6">
          <div className="mb-5 flex flex-wrap items-start justify-between gap-4"><div><h3 className="text-base font-medium">Recurring drafts</h3><p className="mt-1.5 max-w-xl text-xs leading-5 text-muted-foreground">Repeat an approved bill or pay run. Changed terms hold the next cycle for review.</p></div>{data.canManage && canPrepare && <Action disabled={!!busy} onClick={() => { setError(""); openTaskDrawer("recurring-create-flow"); }}><Plus size={15} aria-hidden="true" />Create recurring draft</Action>}</div>
          <label className="mb-5 block w-full sm:w-48"><span className="sr-only">Template status</span><select className={control} value={ruleStatus} disabled={!!busy} onChange={event => { setRuleStatus(event.target.value as typeof ruleStatus); setRulesPage(1); }}><option value="all">All templates</option><option value="active">Active templates</option><option value="paused">Paused templates</option><option value="held">Needs review</option></select></label>
          {rules.error && <div role="alert" className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl bg-red-50/40 p-4 text-sm text-destructive"><div><p>{rules.error}</p>{rules.data && <p className="mt-1 text-xs">Previous results are shown. Retry to load current records.</p>}</div><button type="button" className="min-h-10 underline underline-offset-4" disabled={!!busy} onClick={refresh}>Try again</button></div>}
          {rules.loading ? <Empty>Loading recurring drafts...</Empty> : rules.error && !rules.data ? <Empty>Recurring drafts unavailable. Retry to load your records.</Empty> : !rules.data?.recurring.length ? <Empty>{ruleStatus === "all" ? "No recurring drafts yet. Start with an approved bill or pay run." : "No templates match this status."}</Empty> : <div className="divide-y">{rules.data.recurring.map(rule => <article key={rule.id} className="py-5 first:pt-0 last:pb-0">
            <div className="flex flex-wrap items-start justify-between gap-3"><div><h4 className="text-sm font-medium">{(rule.kind === "bill" ? data.templates.bills : data.templates.payroll).find(source => source.id === rule.entity_id)?.reference ?? (rule.kind === "bill" ? "Recurring bill" : "Recurring payroll")}</h4><p className="mt-1.5 text-xs text-muted-foreground">{rule.kind === "bill" ? "Bill" : "Pay run"} · {rule.cadence === "months" ? `Every ${rule.interval_months} month${rule.interval_months === 1 ? "" : "s"}${rule.month_end ? ", month end" : ""}` : `Every ${rule.interval_days} day${rule.interval_days === 1 ? "" : "s"}`}</p></div><Status value={rule.status} /></div>
            <dl className="mt-4 grid gap-4 sm:grid-cols-2"><div><dt className="text-xs text-muted-foreground">Next cycle</dt><dd className="mt-1 text-sm">{dateLabel(rule.next_run_at, organization.timezone)}</dd></div><div><dt className="text-xs text-muted-foreground">Cycle ceiling</dt><dd className="mt-1 text-sm tabular-nums">{usd(rule.max_amount ?? "0")} USDC</dd></div></dl>
            {rule.status === "held" && <p className="mt-3 text-xs leading-5 text-amber-900">Review the changed terms and create a new template before the next cycle.</p>}
            <div className="mt-4 flex flex-wrap items-center gap-4">{data.canManage && rule.status !== "held" && <Action className={`${secondary} text-xs`} disabled={!!busy || (!rule.enabled && !canPrepare)} busy={busy === rule.id} onClick={() => void run(rule.id, async () => { await api(`${base}/operations/recurring/${rule.id}`, { enabled: !rule.enabled }, "PATCH"); refresh(); })}>{rule.enabled ? "Pause template" : "Resume template"}</Action>}<details className="text-xs text-muted-foreground"><summary className="cursor-pointer py-2">Template details</summary><div className="mt-2 space-y-3"><div><p className="mb-2">Template ID</p><input aria-label="Template ID" className={`${control} font-mono text-xs`} readOnly value={rule.id} onFocus={event => event.currentTarget.select()} /></div><div><p className="mb-2">Approved source ID</p><input aria-label="Approved source ID" className={`${control} font-mono text-xs`} readOnly value={rule.entity_id} onFocus={event => event.currentTarget.select()} /></div></div></details></div>
          </article>)}</div>}
          <PageControls value={rules.data} loading={rules.loading || !!busy} label="Recurring templates" change={setRulesPage} />
        </div>
      </section>
      <details className="group rounded-3xl border bg-muted/30" onClick={event => { if ((event.target as HTMLElement).closest("summary")?.parentElement === event.currentTarget && event.currentTarget.open && event.currentTarget.querySelector('[aria-busy="true"]')) event.preventDefault(); }}>
        <summary className="flex cursor-pointer list-none items-center justify-between gap-4 p-5 after:hidden sm:p-6"><span className="flex items-center gap-3"><Settings2 size={18} className="text-muted-foreground" aria-hidden="true" /><span><span className="block text-sm font-medium">Execution and authority</span><span className="mt-1 block text-xs leading-5 text-muted-foreground">Executor limits, optional native autopay and retention.</span></span></span><ChevronDown size={18} className="shrink-0 text-muted-foreground group-open:rotate-180" aria-hidden="true" /></summary>
        <div className="grid gap-5 border-t p-4 sm:p-6" aria-busy={!!busy}>
            <section aria-label="Execution controls" className="rounded-2xl border bg-white p-5 sm:p-6">
              <div className="mb-5"><h3 className="text-base font-medium">Restricted execution</h3><p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">Submit approved routes within saved limits. The executor cannot approve a new quote or change a recipient.</p></div>
              {data.mandate && <div className="mb-4 grid gap-2 text-sm"><p>Source ceiling: {usd(data.mandate.max_amount)} USDC.</p><p>Expires {dateLabel(data.mandate.expires_at, organization.timezone)}. Each exact route still requires its own NEAR approvals.</p><Status value={Date.parse(data.mandate.expires_at) <= Date.now() ? "expired" : data.mandate.enabled ? "enabled" : "paused"}/></div>}
              {data.worker.accountId ? (
                <>
                  <div className="mb-5 flex flex-wrap items-center gap-3">
                    <span className="text-sm text-muted-foreground">
                      Dedicated executor
                    </span>
                    <Address
                      value={data.worker.accountId}
                      network={data.worker.network ?? undefined}
                    />
                    <Status value={data.mandate && Date.parse(data.mandate.expires_at) <= Date.now() ? "expired" : data.mandate?.enabled ? "active" : "paused"} />
                  </div>
                  {data.canManageMandate && <form
                    key={data.mandate?.updated_at ?? "new-mandate"}
                    className="grid gap-4 sm:grid-cols-2"
                    onSubmit={(event) => {
                      event.preventDefault();
                      const values = new FormData(event.currentTarget);
                      void run("mandate", async () => {
                        await api(
                          `${base}/operations/mandate`,
                          {
                            enabled: values.get("enabled") === "on",
                            maxAmount: amount(values.get("cap")),
                            expiresAt: companyTimeToIso(
                              String(values.get("expiry")),
                              organization.timezone,
                            ),
                          },
                          "PUT",
                        );
                        refresh();
                        notify(
                          "Execution mandate saved. Onchain authorization is checked separately.",
                        );
                      });
                    }}
                  >
                    <Field label="Maximum source amount (USDC)">
                      <input
                        name="cap"
                        className={control}
                        defaultValue={data.mandate ? usdcInput(data.mandate.max_amount) : ""}
                        inputMode="decimal"
                        required
                      />
                    </Field>
                    <Field label="Mandate expires" hint={organization.timezone}>
                      <input
                        name="expiry"
                        className={control}
                        defaultValue={data.mandate ? formatInTimeZone(data.mandate.expires_at, organization.timezone, "yyyy-MM-dd'T'HH:mm") : ""}
                        type="datetime-local"
                        required
                      />
                    </Field>
                    <div className="flex items-end gap-3 pb-2">
                      <label className="flex items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          name="enabled"
                          defaultChecked={!!data.mandate?.enabled}
                        />
                        Enable restricted execution
                      </label>
                    </div>
                    <div className="sm:col-span-2">
                      <Action disabled={!!busy} busy={busy === "mandate"}>
                        Save execution bounds
                      </Action>
                    </div>
                  </form>}
                  {data.canManageMandate && <div className="mt-5 flex flex-wrap gap-3">
                    {data.mandate?.enabled === 1 && (
                      <Action
                        className={secondary}
                        disabled={!!busy}
                        busy={busy === "pause-mandate"}
                        onClick={() =>
                          void run("pause-mandate", async () => {
                            await api(`${base}/operations/mandate/pause`, {});
                            notify("Worker execution paused.");
                            refresh();
                          })
                        }
                      >
                        Pause worker execution
                      </Action>
                    )}
                    {[true, false].map((enabled) => (
                      <Action
                        className={secondary}
                        key={String(enabled)}
                        disabled={!!busy}
                        busy={busy === `role-${enabled}`}
                        onClick={() =>
                          void run(`role-${enabled}`, async () => {
                            const result = await api<{
                              walletActions: NearWalletAction[];
                            }>(`${base}/operations/mandate/role`, { enabled });
                            await signNearActions(
                              result.walletActions,
                              data.worker.network ?? undefined,
                            );
                            notify(
                              enabled
                                ? "Executor role confirmed in NEAR."
                                : "Executor role revoked in NEAR.",
                            );
                            refresh();
                          })
                        }
                      >
                        {busy === `role-${enabled}`
                          ? "Confirming in NEAR..."
                          : enabled
                            ? "Grant executor role in NEAR wallet"
                            : "Revoke executor role in NEAR wallet"}
                      </Action>
                    ))}
                  </div>}
                  <p className="mt-4 text-xs text-muted-foreground">
                    The server accepts only a function-call key restricted to
                    this treasury and execute_payment. The account owner retains
                    its recovery keys. A gas allowance does not replace payment
                    budgets.
                  </p>
                </>
              ) : (
                <p className="text-sm text-muted-foreground">
                  Payments use your NEAR wallet. A dedicated restricted executor
                  can be configured by your operator without changing payment
                  approval requirements.
                </p>
              )}
              {canPurge && <div className="mt-6 border-t pt-4">
                <Action
                        className={secondary}
                  disabled={!!busy}
                  busy={busy === "purge"}
                  onClick={() =>
                    void run("purge", async () => {
                      const result = await api<{ purged: number }>(
                        `${base}/operations/retention/purge`,
                        {},
                      );
                      notify(
                        `Purged ${result.purged} expired private analysis drafts.`,
                      );
                      refresh();
                    })
                  }
                >
                  Purge expired private drafts
                </Action>
              </div>}
            </section>
          <StandingMandatesPanel />
        </div>
      </details>
      {data.canManage && canPrepare && <TaskDrawer id="recurring-create-flow" title="Create recurring draft" description="Schedule future drafts from an approved bill or pay run.">
        <form aria-busy={busy === "template"} className="grid gap-6" onSubmit={event => {
          event.preventDefault(); const form = event.currentTarget, values = new FormData(form);
          void run("template", async () => {
            await api(`${base}/operations/recurring`, {
              kind, entityId: values.get("source"), intervalDays: cadence === "days" ? Number(values.get("interval")) : 1,
              cadence, intervalMonths: cadence === "months" ? Number(values.get("interval")) : 1,
              monthEnd: cadence === "months" && values.get("monthEnd") === "on",
              nextRunAt: companyTimeToIso(String(values.get("due")), organization.timezone), maxAmount: amount(values.get("cap")),
            });
            form.reset(); closeTaskDrawer("recurring-create-flow", true); setView("recurring"); setRuleStatus("all"); setRulesPage(1);
            notify("Recurring template saved. Future cycles remain drafts."); refresh();
          });
        }}>
          <fieldset disabled={!!busy} className="grid gap-4"><legend className="mb-4 text-sm font-medium">Approved source</legend><div className="grid gap-4 sm:grid-cols-2">
            <Field label="Template type"><select className={control} value={kind} onChange={event => { setKind(event.target.value as typeof kind); setSourcesPage(1); }}><option value="bill">Approved bill</option><option value="payroll">Approved pay run</option></select></Field>
            <Field label="Source"><select key={`${kind}:${sourcesPage}`} className={control} name="source" required disabled={sources.loading || !sources.data?.templates.length}><option value="">{sources.loading ? "Loading sources..." : "Choose a source"}</option>{sources.data?.templates.map(source => <option key={source.id} value={source.id}>{source.reference}</option>)}</select></Field>
          </div>{sources.error && <p role="alert" className="text-xs text-destructive">{sources.error}</p>}{!sources.loading && !sources.error && !sources.data?.templates.length && <p className="rounded-xl bg-muted p-3 text-xs leading-5 text-muted-foreground">{kind === "bill" ? "Approve a bill before creating a recurring bill template." : "Approve a pay run before creating a recurring payroll template."}</p>}<PageControls value={sources.data} loading={sources.loading || !!busy} label="Approved template sources" change={setSourcesPage} /></fieldset>
          <fieldset disabled={!!busy} className="grid gap-4 border-t pt-5"><legend className="pr-3 text-sm font-medium">Schedule</legend><div className="grid gap-4 sm:grid-cols-2">
            <Field label="Repeat by"><select className={control} value={cadence} onChange={event => setCadence(event.target.value as typeof cadence)}><option value="months">Calendar months</option><option value="days">Calendar days</option></select></Field>
            <Field label={`Every (${cadence})`}><input key={cadence} className={control} name="interval" type="number" defaultValue={cadence === "months" ? "1" : "30"} min={1} max={cadence === "months" ? 12 : 365} required /></Field>
            <div className="sm:col-span-2"><Field label="First due date" hint={organization.timezone}><input className={control} name="due" type="datetime-local" required /></Field></div>
          </div>{cadence === "months" && <><label className="flex items-center gap-3 text-sm"><input className="size-4 accent-primary" type="checkbox" name="monthEnd" />Repeat on the last calendar day</label><p className="text-xs leading-5 text-muted-foreground">Short months use their last available day, then return to the original day.</p></>}</fieldset>
          <fieldset disabled={!!busy} className="grid gap-4 border-t pt-5"><legend className="pr-3 text-sm font-medium">Spending limit</legend><Field label="Cycle ceiling (USDC)" hint="Changed amounts or receiving details hold the next cycle for review."><input className={`${control} tabular-nums`} name="cap" inputMode="decimal" required placeholder="5000.00" /></Field><p className="rounded-xl bg-secondary/50 p-4 text-xs leading-5 text-muted-foreground">Each cycle creates a draft. Saving this schedule does not authorize a payment or a new route.</p></fieldset>
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          <footer className="flex flex-wrap justify-end gap-3 border-t pt-5"><button type="button" className="min-h-10 rounded-full px-4 text-sm font-medium hover:bg-muted" disabled={!!busy} onClick={() => closeTaskDrawer("recurring-create-flow")}>Close</button><Action disabled={!!busy || sources.loading || !!sources.error || !sources.data?.templates.length} busy={busy === "template"}>{busy === "template" ? "Creating template..." : "Create recurring draft"}</Action></footer>
        </form>
      </TaskDrawer>}
    </>}
  </div>;
}
