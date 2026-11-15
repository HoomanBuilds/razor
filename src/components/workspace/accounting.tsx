"use client";

import { useState } from "react";
import { ChevronRight, Plus } from "lucide-react";
import { TaskDrawer, closeTaskDrawer, openTaskDrawer } from "./task-drawer";
import { WorkspaceTabs } from "./workspace-tabs";
import { AccountingRegister } from "./accounting-register";
import { NetSuitePanel } from "./netsuite";
import { api } from "@/lib/api";
import { formatUnits } from "@/lib/money";
import type { PostingKind } from "@/server/accounting/model";
import {
  AccountingLedgerTools,
  AccountingValuationFields,
  valuationFields,
} from "./accounting-ledger";
import { usd } from "@/lib/format";
import type {
  accountingCatalog,
  accountingOverview,
} from "@/server/accounting/service";
import { useWorkspace } from "./context";
import { useAction, useResource } from "./hooks";
import {
  Action,
  control,
  Empty,
  Field,
  Panel,
  Status,
} from "./shared";

type Overview = ReturnType<typeof accountingOverview>;
type Catalog = ReturnType<typeof accountingCatalog>;
const signedCents = (value: string) =>
  `${value.startsWith("-") ? "-" : ""}${formatUnits(value.startsWith("-") ? value.slice(1) : value, 2)}`;
export function AccountingPanel() {
  const { base, organization, revision, refresh } = useWorkspace();
  const allowed = ["company:manage", "payments:read", "reports:read"].every(
    (permission) => organization.permissions?.includes(permission),
  );
  const canApprove = !!organization.permissions?.includes("payments:approve");
  const [view, setView] = useState(0);
  const [connectionTask, setConnectionTask] = useState<"overview" | "catalog" | "mapping" | "disconnect">("overview");
  const [jobId, setJobId] = useState("");
  const [page, setPage] = useState(1),
    [selected, setSelected] = useState(""),
    [catalogPage, setCatalogPage] = useState(1),
    [notice, setNotice] = useState("");
  const [kind, setKind] = useState<PostingKind>("bill"),
    [sourceId, setSourceId] = useState("");
  const endpoint = `${base}/accounting`;
  const resource = useResource<Overview>(
    allowed ? `${endpoint}?page=${page}` : null,
    revision,
  );
  const catalog = useResource<Catalog>(
    allowed && selected ? `${endpoint}/connections/${selected}/catalog` : null,
    revision,
  );
  const { busy, error, run, setError } = useAction(),
    data = resource.data;
  const connection = data?.connections.find((item) => item.id === selected),
    mapping = catalog.data?.mapping;
  const sources =
    kind === "bill"
      ? data?.bills.map((item) => ({
          id: item.id,
          label: `${item.reference} · ${usd(item.amount)} USDC`,
        }))
      : kind === "settlement"
        ? data?.settlements.map((item) => ({
            id: item.id,
            label: `${item.reference} · ${usd(item.amount)} USDC`,
          }))
        : kind === "credit"
          ? data?.ledger.credits.map((item) => ({
              id: item.id,
              label: `${item.reference} · ${usd(item.amount)} USDC accepted credit`,
            }))
          : kind === "fee"
            ? data?.ledger.feeBatches
                .filter((item) => item.state === "grouped")
                .map((item) => ({
                  id: item.id,
                  label: `${formatUnits(item.amount_atomic, 24)} NEAR · ${item.network}`,
                }))
            : data?.ledger.fxDifferences
                .filter((item) => item.connection_id === selected)
                .map((item) => ({
                  id: item.id,
                  label: `${signedCents(item.terms.differenceCents)} ${connection?.currency ?? "functional units"} · ${item.created_at.slice(0, 10)}`,
                }));
  const sourceBill =
    kind === "bill" ? data?.bills.find((item) => item.id === sourceId) : null;
  const job = data?.jobs.find(item => item.id === jobId);
  const disabled = !!busy || resource.refreshing || !!resource.error;
  const chooseConnection = (id: string) => { setSelected(id); setSourceId(""); setCatalogPage(1); setNotice(""); setError(""); setConnectionTask("overview"); };
  const providerName = (provider: string) => provider === "quickbooks" ? "QuickBooks Online" : "Xero";
  const kindLabels: Record<PostingKind, string> = { bill: "Invoice", settlement: "Installment credit", credit: "Supplier credit", fee: "Network fees", fx: "FX adjustment" };
  const jobReference = (item: Overview["jobs"][number]) => item.kind === "fee" ? "NEAR fee batch" : item.kind === "fx" ? "FX adjustment" : item.posting.source?.reference || kindLabels[item.kind];
  const connectionSelect = <Field label="Accounting connection"><select className={control} value={selected} disabled={!!busy} onChange={event => chooseConnection(event.target.value)}><option value="">Choose a connection</option>{data?.connections.map(item => <option key={item.id} value={item.id}>{providerName(item.provider)} · {item.entity_name ?? "Company not selected"}</option>)}</select></Field>;
  const feedback = <>{notice && <p role="status" className="text-sm text-muted-foreground">{notice}</p>}{(resource.error || catalog.error || error) && <p role="alert" className="text-sm text-destructive">{resource.error || catalog.error || error}</p>}</>;
  if (!allowed) return null;
  return <div className="grid min-w-0 gap-5">{feedback}<WorkspaceTabs activeIndex={view} onActiveChange={index => { if (!busy) setView(index); }} tabs={[
    { label: "Ledger", content: resource.loading && !data ? <Empty>Loading ledger...</Empty> : data ? <AccountingRegister data={data} onConnect={() => setView(1)}/> : <Empty>Ledger unavailable. Refresh to try again.</Empty> },
    { label: "Connections", content: <Panel title="Accounting apps" tone="white"><div className="grid gap-5">
      {data?.connections.length ? <div className="divide-y">{data.connections.map(item => <article key={item.id} className="flex flex-wrap items-center justify-between gap-4 py-4 first:pt-0"><div><p className="text-sm font-medium">{item.entity_name ?? providerName(item.provider)}</p><p className="mt-1 text-xs text-muted-foreground">{providerName(item.provider)}{item.currency ? ` · ${item.currency}` : ""}</p><div className="mt-2"><Status value={item.status}/></div></div><button type="button" disabled={!!busy} className="min-h-10 text-sm font-medium text-primary" onClick={() => { chooseConnection(item.id); openTaskDrawer("accounting-connection-task"); }}>Manage<ChevronRight className="ml-1 inline" size={15}/></button></article>)}</div> : null}
      <div className="grid gap-3 sm:grid-cols-2">{data?.providers.map(provider => <div key={provider.provider} className="flex flex-wrap items-center justify-between gap-4 rounded-2xl bg-muted/50 p-4"><div><p className="text-sm font-medium">{providerName(provider.provider)}</p><p className="mt-1 text-xs text-muted-foreground">{provider.configured ? provider.environment : "Setup required"}</p></div><Action type="button" disabled={!!busy || !provider.configured} busy={busy === provider.provider} onClick={() => void run(provider.provider, async () => { const result = await api<{ authorizationUrl: string }>(`${endpoint}/connect/${provider.provider}`, {}); window.location.assign(result.authorizationUrl); })}>Connect</Action></div>)}</div>
      <details className="border-t pt-4 text-xs"><summary className="cursor-pointer text-muted-foreground">Data sharing</summary><p className="mt-3 leading-5 text-muted-foreground">Reviewed bill titles and mapped contacts are shared with the connected provider. Bookkeeping connections do not move funds.</p><p className="mt-3 leading-5 text-muted-foreground">{data?.scope}</p></details>
    </div></Panel> },
    { label: "Posting requests", content: <Panel title="Posting requests" tone="white" action={<Action type="button" disabled={disabled} onClick={() => openTaskDrawer("accounting-posting-create")}><Plus size={15}/>New posting</Action>}><div className="grid gap-5">
      {canApprove && <div className="flex justify-end"><button type="button" disabled={disabled} className="min-h-10 text-sm font-medium text-primary" onClick={() => void run("dispatch", async () => { await api(`${endpoint}/dispatch`, {}); setNotice("Request processed. Review its provider status."); refresh(); })}>{busy === "dispatch" ? "Processing..." : "Process next approved request"}</button></div>}
      {!data?.jobs.length ? <Empty>No posting requests.</Empty> : <div className="divide-y">{data.jobs.map(item => <article key={item.id} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-3 py-5 sm:grid-cols-[minmax(0,1fr)_auto_140px_auto]"><div className="min-w-0"><p className="truncate text-sm font-medium">{jobReference(item)}</p><p className="mt-1 text-xs text-muted-foreground">{kindLabels[item.kind]} · {item.posting.source?.date}</p></div><p className="text-right text-sm font-medium tabular-nums">{item.posting.amount?.text} <span className="text-xs text-muted-foreground">{item.posting.functionalCurrency}</span></p><div className="justify-self-start sm:ml-4"><Status value={item.state}/></div><button type="button" disabled={!!busy} className="justify-self-end text-sm font-medium text-primary" onClick={() => { setJobId(item.id); setError(""); setNotice(""); openTaskDrawer("accounting-posting-review"); }}>Review<ChevronRight size={15} className="ml-1 inline"/></button></article>)}</div>}
      {(page > 1 || data?.hasMore) && <div className="flex items-center justify-between gap-4 border-t pt-4 text-xs"><span className="text-muted-foreground">Page {page}</span><div className="flex gap-4"><button type="button" disabled={page === 1 || !!busy} onClick={() => setPage(value => value - 1)} className="text-primary disabled:opacity-40">Previous</button><button type="button" disabled={!data?.hasMore || !!busy} onClick={() => setPage(value => value + 1)} className="text-primary disabled:opacity-40">Next</button></div></div>}
    </div></Panel> },
    { label: "Fees & valuations", content: <Panel title="Fees and valuations" tone="white">{data && <AccountingLedgerTools endpoint={endpoint} data={data} connectionId={selected} canApprove={canApprove} disabled={disabled} onChange={refresh}/>}</Panel> },
    { label: "Provider activity", content: <Panel title="Provider activity" tone="white" action={<button type="button" className="min-h-10 text-sm text-primary" onClick={() => setView(3)}>Import tools</button>}>{data?.observations.length ? <div className="divide-y">{data.observations.map(item => <details key={`${item.kind}:${item.external_id}`} className="py-4"><summary className="flex cursor-pointer items-center justify-between gap-3 text-sm"><span className="capitalize">{item.kind} <span className="ml-2 text-xs text-muted-foreground">{new Date(item.observed_at).toLocaleDateString()}</span></span><Status value={item.state}/></summary><dl className="mt-4 grid gap-3 text-xs"><div><dt className="text-muted-foreground">Provider record</dt><dd className="mt-1 break-all font-mono">{item.external_id}</dd></div><div><dt className="text-muted-foreground">Revision</dt><dd className="mt-1 break-all">{item.revision || "Not supplied"}</dd></div></dl></details>)}</div> : <Empty>No imported provider activity.</Empty>}</Panel> },
    { label: "NetSuite", content: <NetSuitePanel/> },
  ]}/>
  <TaskDrawer id="accounting-connection-task" title={connectionTask === "mapping" ? "Account mapping" : connectionTask === "catalog" ? "Provider catalog" : connectionTask === "disconnect" ? "Disconnect app" : "Connection settings"}><div aria-busy={!!busy} className="grid gap-5">{connection && <><div><p className="text-lg font-medium">{connection.entity_name ?? providerName(connection.provider)}</p><p className="mt-1 text-xs text-muted-foreground">{providerName(connection.provider)}{connection.currency ? ` · ${connection.currency}` : ""}</p></div>{connectionTask !== "overview" && <button type="button" className="justify-self-start text-sm text-primary" disabled={!!busy} onClick={() => setConnectionTask("overview")}>Back to settings</button>}
    {connection.last_error && <p role="alert" className="text-sm text-destructive">{connection.last_error}</p>}
    {connectionTask === "overview" && <><div><Status value={connection.status}/></div>{connection.status === "select_entity" && <form key={connection.id} className="grid gap-4" onSubmit={event => { event.preventDefault(); const values = new FormData(event.currentTarget); void run("entity", async () => { await api(`${endpoint}/connections/${selected}/entity`, { entityId: values.get("entity") }); setNotice("Company selected."); refresh(); }); }}><Field label="Company"><select name="entity" required className={control}><option value="">Choose company</option>{connection.entities.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></Field><Action busy={busy === "entity"} disabled={disabled} className="justify-self-start">Confirm company</Action></form>}{connection.status === "active" && <div className="divide-y"><button type="button" disabled={!!busy} className="flex min-h-14 w-full items-center justify-between text-sm" onClick={() => setConnectionTask("catalog")}>Load provider catalog<ChevronRight size={15}/></button>{canApprove && <button type="button" disabled={!!busy || !catalog.data?.items.length} className="flex min-h-14 w-full items-center justify-between text-sm disabled:opacity-40" onClick={() => setConnectionTask("mapping")}>Account mapping<ChevronRight size={15}/></button>}</div>}<button type="button" disabled={disabled} className="justify-self-start text-sm text-destructive" onClick={() => setConnectionTask("disconnect")}>Disconnect</button></>}
    {connectionTask === "catalog" && connection.status === "active" && <form className="grid gap-4" onSubmit={event => { event.preventDefault(); void run("catalog", async () => { const result = await api<{ mayHaveMore: boolean }>(`${endpoint}/connections/${selected}/catalog`, { page: catalogPage }); setNotice(result.mayHaveMore ? "Catalog loaded. More pages are available." : "Catalog loaded."); refresh(); }); }}><Field label="Catalog page"><input type="number" min={1} max={100} className={control} value={catalogPage} onChange={event => setCatalogPage(Number(event.target.value))}/></Field><Action busy={busy === "catalog"} disabled={disabled} className="justify-self-start">Load accounts and contacts</Action></form>}
    {connectionTask === "mapping" && connection.status === "active" && canApprove && catalog.data?.items.length ?                     <form
                      key={`${selected}:${mapping?.version ?? 0}`}
                      aria-busy={!!busy}
                      className="grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-2"
                      onSubmit={(event) => {
                        event.preventDefault();
                        const values = new FormData(event.currentTarget);
                        void run("mapping", async () => {
                          await api(
                            `${endpoint}/connections/${selected}/mapping`,
                            {
                              expectedVersion: mapping?.version ?? 0,
                              expenseAccountId: values.get("expense"),
                              bankAccountId: values.get("bank"),
                              taxCodeId: values.get("tax"),
                              contacts: catalog.data!.recipients.flatMap(
                                (recipient) => {
                                  const externalId = String(
                                    values.get(`contact:${recipient.id}`) ?? "",
                                  );
                                  return externalId
                                    ? [
                                        {
                                          recipientId: recipient.id,
                                          externalId,
                                        },
                                      ]
                                    : [];
                                },
                              ),
                              ...(values.get("journalClearing")
                                ? {
                                    journalClearingAccountId:
                                      values.get("journalClearing"),
                                  }
                                : {}),
                              ...(values.get("feeExpense")
                                ? {
                                    feeExpenseAccountId:
                                      values.get("feeExpense"),
                                  }
                                : {}),
                              ...(values.get("fxAccount")
                                ? { fxAccountId: values.get("fxAccount") }
                                : {}),
                              fxNumerator: values.get("numerator"),
                              fxDenominator: values.get("denominator"),
                              fxSource: values.get("fxSource"),
                              fxDate: values.get("fxDate"),
                              closedThrough:
                                values.get("closedThrough") || null,
                              acknowledgement: true,
                            },
                            "PUT",
                          );
                          setNotice(
                            "Mapping saved. Existing requests need fresh review.",
                          );
                          closeTaskDrawer("accounting-connection-task", true);
                          refresh();
                        });
                      }}
                    >
                      <h3 className="font-medium sm:col-span-2">Accounts</h3>
                      <Field label="Expense account">
                        <select
                          name="expense"
                          className={control}
                          required
                          defaultValue={mapping?.value.expenseAccountId}
                        >
                          <option value="">
                            Choose an account
                          </option>
                          {catalog.data.items
                            .filter(
                              (item) => item.kind === "account" && item.active,
                            )
                            .map((item) => (
                              <option key={item.id} value={item.id}>
                                {item.name} · {item.type}
                              </option>
                            ))}
                        </select>
                      </Field>
                      <Field label="USDC clearing bank account">
                        <select
                          name="bank"
                          className={control}
                          required
                          defaultValue={mapping?.value.bankAccountId}
                        >
                          <option value="">
                            Choose a clearing account
                          </option>
                          {catalog.data.items
                            .filter(
                              (item) =>
                                item.kind === "account" &&
                                item.active &&
                                item.type?.toLowerCase() === "bank",
                            )
                            .map((item) => (
                              <option key={item.id} value={item.id}>
                                {item.name} ·{" "}
                                {item.currency ?? connection.currency}
                              </option>
                            ))}
                        </select>
                      </Field>
                      {(
                        [
                          [
                            "journalClearing",
                            "Crypto journal account (optional)",
                            mapping?.value.journalClearingAccountId,
                          ],
                          [
                            "feeExpense",
                            "Network-fee account (optional)",
                            mapping?.value.feeExpenseAccountId,
                          ],
                          [
                            "fxAccount",
                            "FX account (optional)",
                            mapping?.value.fxAccountId,
                          ],
                        ] as const
                      ).map(([name, label, current]) => (
                        <Field key={name} label={label}>
                          <select
                            name={name}
                            className={control}
                            defaultValue={current ?? ""}
                          >
                            <option value="">Not enabled</option>
                            {catalog
                              .data!.items.filter(
                                (item) =>
                                  item.kind === "account" &&
                                  item.active &&
                                  item.type?.toLowerCase() !== "bank",
                              )
                              .map((item) => (
                                <option key={item.id} value={item.id}>
                                  {item.name} · {item.type}
                                </option>
                              ))}
                          </select>
                        </Field>
                      ))}
                      <Field label="Zero-tax or exempt code">
                        <select
                          name="tax"
                          className={control}
                          required
                          defaultValue={mapping?.value.taxCodeId}
                        >
                          <option value="">
                            Choose verified zero-tax code
                          </option>
                          {catalog.data.items
                            .filter(
                              (item) =>
                                item.kind === "tax" &&
                                item.active &&
                                item.zeroTax,
                            )
                            .map((item) => (
                              <option key={item.id} value={item.id}>
                                {item.name}
                              </option>
                            ))}
                        </select>
                      </Field>
                      <h3 className="mt-3 border-t pt-5 font-medium sm:col-span-2">{connection.currency} per USDC</h3>
                      <Field label="Rate numerator">
                        <input
                          name="numerator"
                          className={control}
                          required
                          pattern="[1-9][0-9]{0,17}"
                          defaultValue={mapping?.value.fxNumerator}
                          placeholder="Numerator"
                        />
                      </Field>
                      <Field label="Rate denominator">
                        <input
                          name="denominator"
                          className={control}
                          required
                          pattern="[1-9][0-9]{0,17}"
                          defaultValue={mapping?.value.fxDenominator}
                          placeholder="Denominator"
                        />
                      </Field>
                      <Field label="Rate source / approval">
                        <input
                          name="fxSource"
                          className={control}
                          required
                          minLength={3}
                          maxLength={300}
                          defaultValue={mapping?.value.fxSource}
                        />
                      </Field>
                      <Field label="Rate date">
                        <input
                          name="fxDate"
                          className={control}
                          type="date"
                          required
                          defaultValue={mapping?.value.fxDate}
                        />
                      </Field>
                      <Field label="Books closed through (optional)">
                        <input
                          name="closedThrough"
                          className={control}
                          type="date"
                          defaultValue={mapping?.value.closedThrough ?? ""}
                        />
                      </Field>
                      <div className="mt-3 grid min-w-0 grid-cols-1 gap-3 border-t pt-5 sm:col-span-2">
                        <p className="text-sm font-medium">
                          Payee contacts
                        </p>
                        {catalog.data.recipients.map((recipient) => (
                          <Field key={recipient.id} label={recipient.name}>
                            <select
                              name={`contact:${recipient.id}`}
                              className={control}
                              defaultValue={
                                mapping?.value.contacts.find(
                                  (item) => item.recipientId === recipient.id,
                                )?.externalId ?? ""
                              }
                            >
                              <option value="">Not mapped</option>
                              {catalog
                                .data!.items.filter(
                                  (item) =>
                                    item.kind === "contact" && item.active,
                                )
                                .map((item) => (
                                  <option key={item.id} value={item.id}>
                                    {item.name}
                                  </option>
                                ))}
                            </select>
                          </Field>
                        ))}
                      </div>
                      <label className="flex items-start gap-2 text-xs sm:col-span-2">
                        <input type="checkbox" required className="mt-1" />I
                        reviewed the company, accounts, tax treatment and exact FX rate.
                      </label>
                      <div>
                        <Action
                          busy={busy === "mapping"}
                          disabled={
                            !!busy || resource.refreshing || !!resource.error
                          }
                        >
                          Save mapping
                        </Action>
                      </div>
                    </form> : null}
    {connectionTask === "disconnect" && <><p className="text-sm text-muted-foreground">New posting work stops. Requests already sent may still complete.</p><Action type="button" className="justify-self-start" disabled={disabled} busy={busy === "disconnect"} onClick={() => void run("disconnect", async () => { const result = await api<{ note: string }>(`${endpoint}/connections/${selected}/disconnect`, {}); setNotice(result.note); closeTaskDrawer("accounting-connection-task", true); refresh(); })}>Disconnect app</Action></>}
  </>}{feedback}</div></TaskDrawer>
  <TaskDrawer id="accounting-posting-create" title="New posting"><div aria-busy={!!busy} className="grid gap-5">{connectionSelect}{connection?.status === "active" && mapping ?                   <form
                    key={`${selected}:${mapping?.version ?? 0}`}
                    aria-busy={!!busy}
                    className="grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-2"
                    onSubmit={(event) => {
                      event.preventDefault();
                      const values = new FormData(event.currentTarget);
                      void run("plan", async () => {
                        await api(`${endpoint}/connections/${selected}/plans`, {
                          kind,
                          sourceId: values.get("source"),
                          postingDate: values.get("date"),
                          ...(kind === "bill"
                            ? { dueDate: values.get("dueDate") }
                            : {}),
                          ...(kind === "fee"
                            ? { valuation: valuationFields(values) }
                            : {}),
                        });
                        setNotice(
                          "Posting prepared for review.",
                        );
                        closeTaskDrawer("accounting-posting-create", true);
                        refresh();
                      });
                    }}
                  >
                    <Field label="Record type">
                      <select
                        className={control}
                        value={kind}
                        onChange={(event) => {
                          setKind(event.target.value as typeof kind);
                          setSourceId("");
                        }}
                      >
                        <option value="bill">Company bill</option>
                        <option value="settlement">
                          Verified installment
                        </option>
                        <option value="credit">
                          Supplier credit
                        </option>
                        <option value="fee">
                          NEAR fee batch
                        </option>
                        <option value="fx">
                          Approved FX difference
                        </option>
                      </select>
                    </Field>
                    <Field label="Company record">
                      <select
                        key={kind}
                        name="source"
                        className={control}
                        value={sourceId}
                        onChange={(event) => setSourceId(event.target.value)}
                        required
                      >
                        <option value="">Choose a company record</option>
                        {(sources ?? []).map((item) => (
                          <option key={item.id} value={item.id}>
                            {item.label}
                          </option>
                        ))}
                      </select>
                    </Field>
                    {kind === "bill" && (
                      <Field
                        label="Invoice due date"

                      >
                        <input
                          key={`${sourceId}:${sourceBill?.dueDate ?? "manual"}`}
                          name="dueDate"
                          className={control}
                          type="date"
                          required
                          readOnly={!!sourceBill?.dueDate}
                          defaultValue={sourceBill?.dueDate ?? ""}
                        />
                      </Field>
                    )}
                    {kind === "fee" && (
                      <AccountingValuationFields asset="NEAR" />
                    )}
                    <Field label="Posting date">
                      <input
                        name="date"
                        className={control}
                        type="date"
                        required
                        defaultValue={new Date().toISOString().slice(0, 10)}
                      />
                    </Field>
                    <div className="flex items-end">
                      <Action
                        busy={busy === "plan"}
                        disabled={
                          !!busy || resource.refreshing || !!resource.error
                        }
                      >
                        Prepare posting
                      </Action>
                    </div>
                  </form> : <div className="grid gap-3"><p className="text-sm text-muted-foreground">Choose a connected company with reviewed account mapping.</p><button type="button" className="justify-self-start text-sm text-primary" onClick={() => { closeTaskDrawer("accounting-posting-create"); setView(1); }}>Manage connections</button></div>}{feedback}</div></TaskDrawer>
  <TaskDrawer id="accounting-posting-review" title="Review posting"><div aria-busy={!!busy} className="grid gap-5">{job && <div key={`${job.id}:${job.review_hash}`} className="grid gap-5"><header className="flex flex-wrap items-start justify-between gap-4"><div><h3 className="text-xl font-medium">{jobReference(job)}</h3><p className="mt-1 text-xs text-muted-foreground">{kindLabels[job.kind]}</p></div><Status value={job.state}/></header><div><p className="text-xs text-muted-foreground">Bookkeeping amount</p><p className="mt-1 text-2xl font-medium tabular-nums">{job.posting.amount?.text} <span className="text-sm text-muted-foreground">{job.posting.functionalCurrency}</span></p></div><dl className="grid gap-3 text-sm"><div className="flex justify-between gap-4"><dt className="text-muted-foreground">Company</dt><dd>{data?.connections.find(item => item.id === job.connection_id)?.entity_name ?? "Not available"}</dd></div><div className="flex justify-between gap-4"><dt className="text-muted-foreground">Posting date</dt><dd>{job.posting.source?.date}</dd></div>{job.kind === "bill" && <div className="flex justify-between gap-4"><dt className="text-muted-foreground">Due date</dt><dd>{job.posting.source?.dueDate}</dd></div>}</dl>{job.last_error && <p role="alert" className="text-sm text-destructive">{job.last_error}</p>}{job.state === "unknown" && <p className="text-sm text-amber-900">Outcome unconfirmed. Check the provider before any new write.</p>}<details className="border-t pt-4 text-xs"><summary className="cursor-pointer text-muted-foreground">Exact posting and shared data</summary><pre className="mt-3 max-h-96 overflow-auto rounded-xl bg-muted p-3">{JSON.stringify(job.posting, null, 2)}</pre><dl className="mt-4 grid gap-3 break-all text-muted-foreground"><div><dt>Source ID</dt><dd>{job.source_id}</dd></div><div><dt>Mapping version</dt><dd>{job.mapping_version}</dd></div><div><dt>Provider record</dt><dd>{job.external_id ?? "Not confirmed"}</dd></div><div><dt>Request marker</dt><dd>{job.marker}</dd></div></dl></details>                <div className="flex flex-wrap gap-3">
                  {canApprove && job.state === "review" && (
                    <Action
                      type="button"
                      disabled={
                        !!busy || resource.refreshing || !!resource.error
                      }
                      busy={busy === `approve:${job.id}`}
                      onClick={() =>
                        void run(`approve:${job.id}`, async () => {
                          await api(`${endpoint}/jobs/${job.id}/approve`, {
                            reviewHash: job.review_hash,
                          });
                          refresh();
                        })
                      }
                    >
                      Approve posting
                    </Action>
                  )}
                  {["done", "unknown", "held"].includes(job.state) && (
                    <Action
                      type="button"
                      disabled={
                        !!busy || resource.refreshing || !!resource.error
                      }
                      busy={busy === `reconcile:${job.id}`}
                      onClick={() =>
                        void run(`reconcile:${job.id}`, async () => {
                          await api(`${endpoint}/jobs/${job.id}/reconcile`, {});
                          setNotice(
                            "Provider status checked.",
                          );
                          refresh();
                        })
                      }
                    >
                      Check provider
                    </Action>
                  )}
                  {canApprove &&
                    job.state === "held" &&
                    !job.attempts &&
                    job.approved_by && (
                      <Action
                        type="button"
                        disabled={
                          !!busy || resource.refreshing || !!resource.error
                        }
                        onClick={() =>
                          void run(`retry:${job.id}`, async () => {
                            await api(
                              `${endpoint}/jobs/${job.id}/retry-preflight`,
                              {},
                            );
                            refresh();
                          })
                        }
                      >
                        Retry safe preflight
                      </Action>
                    )}
                  {canApprove && job.state === "held" && job.external_id && (
                    <Action
                      type="button"
                      disabled={
                        !!busy || resource.refreshing || !!resource.error
                      }
                      onClick={() =>
                        void run(`ack:${job.id}`, async () => {
                          await api(`${endpoint}/jobs/${job.id}/reconcile`, {
                            acknowledgeMatchingRevision: true,
                          });
                          setNotice(
                            "Matching revision reviewed. Conflicts remain held.",
                          );
                          refresh();
                        })
                      }
                    >
                      Accept matching revision
                    </Action>
                  )}
                </div></div>}{feedback}</div></TaskDrawer>
</div>;
}
