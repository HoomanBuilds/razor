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
import { Action, control, Empty, Field, Panel, Status } from "./shared";

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
    { busy, error, run } = useAction(),
    resource = useResource<Overview>(`${endpoint}?page=${page}`, revision),
    data = resource.data,
    c = data?.connection,
    mapping = c?.mapping,
    catalog = c?.catalog,
    fresh = !busy && !resource.refreshing && !resource.error;
  const mutate = async (path: string, input: unknown, method?: "PUT") => {
    await api(endpoint + path, input, method);
    refresh();
  };
  return (
    <Panel
      title="NetSuite journal connection"
      description="A separate company-owned NetSuite OAuth connection for a narrow, explicitly reviewed non-tax crypto-fee journal. Provider bookkeeping never creates Razor cash or payment delivery."
    >
      <div className="grid min-w-0 gap-5">
        <p className="text-xs leading-5 text-muted-foreground">
          {data?.scope ?? "Loading the current supported NetSuite scope..."} The
          operator needs a confidential NetSuite integration with REST web
          services and this exact callback registered. Credentials stay on the
          server and are never entered here.
        </p>
        <p className="break-all text-xs">
          Callback: {data?.redirectUri ?? "Loading configuration..."}
        </p>
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
          <Field label="Exact NetSuite account ID">
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
              ? "Reauthorize this original account"
              : "Authorize company NetSuite access"}
          </Action>
        </form>
        {data && !data.configured && (
          <p role="status" className="text-sm">
            Operator setup required: NETSUITE_CLIENT_ID and
            NETSUITE_CLIENT_SECRET. The connector will not simulate consent or a
            completed post.
          </p>
        )}
        {resource.loading ? (
          <Empty>Loading the company grant and journal history...</Empty>
        ) : c ? (
          <section className="grid min-w-0 gap-4 rounded-lg border p-4">
            <div className="flex flex-wrap justify-between gap-3">
              <p className="text-sm font-medium">
                {c.account_domain} · <Status value={c.status} />
              </p>
              <Action
                type="button"
                disabled={!fresh || c.status === "disabled"}
                onClick={() =>
                  void run("disconnect", async () => {
                    const result = await api<{ note: string }>(
                      `${endpoint}/disconnect`,
                      {},
                    );
                    setNotice(result.note);
                    refresh();
                  })
                }
              >
                Revoke access and stop future work
              </Action>
            </div>
            {c.last_error && (
              <p role="alert" className="text-sm text-destructive">
                {c.last_error}. Existing sent or unknown requests keep their
                original external IDs for read-only reconciliation.
              </p>
            )}
            {c.status === "active" && (
              <>
                <form
                  className="flex flex-wrap items-end gap-3"
                  onSubmit={(event) => {
                    event.preventDefault();
                    const values = new FormData(event.currentTarget);
                    void run("catalog", async () => {
                      await mutate("/catalog", {
                        page: Number(values.get("page")),
                      });
                      setNotice(
                        "Actual metadata and catalog page loaded. Unsupported required/custom/tax schema stays held; no journal was posted.",
                      );
                    });
                  }}
                >
                  <Field label="Actual NetSuite catalog page">
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
                    Read schema, subsidiary, accounts, currency and tax
                    availability
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
                    Observed {new Date(catalog.observedAt).toLocaleString()}.{" "}
                    {catalog.records.length} catalog records retained.{" "}
                    {catalog.hasMore
                      ? "More pages may exist; load the next page for missing records."
                      : "This imported page reached its end."}{" "}
                    Required custom fields and tax-bearing operations cannot be
                    supplied as arbitrary JSON.
                  </p>
                )}
                {canApprove && catalog?.schemaSupported && (
                  <details>
                    <summary className="cursor-pointer text-sm font-medium">
                      Review exact legal-entity and non-tax journal mappings
                    </summary>
                    <form
                      key={`${c.id}:${c.mapping_version}`}
                      className="mt-4 grid min-w-0 gap-3 sm:grid-cols-2"
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
                            "Live base-currency, subsidiary and directly assigned account mapping reviewed. Every future write rechecks its exact schema and original fee source.",
                          );
                        });
                      }}
                    >
                      <fieldset className="contents" disabled={!fresh}>
                        {(
                          [
                            [
                              "subsidiary",
                              "Actual OneWorld legal subsidiary",
                              "subsidiary",
                              mapping?.subsidiaryId,
                            ],
                            [
                              "currency",
                              "Actual subsidiary base currency",
                              "currency",
                              mapping?.currencyId,
                            ],
                            [
                              "expense",
                              "Directly assigned active expense account",
                              "account",
                              mapping?.expenseAccountId,
                            ],
                            [
                              "clearing",
                              "Directly assigned nonbank crypto asset account",
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
                                Choose an actual imported record
                              </option>
                              {catalog.records
                                .filter((item) => item.kind === kind)
                                .map((item) => (
                                  <option key={item.id} value={item.id}>
                                    {item.name} · {item.id}
                                  </option>
                                ))}
                            </select>
                          </Field>
                        ))}
                        <Field label="Company legal-entity mapping reference">
                          <input
                            name="legalEntityReference"
                            className={control}
                            required
                            minLength={3}
                            maxLength={300}
                            defaultValue={mapping?.legalEntityReference}
                          />
                        </Field>
                        <Field label="Books closed through, optional">
                          <input
                            name="closedThrough"
                            className={control}
                            type="date"
                            defaultValue={mapping?.closedThrough ?? ""}
                          />
                        </Field>
                        <label className="flex items-start gap-2 text-xs sm:col-span-2">
                          <input type="checkbox" required />I reviewed the
                          actual legal entity and base currency. These are
                          non-tax crypto-fee entries using distinct eligible
                          expense and nonbank asset accounts. Tax, bank,
                          control, summary and unknown required/custom fields
                          are outside this operation.
                        </label>
                        <div>
                          <Action disabled={!fresh} busy={busy === "mapping"}>
                            Save live reviewed mapping
                          </Action>
                        </div>
                      </fieldset>
                    </form>
                  </details>
                )}
                {mapping && (
                  <>
                    <p className="text-sm">
                      Mapped legal entity: {mapping.subsidiaryName} · Base
                      currency {mapping.currencyCode}. Mapping version{" "}
                      {c.mapping_version}. Account and schema changes require
                      fresh review.
                    </p>
                    <form
                      className="grid min-w-0 gap-3 rounded-lg border p-4 sm:grid-cols-2"
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
                            "Exact structured journal prepared for a separate fresh approval. No provider write or transfer occurred.",
                          );
                        });
                      }}
                    >
                      <fieldset className="contents" disabled={!fresh}>
                        <Field label="Existing verified mainnet NEAR fee group">
                          <select name="sourceId" className={control} required>
                            <option value="">Choose an exact fee group</option>
                            {data!.feeGroups
                              .filter((value) => value.network === "mainnet")
                              .map((value) => (
                                <option key={value.id} value={value.id}>
                                  {formatUnits(value.amount_atomic, 24)} NEAR ·{" "}
                                  {value.id}
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
                          Prepare this exact non-tax fee expense only. I
                          reviewed its independently sourced valuation and
                          rounding policy. Actual native NEAR and any
                          functional-cent residual remain recorded; no peg or
                          provider FX execution is assumed.
                        </label>
                        <div>
                          <Action disabled={!fresh} busy={busy === "preview"}>
                            Prepare exact non-tax journal review
                          </Action>
                        </div>
                      </fieldset>
                    </form>
                    <p className="text-xs text-muted-foreground">
                      Capture and group final verified NEAR fees in the crypto
                      ledger tools first. A fee stays unique across NetSuite
                      requests even if its company group is later released or
                      rebuilt.
                    </p>
                  </>
                )}
              </>
            )}
          </section>
        ) : (
          <Empty>
            No company NetSuite grant. Connecting and reading metadata never
            creates a journal or moves funds.
          </Empty>
        )}
        <section className="grid min-w-0 gap-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h3 className="text-sm font-semibold">
              Exact journals and original-write recovery
            </h3>
            {canApprove && (
              <Action
                type="button"
                disabled={!fresh || c?.status !== "active"}
                onClick={() =>
                  void run("dispatch", async () => {
                    await mutate("/dispatch", {});
                    setNotice(
                      "One approved original request processed. Check its actual provider record or held outcome below.",
                    );
                  })
                }
              >
                Process one approved journal
              </Action>
            )}
          </div>
          {!data?.jobs.length ? (
            <Empty>No NetSuite journal requests on this page.</Empty>
          ) : (
            data.jobs.map((value) => (
              <article
                key={value.id}
                className="grid min-w-0 gap-3 rounded-lg border p-4"
              >
                <div className="flex flex-wrap justify-between gap-3">
                  <h4 className="break-all text-sm font-medium">
                    {value.external_id}
                  </h4>
                  <Status value={value.state} />
                </div>
                <p className="break-all text-xs">
                  Source fee group {value.source_id}. Provider ID{" "}
                  {value.provider_id ?? "not confirmed"}. Attempts{" "}
                  {value.attempts}. Exact functional amount{" "}
                  {value.posting.valuation.text}{" "}
                  {value.posting.mapping.currencyCode}. Original native amount{" "}
                  {formatUnits(value.posting.source.amountAtomic, 24)} NEAR.
                </p>
                <p className="text-xs leading-5">
                  {value.posting.financialEffect}
                </p>
                {value.last_error && (
                  <p role="alert" className="text-sm text-destructive">
                    {value.last_error}. An unknown original write never
                    authorizes a replacement or another automatic attempt.
                  </p>
                )}
                <details>
                  <summary className="cursor-pointer text-sm">
                    Inspect full exact disclosure, accounts, source and
                    valuation
                  </summary>
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
                      Inspect the last actual provider observation before
                      acknowledging a changed revision
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
                            "Only this exact human-reviewed journal is queued. Dispatch is a separate action; NetSuite approval workflows still apply.",
                          );
                        })
                      }
                    >
                      Approve this exact disclosure and journal
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
                              "Only an unapproved, unattempted review was retired. Its exact fee identities can now be reviewed again; history remains.",
                            );
                          })
                        }
                      >
                        Retire unapproved review
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
                            "Read the original account-bound external ID. Missing results remain held; no write was replayed.",
                          );
                        })
                      }
                    >
                      Read and reconcile original external ID
                    </Action>
                  )}
                  {canApprove &&
                    value.last_error ===
                      "EXTERNAL_REVISION_REVIEW_REQUIRED" && (
                      <Action
                        type="button"
                        disabled={!fresh || c?.status !== "active"}
                        onClick={() =>
                          void run(`revision:${value.id}`, async () => {
                            await mutate(`/journals/${value.id}/reconcile`, {
                              acknowledgeMatchingRevision: true,
                              expectedProviderHash: value.observation?.hash,
                            });
                            setNotice(
                              "A changed provider revision was explicitly reviewed. Financial conflicts cannot be accepted as matching.",
                            );
                          })
                        }
                      >
                        Review matching provider revision
                      </Action>
                    )}
                </div>
              </article>
            ))
          )}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <Action
              type="button"
              disabled={!fresh || page === 1}
              onClick={() => setPage((value) => value - 1)}
            >
              Previous journal requests
            </Action>
            <span className="text-xs">Page {page}</span>
            <Action
              type="button"
              disabled={!fresh || !data?.hasMore}
              onClick={() => setPage((value) => value + 1)}
            >
              Next journal requests
            </Action>
          </div>
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
    </Panel>
  );
}
