"use client";

import { useState } from "react";
import { api } from "@/lib/api";
import { formatUnits } from "@/lib/money";
import type { accountingOverview } from "@/server/accounting/service";
import { AssetIdentity } from "../assets/asset-identity";
import { useAction } from "./hooks";
import { Action, control, DataTable, Empty, Field, Status } from "./shared";

type Overview = ReturnType<typeof accountingOverview>;
export function valuationFields(values: FormData) {
  return {
    numerator: String(values.get("valuationNumerator")),
    denominator: String(values.get("valuationDenominator")),
    source: String(values.get("valuationSource")),
    date: String(values.get("valuationDate")),
    rounding: String(values.get("valuationRounding")),
  };
}
export function AccountingValuationFields({
  asset,
}: {
  asset: "NEAR" | "USDC";
}) {
  return (
    <>
      <Field label={`Reviewed functional units per ${asset}: numerator`}>
        <input
          name="valuationNumerator"
          className={control}
          required
          pattern="[1-9][0-9]{0,17}"
        />
      </Field>
      <Field label="Rate denominator">
        <input
          name="valuationDenominator"
          className={control}
          required
          pattern="[1-9][0-9]{0,17}"
        />
      </Field>
      <Field label="Independent rate source and approval reference">
        <input
          name="valuationSource"
          className={control}
          required
          minLength={3}
          maxLength={300}
        />
      </Field>
      <Field label="Reviewed valuation date">
        <input
          name="valuationDate"
          className={control}
          type="date"
          required
          max={new Date().toISOString().slice(0, 10)}
        />
      </Field>
      <Field label="Explicit functional-cent policy">
        <select
          name="valuationRounding"
          className={control}
          required
          defaultValue="exact"
        >
          <option value="exact">
            Require exact whole cents; otherwise hold
          </option>
          <option value="half_even_to_cent">
            Reviewed nearest cent, ties to even; retain residual
          </option>
        </select>
      </Field>
    </>
  );
}
export function AccountingLedgerTools({
  endpoint,
  data,
  connectionId,
  canApprove,
  disabled,
  onChange,
}: {
  endpoint: string;
  data: Overview;
  connectionId: string;
  canApprove: boolean;
  disabled: boolean;
  onChange: () => void;
}) {
  const { busy, error, run } = useAction(),
    [notice, setNotice] = useState(""),
    fresh = !disabled && !busy,
    connection = data.connections.find((value) => value.id === connectionId);
  const mutate = async (path: string, input: unknown) => {
    await api(path, input);
    onChange();
  };
  return (
    <section
      className="grid min-w-0 gap-4 rounded-lg border p-4"
      aria-label="Verified crypto bookkeeping sources"
    >
      <h3 className="text-sm font-semibold">
        Crypto ledger sources and provider activity
      </h3>
      <p className="text-xs leading-5 text-muted-foreground">
        Actual NEAR token burn, accepted supplier credit and explicitly approved
        crypto-clearing valuation differences stay distinct. Payment caps, quote
        spreads and solver estimates are never actual fees. Bookkeeping does not
        move cash or reimburse a wallet. Latest 100 source records are shown.
      </p>
      {canApprove && (
        <details>
          <summary className="cursor-pointer text-sm">
            Capture one actual final NEAR fee observation
          </summary>
          <form
            className="mt-4 grid gap-3 sm:grid-cols-2"
            onSubmit={(event) => {
              event.preventDefault();
              const values = new FormData(event.currentTarget);
              void run("fee", async () => {
                await mutate(`${endpoint}/fees/observe`, {
                  referenceKind: values.get("referenceKind"),
                  referenceId: values.get("referenceId"),
                  transactionHash: values.get("transactionHash"),
                  signerAccount: values.get("signerAccount"),
                  companyExpenseAcknowledged: true,
                });
                setNotice(
                  "Final native NEAR token-burn evidence retained. No USDC fee or reimbursement was inferred.",
                );
              });
            }}
          >
            <fieldset className="contents" disabled={!fresh}>
              <Field label="Independently verified Razor source">
                <select name="referenceKind" className={control}>
                  <option value="payment">
                    Payment with verified source-token receipt
                  </option>
                  <option value="funding">
                    Funding with verified NEAR token receipt
                  </option>
                </select>
              </Field>
              <Field label="Exact source payment or funding ID">
                <input
                  name="referenceId"
                  className={control}
                  required
                  maxLength={128}
                />
              </Field>
              <Field label="Final NEAR transaction hash">
                <input
                  name="transactionHash"
                  className={control}
                  required
                  maxLength={64}
                />
              </Field>
              <Field label="Actual transaction signer">
                <input
                  name="signerAccount"
                  className={control}
                  required
                  maxLength={64}
                />
              </Field>
              <label className="flex gap-2 text-xs sm:col-span-2">
                <input type="checkbox" required />
                This verified company-member wallet paid this company's
                transaction. Third-party solver/relayer costs are excluded.
                Testnet observations remain separate from live books.
              </label>
              <div>
                <Action disabled={!fresh} busy={busy === "fee"}>
                  Read final NEAR outcomes and retain exact burn
                </Action>
              </div>
            </fieldset>
          </form>
        </details>
      )}
      {data.ledger.fees.length ? (
        <form
          className="grid gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            const values = new FormData(event.currentTarget);
            void run("group", async () => {
              await mutate(`${endpoint}/fees/groups`, {
                feeIds: values.getAll("feeId"),
                acknowledgement: true,
              });
              setNotice(
                "Selected exact fees grouped once. Review their valuation and journal mapping separately before any provider write.",
              );
            });
          }}
        >
          <AssetIdentity symbol="NEAR" network="near" />
          <DataTable
            columns={[
              "Group",
              "Final fee source",
              "Exact native burn",
              "Recorded network",
            ]}
          >
            {data.ledger.fees.map((value) => (
              <tr key={value.id}>
                <td>
                  <input
                    type="checkbox"
                    name="feeId"
                    value={value.id}
                    disabled={!fresh || !canApprove || !!value.batch_id}
                    aria-label={`Group fee ${value.id}`}
                  />
                </td>
                <td className="break-all text-xs">
                  {value.reference_kind} {value.reference_id}
                  <p className="mt-1">Transaction {value.transaction_hash}</p>
                </td>
                <td className="tabular-nums">
                  {formatUnits(value.amount_atomic, 24)} NEAR
                  <p className="mt-1 text-xs text-muted-foreground">
                    {value.batch_id
                      ? "Assigned to an immutable group"
                      : "Unassigned exact fee"}
                  </p>
                </td>
                <td>{value.network}</td>
              </tr>
            ))}
          </DataTable>
          {canApprove && (
            <>
              <p className="text-xs text-muted-foreground">
                Group unassigned fees from the same network to handle provider
                cent limits. Exact yoctoNEAR stays recorded. An unapproved,
                unattempted group can be released for regrouping; approved or
                uncertain posts keep the original identity.
              </p>
              <div>
                <Action disabled={!fresh} busy={busy === "group"}>
                  Group selected observed fees
                </Action>
              </div>
            </>
          )}
        </form>
      ) : (
        <Empty>
          No independently observed NEAR fees. A route's maximum cost is not
          evidence of an actual fee.
        </Empty>
      )}
      {canApprove &&
        data.ledger.feeBatches
          .filter((value) => value.state === "grouped")
          .map((value) => (
            <div
              key={value.id}
              className="flex min-w-0 flex-wrap items-center justify-between gap-3 rounded-lg border p-3 text-xs"
            >
              <p className="break-all">
                Group {value.id}: {formatUnits(value.amount_atomic, 24)} NEAR ·{" "}
                {value.network}
              </p>
              <Action
                type="button"
                disabled={!fresh}
                onClick={() =>
                  void run(`release:${value.id}`, async () => {
                    await mutate(
                      `${endpoint}/fees/groups/${value.id}/release`,
                      {},
                    );
                    setNotice(
                      "Only unapproved and unattempted fee identities were released. Exact observations and cancelled posting history remain.",
                    );
                  })
                }
              >
                Release unposted group for regrouping
              </Action>
            </div>
          ))}
      {connection?.status === "active" && (
        <>
          <details>
            <summary className="cursor-pointer text-sm">
              Import read-only provider accounting activity
            </summary>
            <form
              className="mt-4 grid gap-3 sm:grid-cols-2"
              onSubmit={(event) => {
                event.preventDefault();
                const values = new FormData(event.currentTarget);
                void run("activity", async () => {
                  const result = await api<{
                    matched: number;
                    unmatched: number;
                    conflicting: number;
                    mayHaveMore: boolean;
                  }>(`${endpoint}/connections/${connectionId}/activity`, {
                    kind: values.get("kind"),
                    page: Number(values.get("page")),
                  });
                  setNotice(
                    `Imported activity: ${result.matched} exact source matches, ${result.unmatched} unmatched and ${result.conflicting} conflicting. ${result.mayHaveMore ? "Load the next page for more activity." : "This page is complete."} No Razor financial state changed.`,
                  );
                  onChange();
                });
              }}
            >
              <fieldset className="contents" disabled={!fresh}>
                <Field label="Provider record family">
                  <select name="kind" className={control}>
                    <option value="bill">Bills</option>
                    <option value="settlement">Bill settlements</option>
                    <option value="credit">Supplier credits</option>
                    <option value="journal">Journal entries</option>
                  </select>
                </Field>
                <Field label="Provider activity page">
                  <input
                    name="page"
                    type="number"
                    className={control}
                    min={1}
                    max={1000}
                    step={1}
                    required
                    defaultValue={1}
                  />
                </Field>
                <p className="text-xs sm:col-span-2">
                  Matching requires this legal entity, exact Razor request
                  marker, immutable local source evidence, amount, date,
                  currency, accounts and tax treatment. Free-text references
                  cannot prove funding or payment. Unmatched or conflicting
                  records stay separate; a matching read never approves a new
                  write.
                </p>
                <div>
                  <Action disabled={!fresh} busy={busy === "activity"}>
                    Import and compare one actual provider page
                  </Action>
                </div>
              </fieldset>
            </form>
          </details>
          {canApprove && (
            <details>
              <summary className="cursor-pointer text-sm">
                Approve a separate crypto-clearing FX difference source
              </summary>
              <form
                className="mt-4 grid gap-3 sm:grid-cols-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  const values = new FormData(event.currentTarget);
                  void run("fx", async () => {
                    await mutate(
                      `${endpoint}/connections/${connectionId}/fx-differences`,
                      {
                        paymentId: values.get("paymentId"),
                        valuation: valuationFields(values),
                        reason: values.get("reason"),
                        acknowledgement: true,
                      },
                    );
                    setNotice(
                      "Exact valuation difference approved as a separate source. Its nonbank-clearing journal still needs an exact posting review and approval.",
                    );
                  });
                }}
              >
                <fieldset className="contents" disabled={!fresh}>
                  <Field label="Original fully reconciled installment payment">
                    <select name="paymentId" className={control} required>
                      <option value="">
                        Choose an already posted full settlement
                      </option>
                      {data.settlements.map((value) => (
                        <option key={value.id} value={value.id}>
                          {value.reference} · {value.id}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <AccountingValuationFields asset="USDC" />
                  <Field label="Accounting classification and approval reason">
                    <textarea
                      name="reason"
                      className={control}
                      minLength={3}
                      maxLength={2000}
                      required
                    />
                  </Field>
                  <label className="flex gap-2 text-xs sm:col-span-2">
                    <input type="checkbox" required />I approved this external
                    rate and its difference against the original immutable
                    functional carrying amount. This is a separate nonbank
                    crypto-clearing valuation journal, not a changed bill
                    payment, realized provider quote or a cash/refund claim.
                  </label>
                  <div>
                    <Action disabled={!fresh} busy={busy === "fx"}>
                      Approve the exact FX difference source
                    </Action>
                  </div>
                </fieldset>
              </form>
            </details>
          )}
        </>
      )}
      {data.unavailableProviders.map((provider) => (
        <p key={provider.provider} className="text-xs text-muted-foreground">
          <Status value="unavailable" /> {provider.provider}: {provider.reason}
        </p>
      ))}
      {notice && (
        <p role="status" className="text-sm">
          {notice}
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </section>
  );
}
