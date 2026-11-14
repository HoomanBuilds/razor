"use client";

import { useEffect, useState } from "react";
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
import { StandingMandatesPanel } from "./standing-mandates";
import { useWorkspace } from "./context";
import { useAction, useResource } from "./hooks";
import {
  Action,
  Address,
  control,
  DataTable,
  Empty,
  Field,
  Panel,
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
  if (!value) return null;
  return <nav aria-label={label} className="mt-4 flex flex-wrap items-center gap-3 text-sm"><p className="mr-auto text-xs text-muted-foreground">{value.total ? (value.page - 1) * value.pageSize + 1 : 0}-{Math.min(value.page * value.pageSize, value.total)} of {value.total}</p><button type="button" className="text-primary disabled:opacity-50" disabled={loading || value.page <= 1} onClick={()=>change(value.page - 1)}>Previous</button><span>Page {value.page}</span><button type="button" className="text-primary disabled:opacity-50" disabled={loading || !value.hasMore} onClick={()=>change(value.page + 1)}>Next</button></nav>;
}

function amount(value: FormDataEntryValue | null) {
  try {
    return microUsd(String(value));
  } catch (error) {
    throw new RequestError((error as Error).message, 422, "INVALID_AMOUNT");
  }
}

export function OperationsPanel() {
  const { base, organization, revision, refresh, navigate, notify } =
    useWorkspace();
  const canRead=!!organization.permissions?.includes("payments:read"),canPrepare=!!organization.permissions?.includes("payments:prepare"),canPurge=!!organization.permissions?.includes("documents:manage");
  const resource = useResource<Overview>(
    canRead?`${base}/operations/overview`:null,
    revision,
  );
  const { busy, error, run } = useAction();
  const [kind, setKind] = useState<"bill" | "payroll">("bill");
  const [cadence, setCadence] = useState<"days" | "months">("months");
  const [jobsPage, setJobsPage] = useState(1), [rulesPage, setRulesPage] = useState(1), [noticesPage, setNoticesPage] = useState(1), [sourcesPage, setSourcesPage] = useState(1);
  const [jobStatus, setJobStatus] = useState<"all" | "attention" | "pending" | "completed">("all");
  const [ruleStatus, setRuleStatus] = useState<"all" | "active" | "paused" | "held">("all");
  const [noticeStatus, setNoticeStatus] = useState<"all" | "unread">("all");
  const jobs = useResource<PageInfo & {jobs: Overview["jobs"]}>(canRead ? `${base}/operations/jobs?page=${jobsPage}&pageSize=25&status=${jobStatus}` : null, revision);
  const rules = useResource<PageInfo & {recurring: RecurringRuleView[]}>(canRead ? `${base}/operations/recurring?page=${rulesPage}&pageSize=25&status=${ruleStatus}` : null, revision);
  const notices = useResource<PageInfo & {notices: Notice[]}>(canRead ? `${base}/operations/notices?page=${noticesPage}&pageSize=25&status=${noticeStatus}` : null, revision);
  const sources = useResource<PageInfo & {templates: {id:string;reference:string}[]}>(canRead && canPrepare && resource.data?.canManage ? `${base}/operations/templates?kind=${kind}&page=${sourcesPage}&pageSize=25` : null, revision);
  const data = resource.data;
  useEffect(() => {
    const clamp = (value: PageInfo | null, current: number, update: (page: number) => void) => {
      if (value && current > Math.max(1, Math.ceil(value.total / value.pageSize))) update(Math.max(1, Math.ceil(value.total / value.pageSize)));
    };
    clamp(jobs.data, jobsPage, setJobsPage);
    clamp(rules.data, rulesPage, setRulesPage);
    clamp(notices.data, noticesPage, setNoticesPage);
    clamp(sources.data, sourcesPage, setSourcesPage);
  }, [jobs.data, jobsPage, rules.data, rulesPage, notices.data, noticesPage, sources.data, sourcesPage]);
  if(!canRead)return null;
  return (
    <div className="grid gap-6">
      <StandingMandatesPanel />
      <Panel
        title="Company operations"
        description="Keep due payments, recurring drafts and delivery checks moving without losing their approval history."
        action={
          data?.canManage && (
            <Action
              disabled={!!busy}
              busy={busy === "tick"}
              onClick={() =>
                void run("tick", async () => {
                  const result = await api<{ processed: number }>(
                    `${base}/operations/tick`,
                    {},
                  );
                  notify(`Checked ${result.processed} operations jobs.`);
                  refresh();
                })
              }
            >
              Check due work
            </Action>
          )
        }
      >
        {resource.error && (
          <p role="alert" className="text-sm text-destructive">
            {resource.error}
          </p>
        )}
        {resource.loading ? (
          <Empty>Loading company operations...</Empty>
        ) : (
          data && (
            <div className="grid gap-4 sm:grid-cols-3">
              <div>
                <p className="text-xs text-muted-foreground">
                  Company payments
                </p>
                <div className="mt-2">
                  <Status value={data.paused ? "paused" : "active"} />
                </div>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Execution</p>
                <p className="mt-2 text-sm font-medium">
                  {data.worker.configured
                    ? "Restricted executor configured"
                    : "Owner wallet required"}
                </p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Inbox</p>
                <p className="mt-2 text-sm font-medium">
                  {data.unread} unread notices
                </p>
              </div>
            </div>
          )
        )}
        <p className="mt-5 text-xs text-muted-foreground">
          Recurring cycles create drafts. New payment routes always need owner
          or approver authorization. Pausing stops new execution while delivery
          checks continue.
        </p>
      </Panel>
      {error && (
        <p
          role="alert"
          className="rounded-lg border p-4 text-sm text-destructive"
        >
          {error}
        </p>
      )}
      {data && (
        <>
          <Panel
            title="Recurring payroll and bills"
            description="Repeat approved amounts and confirmed receiving preferences within a per-cycle ceiling. Changed terms hold the next cycle for review."
          >
            {data.canManage && canPrepare && (
              <form
                className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-5"
                onSubmit={(event) => {
                  event.preventDefault();
                  const form = event.currentTarget,
                    values = new FormData(form);
                  void run("template", async () => {
                    await api(`${base}/operations/recurring`, {
                      kind,
                      entityId: values.get("source"),
                      intervalDays: cadence === "days" ? Number(values.get("interval")) : 1,
                      cadence,
                      intervalMonths: cadence === "months" ? Number(values.get("interval")) : 1,
                      monthEnd: cadence === "months" && values.get("monthEnd") === "on",
                      nextRunAt: companyTimeToIso(
                        String(values.get("due")),
                        organization.timezone,
                      ),
                      maxAmount: amount(values.get("cap")),
                    });
                    form.reset();
                    notify(
                      "Recurring template saved. Future cycles remain drafts.",
                    );
                    refresh();
                  });
                }}
              >
                <Field label="Template type">
                  <select
                    className={control}
                    value={kind}
                    onChange={(event) =>
                      { setKind(event.target.value as "bill" | "payroll"); setSourcesPage(1); }
                    }
                  >
                    <option value="bill">Approved bill</option>
                    <option value="payroll">Approved pay run</option>
                  </select>
                </Field>
                <Field label="Approved source">
                  <select key={`${kind}:${sourcesPage}`} className={control} name="source" required disabled={sources.loading}>
                    <option value="">Choose a source</option>
                    {sources.data?.templates.map((source) => (
                      <option key={source.id} value={source.id}>
                        {source.reference}
                      </option>
                    ))}
                  </select>
                  {sources.error && <p role="alert" className="mt-2 text-xs text-destructive">{sources.error}</p>}
                  <PageControls value={sources.data} loading={sources.loading} label="Approved template sources" change={setSourcesPage}/>
                </Field>
                <Field label="Repeat by">
                  <select className={control} value={cadence} onChange={event => setCadence(event.target.value as "days" | "months")}><option value="months">Calendar months</option><option value="days">Calendar days</option></select>
                </Field>
                <Field label={`Every (${cadence})`} hint={cadence === "months" ? "Short months use their last available day, then return to the original day." : undefined}>
                  <input
                    key={cadence}
                    className={control}
                    name="interval"
                    type="number"
                    defaultValue={cadence === "months" ? "1" : "30"}
                    min={1}
                    max={cadence === "months" ? 12 : 365}
                    required
                  />
                </Field>
                {cadence === "months" && <label className="flex items-center gap-2 self-center text-sm"><input type="checkbox" name="monthEnd" />Repeat on the last calendar day</label>}
                <Field label="First due date" hint={organization.timezone}>
                  <input
                    className={control}
                    name="due"
                    type="datetime-local"
                    required
                  />
                </Field>
                <Field label="Cycle ceiling (USDC)">
                  <input
                    className={control}
                    name="cap"
                    inputMode="decimal"
                    required
                    placeholder="5000.00"
                  />
                </Field>
                <div className="lg:col-span-5">
                  <Action disabled={!!busy} busy={busy === "template"}>
                    Create recurring draft template
                  </Action>
                </div>
              </form>
            )}
            <div className="mb-4 max-w-xs"><Field label="Template status"><select className={control} value={ruleStatus} onChange={event=>{setRuleStatus(event.target.value as typeof ruleStatus);setRulesPage(1);}}><option value="all">All templates</option><option value="active">Active templates</option><option value="paused">Paused templates</option><option value="held">Needs review</option></select></Field></div>
            {rules.error && <p role="alert" className="mb-3 text-sm text-destructive">{rules.error}</p>}
            {rules.loading ? <Empty>Loading recurring templates...</Empty> : !rules.data?.recurring.length ? (
              <Empty>
                Approve a bill or pay run, then use it as a recurring draft
                template.
              </Empty>
            ) : (
              <DataTable
                columns={[
                  "Type",
                  "Interval",
                  "Next cycle",
                  "Ceiling",
                  "Status",
                  "Action",
                ]}
              >
                {rules.data.recurring.map((rule) => (
                  <tr key={rule.id}>
                    <td className="capitalize">{rule.kind}</td>
                    <td>{rule.cadence === "months" ? `${rule.interval_months} months${rule.month_end ? ", month end" : ""}` : `${rule.interval_days} days`}</td>
                    <td>{dateLabel(rule.next_run_at, organization.timezone)}</td>
                    <td>{usd(rule.max_amount ?? "0")}</td>
                    <td>
                      <Status value={rule.status} />
                      {rule.status === "held" && (
                        <p className="mt-2 max-w-64 text-xs text-amber-900">
                          Review changed terms and create a fresh template.
                        </p>
                      )}
                    </td>
                    <td>
                      {data.canManage && rule.status !== "held" && (
                        <Action
                          disabled={!!busy||(!rule.enabled&&!canPrepare)}
                          busy={busy === rule.id}
                          onClick={() =>
                            void run(rule.id, async () => {
                              await api(
                                `${base}/operations/recurring/${rule.id}`,
                                { enabled: !rule.enabled },
                                "PATCH",
                              );
                              refresh();
                            })
                          }
                        >
                          {rule.enabled ? "Pause template" : "Resume template"}
                        </Action>
                      )}
                    </td>
                  </tr>
                ))}
              </DataTable>
            )}
            <PageControls value={rules.data} loading={rules.loading} label="Recurring templates" change={setRulesPage}/>
          </Panel>
          <Panel
            title="Operations inbox"
            description="Notices are visible to the relevant company roles. Reading one does not dismiss it for another teammate."
          >
            <div className="mb-4 max-w-xs"><Field label="Notice status"><select className={control} value={noticeStatus} onChange={event=>{setNoticeStatus(event.target.value as typeof noticeStatus);setNoticesPage(1);}}><option value="all">All notices</option><option value="unread">Unread notices</option></select></Field></div>
            {notices.error && <p role="alert" className="mb-3 text-sm text-destructive">{notices.error}</p>}
            {notices.loading ? <Empty>Loading operations notices...</Empty> : !notices.data?.notices.length ? (
              <Empty>Due payments and recurring drafts will appear here.</Empty>
            ) : (
              <div className="divide-y">
                {notices.data.notices.map((notice) => (
                  <article
                    key={notice.id}
                    className="flex flex-wrap items-start justify-between gap-4 py-4 first:pt-0"
                  >
                    <div className="max-w-2xl">
                      <h3
                        className={`text-sm ${notice.read_at ? "text-muted-foreground" : "font-semibold"}`}
                      >
                        {notice.title}
                      </h3>
                      <p className="mt-1 text-sm text-muted-foreground">
                        {notice.body}
                      </p>
                      <p className="mt-2 text-xs text-muted-foreground">
                        {dateLabel(notice.created_at)}
                      </p>
                    </div>
                    <div className="flex gap-3">
                      <button
                        className="text-sm text-primary"
                        onClick={() => navigate("payments")}
                      >
                        View payments
                      </button>
                      {!notice.read_at && (
                        <Action
                          disabled={!!busy}
                          busy={busy === notice.id}
                          onClick={() =>
                            void run(notice.id, async () => {
                              await api(
                                `${base}/operations/notices/${notice.id}/read`,
                                {},
                              );
                              refresh();
                            })
                          }
                        >
                          Mark read
                        </Action>
                      )}
                    </div>
                  </article>
                ))}
              </div>
            )}
            <PageControls value={notices.data} loading={notices.loading} label="Operations notices" change={setNoticesPage}/>
          </Panel>
          <Panel
            title="Work queue"
            description="Queued work survives restarts. Awaiting-wallet and paused jobs stay visible until their conditions change."
          >
            <div className="mb-4 max-w-xs"><Field label="Work status"><select className={control} value={jobStatus} onChange={event=>{setJobStatus(event.target.value as typeof jobStatus);setJobsPage(1);}}><option value="all">All work</option><option value="attention">Needs attention</option><option value="pending">Queued or running</option><option value="completed">Completed work</option></select></Field></div>
            {jobs.error && <p role="alert" className="mb-3 text-sm text-destructive">{jobs.error}</p>}
            {jobs.loading ? <Empty>Loading durable work queue...</Empty> : !jobs.data?.jobs.length ? (
              <Empty>
                Check due work to populate the queue. A background worker can
                keep it current.
              </Empty>
            ) : (
              <DataTable
                columns={["Work", "State", "Next check", "Details", "Action"]}
              >
                {jobs.data.jobs.map((job) => {
                  const detail = job.result
                    ? (JSON.parse(job.result) as {
                        reason?: string;
                        mode?: string;
                      })
                    : null;
                  return (
                    <tr key={job.id}>
                      <td className="capitalize">
                        {job.kind.replaceAll("_", " ")}
                      </td>
                      <td>
                        <Status
                          value={
                            job.status === "blocked" &&
                            detail?.mode === "manual"
                              ? "awaiting_wallet"
                              : job.status
                          }
                        />
                      </td>
                      <td>
                        {job.status === "completed"
                          ? "Complete"
                          : dateLabel(job.run_at)}
                      </td>
                      <td className="max-w-sm text-xs text-muted-foreground">
                        {job.last_error ?? detail?.reason ?? "Recorded safely"}
                      </td>
                      <td>
                        {data.canManage &&
                          ["blocked", "failed"].includes(job.status) && (
                            <Action
                              disabled={!!busy}
                              busy={busy === job.id}
                              onClick={() =>
                                void run(job.id, async () => {
                                  await api(
                                    `${base}/operations/jobs/${job.id}/retry`,
                                    {},
                                  );
                                  refresh();
                                })
                              }
                            >
                              Requeue
                            </Action>
                          )}
                      </td>
                    </tr>
                  );
                })}
              </DataTable>
            )}
            <PageControls value={jobs.data} loading={jobs.loading} label="Work queue" change={setJobsPage}/>
          </Panel>
            <Panel
              title="Execution controls"
              description="A worker can submit an exact route only after its onchain approval. It cannot approve a new quote or change the recipient."
            >
              {data.mandate && <div className="mb-4 grid gap-2 text-sm"><p>Saved executor: {data.mandate.executor_account_id}. Source ceiling: {usd(data.mandate.max_amount)}.</p><p>Expires {dateLabel(data.mandate.expires_at, organization.timezone)}. Each exact route still requires its own NEAR approvals.</p><Status value={Date.parse(data.mandate.expires_at) <= Date.now() ? "expired" : data.mandate.enabled ? "enabled" : "paused"}/></div>}
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
                    className="grid gap-4 sm:grid-cols-3"
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
                    <div className="sm:col-span-3">
                      <Action disabled={!!busy} busy={busy === "mandate"}>
                        Save execution bounds
                      </Action>
                    </div>
                  </form>}
                  {data.canManageMandate && <div className="mt-5 flex flex-wrap gap-3">
                    {data.mandate?.enabled === 1 && (
                      <Action
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
            </Panel>
        </>
      )}
    </div>
  );
}
