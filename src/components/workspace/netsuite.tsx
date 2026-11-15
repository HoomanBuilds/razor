"use client";

import { useState } from "react";
import { api } from "@/lib/api";
import { formatUnits } from "@/lib/money";
import type { netSuiteOverview } from "@/server/netsuite/service";
import {
  AccountingValuationFields,
  valuationFields,
} from "./accounting-ledger";
import { useWorkspace } from "./context";
import { useAction, useResource } from "./hooks";
import { TaskDrawer, openTaskDrawer, closeTaskDrawer } from "./task-drawer";
import { Action, Address, control, Empty, Field, Status } from "./shared";

type Overview = ReturnType<typeof netSuiteOverview>;
export function NetSuitePanel() {
  const { organization, base, revision, refresh } = useWorkspace();
  if (
    !["company:read", "company:manage", "payments:read", "reports:read"].every(
      (permission) => organization.permissions?.includes(permission),
    )
  )
    return null;
  return (
    <NetSuiteContent
      key={organization.id}
      endpoint={`${base}/netsuite`}
      revision={revision}
      refresh={refresh}
      canApprove={
        organization.permissions?.includes("payments:approve") === true
      }
    />
  );
}
function NetSuiteContent({
  endpoint,
  revision,
  refresh,
  canApprove,
}: {
  endpoint: string;
  revision: number;
  refresh: () => void;
  canApprove: boolean;
}) {
  const [page, setPage] = useState(1),
    [notice, setNotice] = useState(""),
    { busy, error, run, setError } = useAction(),
    resource = useResource<Overview>(`${endpoint}?page=${page}`, revision),
    data = resource.data,
    c = data?.connection,
    mapping = c?.mapping,
    catalog = c?.catalog,
    fresh = !busy && !resource.refreshing && !resource.error;
  const openTask = (id: string) => { setNotice(""); setError(""); openTaskDrawer(id); };
  const mutate = async (path: string, input: unknown, method?: "PUT") => {
    await api(endpoint + path, input, method);
    refresh();
  };
  return (
    <section aria-label="NetSuite" className="grid min-w-0 gap-5">
      <header className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-xl font-medium">NetSuite</h2><p className="mt-2 text-xs text-muted-foreground">Non-tax NEAR fee journals</p></div><Action type="button" disabled={!fresh} onClick={() => openTask("netsuite-connect")}>{c ? "Connection" : "Connect NetSuite"}</Action></header>
      <div className="grid min-w-0 gap-5">
        <TaskDrawer id="netsuite-connect" title={c ? "NetSuite connection" : "Connect NetSuite"}><div aria-busy={!!busy} className="grid gap-5">
        <form
          className="flex min-w-0 flex-wrap items-end gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            const values = new FormData(event.currentTarget);
            void run("connect", async () => {
              const result = await api<{ authorizationUrl: string }>(
                `${endpoint}/connect`,
                { accountId: values.get("accountId") },
              );
              window.location.assign(result.authorizationUrl);
            });
          }}
        >
          <Field label="NetSuite account ID">
            <input
              key={c?.account_domain ?? "new"}
              name="accountId"
              className={control}
              required
              minLength={3}
              maxLength={50}
              placeholder="1234567 or 1234567_SB1"
              defaultValue={c?.account_domain}
              readOnly={!!c && c.status !== "disabled"}
              disabled={!fresh}
            />
          </Field>
          <Action
            disabled={!fresh || !data?.configured}
            busy={busy === "connect"}
          >
            {c
              ? "Reauthorize account"
              : "Authorize connection"}
          </Action>
        </form>
        {data && !data.configured && <p role="status" className="text-sm text-amber-900">NetSuite integration is not configured.</p>}
        {c && <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-4"><Status value={c.status}/><button type="button" className="min-h-10 text-sm text-destructive" disabled={!fresh || c.status === "disabled"} onClick={() => void run("disconnect", async () => { const result = await api<{note:string}>(`${endpoint}/disconnect`, {}); setNotice(result.note); refresh(); })}>Disconnect</button></div>}
        <details className="border-t pt-4 text-xs"><summary className="cursor-pointer">Integration settings</summary><div className="mt-4 grid gap-3"><p className="text-muted-foreground">OAuth callback</p>{data?.redirectUri && <Address value={data.redirectUri} label="OAuth callback" full/>}<p className="text-muted-foreground">Company-owned OAuth integration with REST web services.</p></div></details>
        {(error || resource.error) && <p role="alert" className="text-sm text-destructive">{error || resource.error}</p>}{notice && <p role="status" className="text-sm">{notice}</p>}
        </div></TaskDrawer>
        {resource.loading ? (
          <Empty>Loading the company grant and journal history...</Empty>
        ) : c ? (
          <section className="grid min-w-0 gap-4 rounded-lg border p-4">
            <div className="flex flex-wrap items-center justify-between gap-3"><div><h3 className="text-base font-medium">{mapping?.subsidiaryName ?? "Connected account"}</h3><p className="mt-2 text-xs text-muted-foreground">{c.account_domain}{mapping ? ` · ${mapping.currencyCode}` : ""}</p></div><Status value={c.status}/></div>
            {c.last_error && (
              <p role="alert" className="text-sm text-destructive">
                {c.last_error}
              </p>
            )}
            {c.status === "active" && (
              <>
                <button type="button" className="w-fit min-h-10 text-sm text-primary" disabled={!fresh} onClick={() => openTask("netsuite-catalog")}>Import account catalog</button><TaskDrawer id="netsuite-catalog" title="Account catalog"><div aria-busy={!!busy} className="grid gap-5"><form
                  className="flex flex-wrap items-end gap-3"
                  onSubmit={(event) => {
                    event.preventDefault();
                    const values = new FormData(event.currentTarget);
                    void run("catalog", async () => {
                      await mutate("/catalog", {
                        page: Number(values.get("page")),
                      });
                      setNotice(
                        "Catalog imported.",
                      );
                    });
                  }}
                >
                  <Field label="Catalog page">
                    <input
                      name="page"
                      type="number"
                      min={1}
                      max={100}
                      step={1}
                      className={control}
                      required
                      defaultValue={1}
                      disabled={!fresh}
                    />
                  </Field>
                  <Action disabled={!fresh} busy={busy === "catalog"}>
                    Import catalog
                  </Action>
                </form>
                {catalog?.schemaError && (
                  <p role="status" className="rounded-lg border p-3 text-sm">
                    Journal writes held: {catalog.schemaError}
                  </p>
                )}
                {catalog?.taxReason && (
                  <p className="text-xs text-muted-foreground">
                    {catalog.taxReason}
                  </p>
                )}
                {catalog && (
                  <p className="text-xs">
                    Updated {new Date(catalog.observedAt).toLocaleString()}.{" "}
                    {catalog.records.length} catalog records retained.{" "}
                    {catalog.hasMore
                      ? "More pages may exist; load the next page for missing records."
                      : "This imported page reached its end."}{" "}

                  </p>
                )}
                {(error || resource.error) && <p role="alert" className="text-sm text-destructive">{error || resource.error}</p>}{notice && <p role="status" className="text-sm">{notice}</p>}</div></TaskDrawer>
                {canApprove && catalog?.schemaSupported && (
                  <><button type="button" className="w-fit min-h-10 text-sm text-primary" disabled={!fresh} onClick={() => openTask("netsuite-mapping")}>{mapping ? "Edit mappings" : "Configure mappings"}</button><TaskDrawer id="netsuite-mapping" title="Journal mappings"><div aria-busy={!!busy}>
                    <form
                      key={`${c.id}:${c.mapping_version}`}
                      className="grid min-w-0 gap-5 sm:grid-cols-2"
                      onSubmit={(event) => {
                        event.preventDefault();
                        const values = new FormData(event.currentTarget);
                        void run("mapping", async () => {
                          await mutate(
                            "/mapping",
                            {
                              expectedVersion: c.mapping_version,
                              subsidiaryId: values.get("subsidiary"),
                              currencyId: values.get("currency"),
                              expenseAccountId: values.get("expense"),
                              clearingAccountId: values.get("clearing"),
                              legalEntityReference: values.get(
                                "legalEntityReference",
                              ),
                              closedThrough:
                                values.get("closedThrough") || null,
                              nonTaxJournalAcknowledged: true,
                            },
                            "PUT",
                          );
                          setNotice(
                            "Journal mappings saved.",
                          );
                          closeTaskDrawer("netsuite-mapping", true);
                        });
                      }}
                    >
                      <fieldset className="contents" disabled={!fresh}>
                        {(
                          [
                            [
                              "subsidiary",
                              "Legal subsidiary",
                              "subsidiary",
                              mapping?.subsidiaryId,
                            ],
                            [
                              "currency",
                              "Base currency",
                              "currency",
                              mapping?.currencyId,
                            ],
                            [
                              "expense",
                              "Expense account",
                              "account",
                              mapping?.expenseAccountId,
                            ],
                            [
                              "clearing",
                              "Nonbank crypto asset account",
                              "account",
                              mapping?.clearingAccountId,
                            ],
                          ] as const
                        ).map(([name, label, kind, current]) => (
                          <Field key={name} label={label}>
                            <select
                              name={name}
                              className={control}
                              required
                              defaultValue={current ?? ""}
                            >
                              <option value="">
                                Choose an account record
                              </option>
                              {catalog.records
                                .filter((item) => item.kind === kind)
                                .map((item) => (
                                  <option key={item.id} value={item.id}>
                                    {item.name}
                                  </option>
                                ))}
                            </select>
                          </Field>
                        ))}
                        <Field label="Legal entity reference">
                          <input
                            name="legalEntityReference"
                            className={control}
                            required
                            minLength={3}
                            maxLength={300}
                            defaultValue={mapping?.legalEntityReference}
                          />
                        </Field>
                        <Field label="Books closed through (optional)">
                          <input
                            name="closedThrough"
                            className={control}
                            type="date"
                            defaultValue={mapping?.closedThrough ?? ""}
                          />
                        </Field>
                        <label className="flex items-start gap-2 text-xs sm:col-span-2">
                          <input type="checkbox" required />I confirm the legal entity, base currency and distinct eligible accounts for non-tax fee journals.
                        </label>
                        <div>
                          <Action disabled={!fresh} busy={busy === "mapping"}>
                            Save mappings
                          </Action>
                        </div>
                      </fieldset>
                    </form>{(error || resource.error) && <p role="alert" className="mt-4 text-sm text-destructive">{error || resource.error}</p>}</div></TaskDrawer></>
                )}
                {mapping && (
                  <>
                    <Action type="button" className="justify-self-start" disabled={!fresh} onClick={() => openTask("netsuite-journal-create")}>New fee journal</Action><TaskDrawer id="netsuite-journal-create" title="New fee journal" description={`${mapping.subsidiaryName} · ${mapping.currencyCode}`}><div aria-busy={!!busy}>
                    <form
                      className="grid min-w-0 gap-5 sm:grid-cols-2"
                      onSubmit={(event) => {
                        event.preventDefault();
                        const values = new FormData(event.currentTarget);
                        void run("preview", async () => {
                          await mutate("/journals", {
                            sourceId: values.get("sourceId"),
                            postingDate: values.get("postingDate"),
                            valuation: valuationFields(values),
                            nonTaxJournalAcknowledged: true,
                          });
                          setNotice(
                            "Journal draft prepared for approval.",
                          );
                          closeTaskDrawer("netsuite-journal-create", true);
                        });
                      }}
                    >
                      <fieldset className="contents" disabled={!fresh}>
                        <Field label="Verified NEAR fee group">
                          <select name="sourceId" className={control} required>
                            <option value="">Choose a fee group</option>
                            {data!.feeGroups
                              .filter((value) => value.network === "mainnet")
                              .map((value) => (
                                <option key={value.id} value={value.id}>
                                  {formatUnits(value.amount_atomic, 24)} NEAR · {new Date(value.created_at).toLocaleString()}
                                </option>
                              ))}
                          </select>
                        </Field>
                        <Field label="Journal posting date">
                          <input
                            name="postingDate"
                            className={control}
                            type="date"
                            required
                            max={new Date().toISOString().slice(0, 10)}
                            defaultValue={new Date().toISOString().slice(0, 10)}
                          />
                        </Field>
                        <AccountingValuationFields asset="NEAR" />
                        <label className="flex gap-2 text-xs sm:col-span-2">
                          <input type="checkbox" required />
                          I reviewed this non-tax fee expense, its independent valuation and rounding policy. Native fees and fractional-cent residuals stay recorded.
                        </label>
                        <div>
                          <Action disabled={!fresh} busy={busy === "preview"}>
                            Prepare journal
                          </Action>
                        </div>
                      </fieldset>
                    </form>
                    {(error || resource.error) && <p role="alert" className="mt-4 text-sm text-destructive">{error || resource.error}</p>}</div></TaskDrawer>
                  </>
                )}
              </>
            )}
          </section>
        ) : !resource.error ? (
          <Empty>No NetSuite account connected.</Empty>
        ) : null}
        <section className="grid min-w-0 gap-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h3 className="text-sm font-semibold">
              Fee journals
            </h3>
            {canApprove && (
              <Action
                type="button"
                disabled={!fresh || c?.status !== "active"}
                onClick={() =>
                  void run("dispatch", async () => {
                    await mutate("/dispatch", {});
                    setNotice(
                      "One approved journal processed.",
                    );
                  })
                }
              >
                Process approved journal
              </Action>
            )}
          </div>
          {resource.loading ? <Empty>Loading journals...</Empty> : !data?.jobs.length && !resource.error ? (
            <Empty>No NetSuite journal requests on this page.</Empty>
          ) : (
            data?.jobs.map((value) => (
              <div key={value.id}><button type="button" className="flex w-full items-center justify-between gap-4 border-b py-4 text-left" disabled={!fresh} onClick={() => openTask(`netsuite-journal-${value.id}`)}><span className="min-w-0"><span className="block text-sm font-medium">NEAR fees · {value.posting.payload.tranDate}</span><span className="mt-2 block text-xs text-muted-foreground">{value.posting.mapping.subsidiaryName}</span></span><span className="text-right"><span className="mb-2 block font-medium tabular-nums">{value.posting.valuation.text} {value.posting.mapping.currencyCode}</span><Status value={value.state}/></span></button><TaskDrawer id={`netsuite-journal-${value.id}`} title="NEAR fee journal" description={`${value.posting.mapping.subsidiaryName} · ${value.posting.payload.tranDate}`}><article aria-busy={!!busy} className="grid min-w-0 gap-5">
                <div className="flex flex-wrap items-start justify-between gap-3"><p className="text-3xl font-medium tabular-nums">{value.posting.valuation.text} <span className="text-sm">{value.posting.mapping.currencyCode}</span></p><Status value={value.state}/></div>
                <dl className="grid gap-4 sm:grid-cols-2"><div><dt className="text-xs text-muted-foreground">Verified native fee</dt><dd className="mt-2 break-all text-sm tabular-nums">{formatUnits(value.posting.source.amountAtomic, 24)} NEAR</dd></div><div><dt className="text-xs text-muted-foreground">Valuation rate</dt><dd className="mt-2 break-all text-sm">{value.posting.valuation.valuation.numerator}/{value.posting.valuation.valuation.denominator} {value.posting.mapping.currencyCode}/NEAR</dd></div><div><dt className="text-xs text-muted-foreground">Rate source & date</dt><dd className="mt-2 break-words text-sm">{value.posting.valuation.valuation.source} · {value.posting.valuation.valuation.date}</dd></div><div><dt className="text-xs text-muted-foreground">Rounding</dt><dd className="mt-2 text-sm">{value.posting.valuation.valuation.rounding === "exact" ? "Exact cents" : "Half even to cent"}</dd></div></dl>
                <dl className="grid gap-4 sm:grid-cols-2"><div><dt className="text-xs text-muted-foreground">Debit expense account</dt><dd className="mt-2 text-sm">{catalog?.records.find(record => record.kind === "account" && record.id === value.posting.mapping.expenseAccountId)?.name ?? value.posting.mapping.expenseAccountId}</dd></div><div><dt className="text-xs text-muted-foreground">Credit crypto asset account</dt><dd className="mt-2 text-sm">{catalog?.records.find(record => record.kind === "account" && record.id === value.posting.mapping.clearingAccountId)?.name ?? value.posting.mapping.clearingAccountId}</dd></div></dl>
                <p className="text-xs text-muted-foreground">Non-tax expense journal. No cash credit or payment delivery.</p>
                {value.last_error && (
                  <p role="alert" className="text-sm text-destructive">
                    {value.last_error}. An unknown original write never
                    authorizes a replacement or another automatic attempt.
                  </p>
                )}
                <details>
                  <summary className="cursor-pointer text-sm">
                    Accounts, source & exact disclosure
                  </summary>
                  <dl className="mt-4 grid gap-4 text-xs"><div><dt className="text-muted-foreground">Original external ID</dt><dd className="mt-2"><Address value={value.external_id} label="external ID" full/></dd></div><div><dt className="text-muted-foreground">Provider record</dt><dd className="mt-2">{value.provider_id ? <Address value={value.provider_id} label="provider ID"/> : "Not confirmed"}</dd></div><div><dt className="text-muted-foreground">Source fee group</dt><dd className="mt-2"><Address value={value.source_id} label="fee group ID"/></dd></div><div><dt className="text-muted-foreground">Write attempts</dt><dd className="mt-2">{value.attempts}</dd></div></dl>
                  <pre className="mt-3 max-h-96 overflow-auto rounded-lg bg-muted p-3 text-xs">
                    {JSON.stringify(value.posting, null, 2)}
                  </pre>
                  <p className="mt-2 break-all text-xs">
                    Review expires{" "}
                    {new Date(value.posting.reviewExpiresAt).toLocaleString()}.
                    Fresh review SHA-256: {value.review_hash}
                  </p>
                </details>
                {value.observation && (
                  <details>
                    <summary className="cursor-pointer text-sm">
                      Provider observation
                    </summary>
                    <pre className="mt-3 max-h-96 overflow-auto rounded-lg bg-muted p-3 text-xs">
                      {JSON.stringify(value.observation.record, null, 2)}
                    </pre>
                    <p className="mt-2 break-all text-xs">
                      Observed provider SHA-256: {value.observation.hash}. This
                      is company-scoped bookkeeping data, not proof of cash or
                      payment delivery.
                    </p>
                  </details>
                )}
                <div className="flex flex-wrap gap-3">
                  {canApprove && value.state === "review" && (
                    <Action
                      type="button"
                      disabled={
                        !fresh ||
                        value.posting.reviewExpiresAt <=
                          new Date().toISOString()
                      }
                      onClick={() =>
                        void run(`approve:${value.id}`, async () => {
                          await mutate(`/journals/${value.id}/approve`, {
                            reviewHash: value.review_hash,
                            disclosureAcknowledged: true,
                          });
                          setNotice(
                            "Journal approved and queued.",
                          );
                        })
                      }
                    >
                      Approve journal
                    </Action>
                  )}
                  {canApprove &&
                    !value.approved_by &&
                    !value.attempts &&
                    ["review", "held"].includes(value.state) && (
                      <Action
                        type="button"
                        disabled={!fresh}
                        onClick={() =>
                          void run(`cancel:${value.id}`, async () => {
                            await mutate(`/journals/${value.id}/cancel`, {});
                            setNotice(
                              "Unapproved journal retired.",
                            );
                          })
                        }
                      >
                        Retire draft
                      </Action>
                    )}
                  {["done", "unknown", "held"].includes(value.state) && (
                    <Action
                      type="button"
                      disabled={!fresh || c?.status !== "active"}
                      onClick={() =>
                        void run(`reconcile:${value.id}`, async () => {
                          await mutate(`/journals/${value.id}/reconcile`, {});
                          setNotice(
                            "Original journal status reconciled.",
                          );
                        })
                      }
                    >
                      Reconcile original journal
                    </Action>
                  )}
                  {canApprove &&
                    value.last_error ===
                      "EXTERNAL_REVISION_REVIEW_REQUIRED" && (
                      <Action
                        type="button"
                        disabled={!fresh || c?.status !== "active" || !value.observation}
                        onClick={() =>
                          void run(`revision:${value.id}`, async () => {
                            await mutate(`/journals/${value.id}/reconcile`, {
                              acknowledgeMatchingRevision: true,
                              expectedProviderHash: value.observation?.hash,
                            });
                            setNotice(
                              "Matching provider revision acknowledged.",
                            );
                          })
                        }
                      >
                        Accept matching revision
                      </Action>
                    )}
                </div>
                {(error || resource.error) && <p role="alert" className="text-sm text-destructive">{error || resource.error}</p>}{notice && <p role="status" className="text-sm">{notice}</p>}
              </article></TaskDrawer></div>
            ))
          )}
          {(page > 1 || data?.hasMore) && <div className="flex flex-wrap items-center justify-between gap-3">
            <Action
              type="button"
              disabled={!fresh || page === 1}
              onClick={() => setPage((value) => value - 1)}
            >
              Previous
            </Action>
            <span className="text-xs">Page {page}</span>
            <Action
              type="button"
              disabled={!fresh || !data?.hasMore}
              onClick={() => setPage((value) => value + 1)}
            >
              Next
            </Action>
          </div>}
        </section>
        {notice && (
          <p role="status" className="text-sm">
            {notice}
          </p>
        )}
        {(error || resource.error) && (
          <p role="alert" className="text-sm text-destructive">
            {error || resource.error}
          </p>
        )}
      </div>
    </section>
  );
}
