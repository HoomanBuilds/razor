"use client";

import { useState } from "react";
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
  DataTable,
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
  const { busy, error, run } = useAction(),
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
                  label: `${signedCents(item.terms.differenceCents)} ${connection?.currency ?? "functional units"} · ${item.id}`,
                }));
  const sourceBill =
    kind === "bill" ? data?.bills.find((item) => item.id === sourceId) : null;
  if (!allowed) return null;
  return (
    <Panel
      title="Accounting connections"
      description="Connect your own QuickBooks or Xero company, review mappings and approve exact bookkeeping requests. These APIs record accounting entries and do not move bank or crypto funds."
    >
      <div className="grid min-w-0 grid-cols-1 gap-6">
        <p className="text-xs leading-5 text-muted-foreground">
          {data?.scope ??
            "The operator configures a confidential accounting app before consent is available. Missing credentials never appear as a completed connection."}{" "}
          Exported bill titles and chosen payee contacts are disclosed to your
          accounting provider only after posting review.
        </p>
        <div className="flex flex-wrap gap-3">
          {data?.providers.map((provider) => (
            <div
              key={provider.provider}
              className="grid min-w-0 gap-2 rounded-lg border p-3 text-sm"
            >
              <strong>
                {provider.provider === "quickbooks"
                  ? "QuickBooks Online"
                  : "Xero"}
              </strong>
              <p className="text-xs text-muted-foreground">
                {provider.environment}
                {!provider.configured
                  ? " · Operator setup required"
                  : " · Company consent required"}
              </p>
              <Action
                type="button"
                disabled={!!busy || !provider.configured}
                busy={busy === provider.provider}
                onClick={() =>
                  void run(provider.provider, async () => {
                    const result = await api<{ authorizationUrl: string }>(
                      `${endpoint}/connect/${provider.provider}`,
                      {},
                    );
                    window.location.assign(result.authorizationUrl);
                  })
                }
              >
                Authorize company connection
              </Action>
            </div>
          ))}
        </div>
        {resource.loading ? (
          <Empty>Loading accounting connections...</Empty>
        ) : !data?.connections.length ? (
          <Empty>No company accounting connection has been authorized.</Empty>
        ) : (
          <Field label="Accounting connection">
            <select
              className={control}
              value={selected}
              onChange={(event) => {
                setSelected(event.target.value);
                setCatalogPage(1);
                setNotice("");
              }}
            >
              <option value="">Choose a connection</option>
              {data.connections.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.provider} · {item.entity_name ?? "Select legal entity"}{" "}
                  · {item.status}
                </option>
              ))}
            </select>
          </Field>
        )}
        {connection && (
          <div className="grid min-w-0 grid-cols-1 gap-4 rounded-lg border p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm font-medium">
                {connection.entity_name ?? "Company selection"}{" "}
                <Status value={connection.status} />
              </p>
              <Action
                type="button"
                disabled={!!busy || resource.refreshing || !!resource.error}
                busy={busy === "disconnect"}
                onClick={() =>
                  void run("disconnect", async () => {
                    const result = await api<{ note: string }>(
                      `${endpoint}/connections/${selected}/disconnect`,
                      {},
                    );
                    setNotice(result.note);
                    refresh();
                  })
                }
              >
                Disconnect and stop future work
              </Action>
            </div>
            {connection.last_error && (
              <p role="alert" className="text-sm text-destructive">
                {connection.last_error}. Review provider access and reconnect if
                needed. Sent requests may still complete after disconnection.
              </p>
            )}
            {connection.status === "select_entity" && (
              <form
                className="flex min-w-0 flex-wrap items-end gap-3"
                onSubmit={(event) => {
                  event.preventDefault();
                  const values = new FormData(event.currentTarget);
                  void run("entity", async () => {
                    await api(`${endpoint}/connections/${selected}/entity`, {
                      entityId: values.get("entity"),
                    });
                    setNotice(
                      "Verified legal entity selected. Review the actual chart of accounts and FX mapping next.",
                    );
                    refresh();
                  });
                }}
              >
                <div className="min-w-0 flex-1">
                  <Field label="Verified legal entity">
                    <select name="entity" required className={control}>
                      <option value="">Select explicitly</option>
                      {connection.entities.map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.name} · {item.id}
                        </option>
                      ))}
                    </select>
                  </Field>
                </div>
                <Action
                  busy={busy === "entity"}
                  disabled={!!busy || resource.refreshing || !!resource.error}
                >
                  Use this company
                </Action>
              </form>
            )}
            {connection.status === "active" && (
              <>
                <p className="text-sm">
                  Functional currency: <strong>{connection.currency}</strong>.
                  USDC conversion needs an accountant-reviewed rate. No peg or
                  current FX rate is assumed.
                </p>
                <form
                  className="flex min-w-0 flex-wrap items-end gap-3"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void run("catalog", async () => {
                      const result = await api<{ mayHaveMore: boolean }>(
                        `${endpoint}/connections/${selected}/catalog`,
                        { page: catalogPage },
                      );
                      setNotice(
                        result.mayHaveMore
                          ? "Catalog page loaded. Load the next page if a required record is missing."
                          : "Catalog page loaded. Review active accounts, contacts and zero-tax codes.",
                      );
                      refresh();
                    });
                  }}
                >
                  <Field label="Provider catalog page">
                    <input
                      type="number"
                      min={1}
                      max={100}
                      className={control}
                      value={catalogPage}
                      onChange={(event) =>
                        setCatalogPage(Number(event.target.value))
                      }
                    />
                  </Field>
                  <Action
                    busy={busy === "catalog"}
                    disabled={!!busy || resource.refreshing || !!resource.error}
                  >
                    Load accounts, contacts and tax codes
                  </Action>
                </form>
                {canApprove && catalog.data?.items.length ? (
                  <details className="min-w-0 rounded-lg border p-3">
                    <summary className="cursor-pointer text-sm font-medium">
                      Review account, contact and FX mappings
                    </summary>
                    <form
                      key={`${selected}:${mapping?.version ?? 0}`}
                      className="mt-4 grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-2"
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
                            "Mapping version saved. Previously prepared requests require fresh review.",
                          );
                          refresh();
                        });
                      }}
                    >
                      <Field label="Expense account">
                        <select
                          name="expense"
                          className={control}
                          required
                          defaultValue={mapping?.value.expenseAccountId}
                        >
                          <option value="">
                            Choose actual provider account
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
                      <Field label="Bookkeeping clearing bank account">
                        <select
                          name="bank"
                          className={control}
                          required
                          defaultValue={mapping?.value.bankAccountId}
                        >
                          <option value="">
                            Choose the USDC clearing account in your books
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
                            "Nonbank crypto journal clearing account",
                            mapping?.value.journalClearingAccountId,
                          ],
                          [
                            "feeExpense",
                            "Actual network-fee expense account",
                            mapping?.value.feeExpenseAccountId,
                          ],
                          [
                            "fxAccount",
                            "FX difference account",
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
                      <Field label="Functional units per USDC: numerator">
                        <input
                          name="numerator"
                          className={control}
                          required
                          pattern="[1-9][0-9]{0,17}"
                          defaultValue={mapping?.value.fxNumerator}
                          placeholder="Reviewed integer numerator"
                        />
                      </Field>
                      <Field label="Functional units per USDC: denominator">
                        <input
                          name="denominator"
                          className={control}
                          required
                          pattern="[1-9][0-9]{0,17}"
                          defaultValue={mapping?.value.fxDenominator}
                          placeholder="Reviewed integer denominator"
                        />
                      </Field>
                      <Field label="Rate source and approval reference">
                        <input
                          name="fxSource"
                          className={control}
                          required
                          minLength={3}
                          maxLength={300}
                          defaultValue={mapping?.value.fxSource}
                        />
                      </Field>
                      <Field label="Reviewed FX date">
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
                      <div className="grid min-w-0 grid-cols-1 gap-3 sm:col-span-2">
                        <p className="text-sm font-medium">
                          Original company payees and accounting contacts
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
                        reviewed the legal entity, clearing account, zero-tax
                        treatment and exact FX rate. These entries record
                        bookkeeping and do not prove bank settlement.
                      </label>
                      <div>
                        <Action
                          busy={busy === "mapping"}
                          disabled={
                            !!busy || resource.refreshing || !!resource.error
                          }
                        >
                          Save reviewed mapping version
                        </Action>
                      </div>
                    </form>
                  </details>
                ) : (
                  <Empty>
                    Load the actual provider catalogs before mapping. An
                    authorized finance approver reviews mappings.
                  </Empty>
                )}
                {mapping && (
                  <form
                    className="grid min-w-0 grid-cols-1 gap-3 rounded-lg border p-3 sm:grid-cols-2"
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
                          "Exact posting plan prepared. Review it below before approving any provider write.",
                        );
                        refresh();
                      });
                    }}
                  >
                    <Field label="Record to prepare">
                      <select
                        className={control}
                        value={kind}
                        onChange={(event) => {
                          setKind(event.target.value as typeof kind);
                          setSourceId("");
                        }}
                      >
                        <option value="bill">Accepted company bill</option>
                        <option value="settlement">
                          Verified full or terminal partial payment
                        </option>
                        <option value="credit">
                          Accepted supplier credit, unapplied provider draft
                        </option>
                        <option value="fee">
                          Grouped exact NEAR token-burn fees
                        </option>
                        <option value="fx">
                          Approved crypto-clearing FX difference
                        </option>
                      </select>
                    </Field>
                    <Field label="Original record">
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
                        label="Invoice maturity date"
                        hint={
                          sourceBill?.dueDate
                            ? "Original invoice maturity in the company timezone. Resolve changes in the original bill before posting."
                            : "This source has no scheduled maturity. Explicitly choose the due date for the accounting record; no default is assumed."
                        }
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
                        Prepare bookkeeping review
                      </Action>
                    </div>
                  </form>
                )}
              </>
            )}
          </div>
        )}
        {data && (
          <AccountingLedgerTools
            endpoint={endpoint}
            data={data}
            connectionId={selected}
            canApprove={canApprove}
            disabled={!!busy || resource.refreshing || !!resource.error}
            onChange={refresh}
          />
        )}
        <div className="grid min-w-0 grid-cols-1 gap-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h3 className="text-sm font-medium">
              Posting requests and recovery
            </h3>
            {canApprove && (
              <Action
                type="button"
                disabled={!!busy || resource.refreshing || !!resource.error}
                busy={busy === "dispatch"}
                onClick={() =>
                  void run("dispatch", async () => {
                    await api(`${endpoint}/dispatch`, {});
                    setNotice(
                      "One approved request processed. Review its actual provider status below.",
                    );
                    refresh();
                  })
                }
              >
                Process one approved request
              </Action>
            )}
          </div>
          {!data?.jobs.length ? (
            <Empty>No posting plans on this page.</Empty>
          ) : (
            data.jobs.map((job) => (
              <article
                key={job.id}
                className="grid min-w-0 grid-cols-1 gap-3 rounded-lg border p-4"
              >
                <div className="flex flex-wrap justify-between gap-3">
                  <p className="text-sm font-medium">
                    {job.kind} · {job.marker}
                  </p>
                  <Status value={job.state} />
                </div>
                <p className="break-all text-xs">
                  Source {job.source_id}. Mapping {job.mapping_version}.
                  Provider record {job.external_id ?? "not confirmed"}.
                </p>
                {job.last_error && (
                  <p role="alert" className="text-xs text-destructive">
                    {job.last_error}. An unknown result does not authorize
                    another write.
                  </p>
                )}
                <details className="min-w-0">
                  <summary className="cursor-pointer text-sm">
                    Inspect exact disclosure and accounting terms
                  </summary>
                  <pre className="mt-3 max-h-96 overflow-auto rounded-lg bg-muted p-3 text-xs">
                    {JSON.stringify(job.posting, null, 2)}
                  </pre>
                </details>
                <div className="flex flex-wrap gap-3">
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
                      Approve this exact posting
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
                            "Read-only provider lookup completed. Missing results remain held and are never automatically re-posted.",
                          );
                          refresh();
                        })
                      }
                    >
                      Read provider record
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
                            "A matching external revision was reviewed. Financially conflicting values stay held.",
                          );
                          refresh();
                        })
                      }
                    >
                      Review matching external revision
                    </Action>
                  )}
                </div>
              </article>
            ))
          )}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <Action
              type="button"
              disabled={page === 1}
              onClick={() => setPage((value) => value - 1)}
            >
              Previous requests
            </Action>
            <span className="text-xs">Page {page}</span>
            <Action
              type="button"
              disabled={!data?.hasMore}
              onClick={() => setPage((value) => value + 1)}
            >
              Next requests
            </Action>
          </div>
        </div>
        {data?.observations.length ? (
          <DataTable
            columns={["Provider record", "Observed revision", "Reconciliation"]}
          >
            {data.observations.map((item) => (
              <tr key={`${item.kind}:${item.external_id}`}>
                <td className="break-all text-xs">
                  {item.kind} · {item.external_id}
                </td>
                <td className="break-all text-xs">
                  {item.revision || "Not supplied"}
                </td>
                <td>
                  <Status value={item.state} />
                  <p className="text-xs">
                    Provider observations do not mutate the Razor financial
                    ledger.
                  </p>
                </td>
              </tr>
            ))}
          </DataTable>
        ) : null}
        {notice && (
          <p role="status" className="text-sm">
            {notice}
          </p>
        )}
        {(resource.error || catalog.error || error) && (
          <p role="alert" className="text-sm text-destructive">
            {resource.error || catalog.error || error}
          </p>
        )}
      </div>
    </Panel>
  );
}
