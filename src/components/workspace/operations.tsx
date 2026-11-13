"use client";

import { useState } from "react";
import { companyTimeToIso } from "@/lib/company-time";
import { api, RequestError } from "@/lib/api";
import { dateLabel, microUsd, usd } from "@/lib/format";
import { signNearActions, type NearWalletAction } from "@/lib/near-actions";
import type {
  AgentMandate,
  Notice,
  RecurringRuleView,
} from "@/server/operations/types";
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
  const canRead=!!organization.permissions?.includes("payments:read"),canPrepare=!!organization.permissions?.includes("payments:prepare");
  const resource = useResource<Overview>(
    canRead?`${base}/operations/overview`:null,
    revision,
  );
  const { busy, error, run } = useAction();
  const [kind, setKind] = useState<"bill" | "payroll">("bill");
  const [cadence, setCadence] = useState<"days" | "months">("months");
  const data = resource.data;
  if(!canRead)return null;
  return (
    <div className="grid gap-6">
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
                      setKind(event.target.value as "bill" | "payroll")
                    }
                  >
                    <option value="bill">Approved bill</option>
                    <option value="payroll">Approved pay run</option>
                  </select>
                </Field>
                <Field label="Approved source">
                  <select key={kind} className={control} name="source" required>
                    <option value="">Choose a source</option>
                    {(kind === "bill"
                      ? data.templates.bills
                      : data.templates.payroll
                    ).map((source) => (
                      <option key={source.id} value={source.id}>
                        {source.reference}
                      </option>
                    ))}
                  </select>
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
            {!data.recurring.length ? (
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
                {data.recurring.map((rule) => (
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
          </Panel>
          <Panel
            title="Operations inbox"
            description="Notices are visible to the relevant company roles. Reading one does not dismiss it for another teammate."
          >
            {!data.notices.length ? (
              <Empty>Due payments and recurring drafts will appear here.</Empty>
            ) : (
              <div className="divide-y">
                {data.notices.map((notice) => (
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
          </Panel>
          <Panel
            title="Work queue"
            description="Queued work survives restarts. Awaiting-wallet and paused jobs stay visible until their conditions change."
          >
            {!data.jobs.length ? (
              <Empty>
                Check due work to populate the queue. A background worker can
                keep it current.
              </Empty>
            ) : (
              <DataTable
                columns={["Work", "State", "Next check", "Details", "Action"]}
              >
                {data.jobs.map((job) => {
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
          </Panel>
          {data.canManage && (
            <Panel
              title="Execution controls"
              description="A worker can submit an exact route only after its onchain approval. It cannot approve a new quote or change the recipient."
            >
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
                    <Status
                      value={data.mandate?.enabled ? "active" : "paused"}
                    />
                  </div>
                  <form
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
                        inputMode="decimal"
                        required
                      />
                    </Field>
                    <Field label="Mandate expires" hint={organization.timezone}>
                      <input
                        name="expiry"
                        className={control}
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
                  </form>
                  <div className="mt-5 flex flex-wrap gap-3">
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
                  </div>
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
              <div className="mt-6 border-t pt-4">
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
              </div>
            </Panel>
          )}
        </>
      )}
    </div>
  );
}
