"use client";

import { useRef, useState } from "react";
import { api } from "@/lib/api";
import { parseUnits, formatUnits } from "@/lib/money";
import { usd } from "@/lib/format";
import { signNearActionBatch, type NearWalletAction } from "@/lib/near-actions";
import { AssetIdentity } from "@/components/assets/asset-identity";
import type {
  FinancingAction,
  FinancingRequest,
  listCompanyFinancing,
  marketFinancing,
  ownFinancing,
} from "@/server/financing/service";
import { useIdentity } from "./auth/identity-provider";
import { useAction, useResource } from "./workspace/hooks";
import {
  Action,
  Address,
  control,
  Empty,
  Field,
  Panel,
  Status,
} from "./workspace/shared";

type CompanyList = ReturnType<typeof listCompanyFinancing>;
type List =
  | ReturnType<typeof marketFinancing>
  | ReturnType<typeof ownFinancing>;
export function FinancingManagement({
  base,
  canManage = false,
  revision = 0,
  onRefresh,
}: {
  base?: string;
  canManage?: boolean;
  revision?: number;
  onRefresh?: () => void;
}) {
  const company = !!base,
    endpoint = base ? `${base}/financing` : "/financing",
    { session, signInWallet } = useIdentity(),
    [tick, setTick] = useState(0),
    [page, setPage] = useState(1),
    [tab, setTab] = useState<"market" | "loans">("loans"),
    [selected, setSelected] = useState(""),
    [preview, setPreview] = useState<FinancingAction | null>(null),
    [confirmed, setConfirmed] = useState(false),
    [notice, setNotice] = useState(""),
    [offerRisk, setOfferRisk] = useState(""),
    [depositKind, setDepositKind] = useState("repayment"),
    [recoveryCreditId, setRecoveryCreditId] = useState("");
  const requests = useResource<CompanyList | List>(
      session
        ? company
          ? `${endpoint}?page=${page}`
          : `${endpoint}/${tab}?page=${page}`
        : null,
      revision + tick,
    ),
    detail = useResource<{ request: FinancingRequest }>(
      session && selected ? `${endpoint}/${selected}` : null,
      revision + tick,
    ),
    current = detail.data?.request,
    { busy, error, run } = useAction(),
    keys = useRef(new Map<string, string>());
  const isBorrower =
      !!current?.agreement &&
      session?.wallets.some(
        (wallet) =>
          wallet.family === "near" &&
          wallet.network === current.scope.network &&
          wallet.address === current.agreement!.borrower,
      ),
    isLender =
      !!current?.agreement &&
      session?.wallets.some(
        (wallet) =>
          wallet.family === "near" &&
          wallet.network === current.scope.network &&
          wallet.address === current.agreement!.lender,
      );
  const scopes =
      requests.data && "scopes" in requests.data ? requests.data.scopes : [],
    accounts =
      session?.wallets.filter(
        (wallet) =>
          wallet.family === "near" &&
          (!current || wallet.network === current.scope.network),
      ) ?? [];
  function refresh() {
    setTick((value) => value + 1);
    onRefresh?.();
  }
  function key(value: unknown) {
    const digest = JSON.stringify(value),
      existing = keys.current.get(digest) ?? crypto.randomUUID();
    keys.current.set(digest, existing);
    return existing;
  }
  function amount(value: FormDataEntryValue | null) {
    return parseUnits(String(value ?? "0"));
  }
  function review(action: string, extra: Record<string, unknown> = {}) {
    if (!current) return;
    setPreview(null);
    setConfirmed(false);
    void run(`review-${action}`, async () => {
      setPreview(
        await api<FinancingAction>(`${endpoint}/${current.id}/action`, {
          action,
          ...extra,
        }),
      );
    });
  }
  async function sign() {
    if (!preview || !confirmed) return;
    const plan = preview;
    await run("sign-financing", async () => {
      try {
        const result = await signNearActionBatch(
          plan.walletActions as NearWalletAction[],
          plan.network,
          plan.eligibleSigners,
          async (signerAccount) => {
            if (plan.actionId)
              await api(`${endpoint}/${plan.requestId}/begin`, {
                actionId: plan.actionId,
                reviewHash: plan.reviewHash,
                signerAccount,
              });
          },
        );
        await api(`${endpoint}/${plan.requestId}/reconcile`, {});
        setNotice(
          result.complete
            ? "Wallet results returned and contract state refreshed. Company cash requires a separate tagged treasury receipt; this action did not mark revenue."
            : "The wallet result is incomplete. The original operation remains subject to contract reconciliation.",
        );
      } finally {
        setPreview(null);
        setConfirmed(false);
        refresh();
      }
    });
  }
  if (!session)
    return (
      <Panel title="Native NEAR working capital">
        <Empty>
          Sign in and link your actual NEAR account to inspect your authorized
          lending scope and existing agreements.
        </Empty>
        <a href="/sign-in" className="text-sm text-primary underline">
          Sign in
        </a>
      </Panel>
    );
  return (
    <Panel
      title={
        company
          ? "Company working capital"
          : "Your lending and borrowing agreements"
      }
      tone="white" description="Peer-to-peer USDC working capital on NEAR." help="Real operating scope, exact owner approval and funded escrow are required."
    >
      <div className="grid min-w-0 grid-cols-1 gap-5">
        <p className="rounded-xl border border-amber-200/70 bg-amber-50/50 px-4 py-3 text-xs leading-6 text-amber-900">
          No lender, liquidity, repayment or creditworthiness guarantee.
          Principal, fixed borrowing cost and USDC bond remain separate from
          company deposits and revenue. Contract terms and repayment
          descriptions are public on NEAR. Repayment uses the fixed
          borrower&apos;s own wallet, with no authority over unrelated payroll
          or client money.
        </p>
        <div className="flex flex-wrap gap-3">
          <Action
            type="button"
            disabled={!!busy}
            busy={busy === "link-near"}
            onClick={() =>
              void run("link-near", async () => {
                await signInWallet("near", true);
                refresh();
              })
            }
          >
            Link a verified NEAR account
          </Action>
          <Action
            type="button"
            disabled={!!busy || requests.refreshing}
            onClick={refresh}
          >
            Refresh recorded state
          </Action>
          {!company &&
            ["loans", "market"].map((value) => (
              <Action
                key={value}
                type="button"
                disabled={!!busy || tab === value}
                onClick={() => {
                  setTab(value as "market" | "loans");
                  setPage(1);
                  setSelected("");
                  setPreview(null);
                }}
              >
                {value === "market"
                  ? "Invited opportunities"
                  : "My agreements and offers"}
              </Action>
            ))}
        </div>
        {requests.error && (
          <p role="alert" className="text-sm text-destructive">
            {requests.error}
          </p>
        )}
        {requests.data && "availability" in requests.data ? (
          <p className="text-xs text-muted-foreground">
            {requests.data.availability}
          </p>
        ) : null}
        {company && canManage && (
          <details className="min-w-0 rounded-2xl border border-border bg-white p-5">
            <summary className="cursor-pointer text-sm font-medium">
              Request native-USDC working capital
            </summary>
            {!scopes.length ? (
              <Empty>
                No operator-published operating scope covers this company.
                Requests and lenders are unavailable until real scope is
                configured.
              </Empty>
            ) : (
              <form
                className="mt-4 grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  const form = event.currentTarget,
                    values = new FormData(form);
                  void run("request-financing", async () => {
                    const payload = {
                      scopeId: String(values.get("scope")),
                      principal: amount(values.get("principal")),
                      maxCost: amount(values.get("cost")),
                      collateral: amount(values.get("bond")),
                      tenorDays: Number(values.get("tenor")),
                      graceDays: Number(values.get("grace")),
                      fundBy: new Date(
                        String(values.get("fundBy")),
                      ).toISOString(),
                      purpose: String(values.get("purpose")),
                      repaymentSource: String(values.get("source")),
                      ...(values.get("bill")
                        ? {
                            receivableBillId: String(values.get("bill")).trim(),
                          }
                        : {}),
                      publicMarketConsent: true,
                    };
                    const result = await api<{ request: FinancingRequest }>(
                      endpoint,
                      { ...payload, requestKey: key(["request", payload]) },
                    );
                    setSelected(result.request.id);
                    form.reset();
                    setNotice(
                      "Request recorded for invited scoped lenders. No loan, funding or company cash has been created.",
                    );
                    refresh();
                  });
                }}
              >
                <fieldset className="contents" disabled={!!busy}>
                  <Field label="Published operating scope">
                    <select className={control} name="scope" required>
                      {scopes.map((scope) => (
                        <option key={scope.id} value={scope.id}>
                          {scope.label} ({scope.network})
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Principal (USDC)">
                    <input
                      name="principal"
                      className={control}
                      required
                      inputMode="decimal"
                      placeholder="1000"
                    />
                  </Field>
                  <Field label="Maximum total fixed interest and lender fee (USDC)">
                    <input
                      name="cost"
                      className={control}
                      required
                      inputMode="decimal"
                      defaultValue="0"
                    />
                  </Field>
                  <Field
                    label="Your separate USDC collateral bond"
                    hint="Zero means unsecured. Default can liquidate only this fixed loan bond."
                  >
                    <input
                      name="bond"
                      className={control}
                      required
                      inputMode="decimal"
                      defaultValue="0"
                    />
                  </Field>
                  <Field label="Tenor from confirmed advance (days)">
                    <input
                      name="tenor"
                      className={control}
                      type="number"
                      min="1"
                      max="366"
                      defaultValue="30"
                      required
                    />
                  </Field>
                  <Field label="Grace before fixed-bond default (days)">
                    <input
                      name="grace"
                      className={control}
                      type="number"
                      min="0"
                      max="30"
                      defaultValue="3"
                      required
                    />
                  </Field>
                  <Field label="Funding deadline (your browser timezone)">
                    <input
                      name="fundBy"
                      className={control}
                      type="datetime-local"
                      required
                    />
                  </Field>
                  <Field
                    label="Optional accepted receivable bill ID"
                    hint="Only a business invoice owed to your original supplier identity. Exclusivity is limited to Razor; lien priority and collection are unverified."
                  >
                    <input name="bill" className={control} maxLength={36} />
                  </Field>
                  <Field label="Purpose disclosed to invited lenders">
                    <textarea
                      name="purpose"
                      className={control}
                      minLength={10}
                      maxLength={500}
                      required
                    />
                  </Field>
                  <Field label="Exact repayment source description (public on NEAR)">
                    <textarea
                      name="source"
                      className={control}
                      minLength={10}
                      maxLength={500}
                      required
                    />
                  </Field>
                  <label className="flex items-start gap-2 text-xs leading-5 sm:col-span-2">
                    <input type="checkbox" required />I authorize disclosure of
                    these commercial terms to invited lenders and understand
                    that eventual NEAR loan terms are public. A receivable is
                    not guaranteed repayment.
                  </label>
                  <div className="sm:col-span-2">
                    <Action
                      busy={busy === "request-financing"}
                      disabled={!!busy}
                    >
                      Publish scoped borrowing request
                    </Action>
                  </div>
                </fieldset>
              </form>
            )}
          </details>
        )}
        {requests.loading ? (
          <Empty>Loading authorized financing...</Empty>
        ) : !requests.data?.requests.length ? (
          <Empty>No requests or agreements are available in this view.</Empty>
        ) : (
          <div className="grid min-w-0 grid-cols-1 gap-3">
            {requests.data.requests.map((item) => (
              <button
                key={item.id}
                type="button"
                disabled={!!busy}
                className={`min-w-0 rounded-2xl border border-border bg-white p-5 text-left ${selected === item.id ? "border-primary" : ""}`}
                onClick={() => {
                  setSelected(item.id);
                  setPreview(null);
                  setConfirmed(false);
                  setOfferRisk("");
                }}
              >
                <span className="flex min-w-0 flex-wrap items-center justify-between gap-3">
                  <strong className="break-words text-sm">
                    {item.companyName} · {usd(item.terms.principal)} principal
                  </strong>
                  <Status value={item.chain?.stage ?? item.state} />
                </span>
                <span className="mt-2 block break-words text-xs text-muted-foreground">
                  {item.terms.tenorDays} days · fixed cost ceiling{" "}
                  {usd(item.terms.maxCost)} · {item.scope.network}
                </span>
              </button>
            ))}
          </div>
        )}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Action
            type="button"
            disabled={page === 1 || requests.loading || !!busy}
            onClick={() => setPage((value) => value - 1)}
          >
            Previous financing
          </Action>
          <span className="text-xs">Page {page}</span>
          <Action
            type="button"
            disabled={!requests.data?.hasMore || requests.loading || !!busy}
            onClick={() => setPage((value) => value + 1)}
          >
            Next financing
          </Action>
        </div>
        {detail.error && (
          <p role="alert" className="text-sm text-destructive">
            {detail.error}
          </p>
        )}
        {detail.loading ? (
          <Empty>Loading fixed agreement history...</Empty>
        ) : (
          current && (
            <article className="grid min-w-0 grid-cols-1 gap-4 rounded-2xl border border-border bg-white p-5">
              <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
                <h3 className="break-words font-medium">
                  {current.companyName} working capital
                </h3>
                <Status value={current.chain?.stage ?? current.state} />
              </div>
              <AssetIdentity symbol="USDC" network="near" />
              <dl className="grid min-w-0 grid-cols-1 gap-3 text-sm sm:grid-cols-2">
                <div>
                  <dt className="text-muted-foreground">Principal</dt>
                  <dd>
                    {formatUnits(current.terms.principal, 6)} USDC (
                    {usd(current.terms.principal)})
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Fixed cost ceiling</dt>
                  <dd>{usd(current.terms.maxCost)}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">
                    Separate fixed collateral bond
                  </dt>
                  <dd>{usd(current.terms.collateral)}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Funding deadline</dt>
                  <dd>{new Date(current.terms.fundBy).toLocaleString()}</dd>
                </div>
              </dl>
              <p className="break-words text-sm">{current.terms.purpose}</p>
              <p className="break-words text-xs">
                Repayment source: {current.terms.repaymentSource}
              </p>
              <p className="break-words text-xs text-muted-foreground">
                Operating scope: {current.scope.label}.{" "}
                {current.scope.eligibility}
              </p>
              {current.assignment && (
                <p className="text-xs text-amber-900">
                  One accepted receivable is exclusively assigned within Razor.
                  Off-platform ownership, lien priority and debtor collection
                  have not been verified.
                </p>
              )}
              {current.offers.map((offer) => (
                <section
                  key={offer.id}
                  className="grid min-w-0 grid-cols-1 gap-3 rounded-lg bg-muted p-3 text-sm"
                >
                  <Address
                    value={offer.lenderAccount}
                    network={current.scope.network}
                  />
                  <p>
                    Fixed interest {usd(offer.interest)} + fixed lender fee{" "}
                    {usd(offer.fee)}. Total repayment{" "}
                    {usd(
                      (
                        BigInt(current.terms.principal) +
                        BigInt(offer.interest) +
                        BigInt(offer.fee)
                      ).toString(),
                    )}
                    . Expires {new Date(offer.expiresAt).toLocaleString()}.
                  </p>
                  <Status value={offer.state} />
                  {company &&
                    canManage &&
                    current.state === "open" &&
                    offer.state === "proposed" && (
                      <>
                        <label className="flex items-start gap-2 text-xs">
                          <input
                            type="checkbox"
                            checked={offerRisk === offer.id}
                            onChange={(event) =>
                              setOfferRisk(event.target.checked ? offer.id : "")
                            }
                          />
                          I accept the exact principal, fixed interest, fixed
                          fee, bond, tenor, grace, principal-first waterfall and
                          limited default rules. This locks this offer and
                          cannot be undone by timeout.
                        </label>
                        <Action
                          disabled={!!busy || offerRisk !== offer.id}
                          onClick={() =>
                            void run(`accept-${offer.id}`, async () => {
                              await api(`${endpoint}/${current.id}/accept`, {
                                offerId: offer.id,
                                offerHash: offer.offerHash,
                                acknowledgeRisk: true,
                              });
                              setOfferRisk("");
                              setNotice(
                                "Exact offer accepted. Register the agreement on NEAR, then fund its separate escrow. No advance has occurred.",
                              );
                              refresh();
                            })
                          }
                        >
                          Accept this exact offer
                        </Action>
                      </>
                    )}
                  {!company &&
                    current.state === "open" &&
                    offer.state === "proposed" && (
                      <Action
                        type="button"
                        disabled={!!busy}
                        onClick={() =>
                          void run(`withdraw-${offer.id}`, async () => {
                            await api(
                              `${endpoint}/${current.id}/offers/${offer.id}/withdraw`,
                              {},
                            );
                            refresh();
                          })
                        }
                      >
                        Withdraw my unaccepted offer
                      </Action>
                    )}
                </section>
              ))}
              {!company && current.state === "open" && !current.agreement && (
                <form
                  className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2"
                  onSubmit={(event) => {
                    event.preventDefault();
                    const values = new FormData(event.currentTarget);
                    void run("submit-offer", async () => {
                      const payload = {
                        accountId: String(values.get("account")),
                        interest: amount(values.get("interest")),
                        fee: amount(values.get("fee")),
                        expiresAt: new Date(
                          String(values.get("expires")),
                        ).toISOString(),
                      };
                      await api(`${endpoint}/${current.id}/offers`, {
                        ...payload,
                        requestKey: key(["offer", current.id, payload]),
                      });
                      setNotice(
                        "Your exact offer is recorded. It does not fund escrow or guarantee selection.",
                      );
                      refresh();
                    });
                  }}
                >
                  <fieldset className="contents" disabled={!!busy}>
                    <Field label="Your linked NEAR lender account">
                      <select name="account" className={control} required>
                        {accounts.map((account) => (
                          <option key={account.id} value={account.address}>
                            {account.address}
                          </option>
                        ))}
                      </select>
                    </Field>
                    <Field label="Fixed interest (USDC)">
                      <input
                        name="interest"
                        className={control}
                        required
                        defaultValue="0"
                        inputMode="decimal"
                      />
                    </Field>
                    <Field label="Fixed lender fee (USDC)">
                      <input
                        name="fee"
                        className={control}
                        required
                        defaultValue="0"
                        inputMode="decimal"
                      />
                    </Field>
                    <Field label="Offer expiry (your browser timezone)">
                      <input
                        name="expires"
                        className={control}
                        required
                        type="datetime-local"
                      />
                    </Field>
                    <div className="sm:col-span-2">
                      <Action disabled={!!busy || !accounts.length}>
                        Submit exact comparable offer
                      </Action>
                    </div>
                  </fieldset>
                </form>
              )}
              {current.agreement && (
                <>
                  <div className="grid min-w-0 grid-cols-1 gap-3 rounded-lg bg-muted p-3 text-xs">
                    <p>Fixed borrower</p>
                    <Address
                      value={current.agreement.borrower}
                      network={current.scope.network}
                    />
                    <p>Fixed lender</p>
                    <Address
                      value={current.agreement.lender}
                      network={current.scope.network}
                    />
                    <p>
                      Principal-first waterfall, then fixed interest{" "}
                      {usd(current.agreement.interest)}, then lender fee{" "}
                      {usd(current.agreement.fee)}. At due time plus{" "}
                      {current.terms.graceDays} grace days, only this
                      loan&apos;s USDC bond can be applied to debt. Remaining
                      bond returns to its fixed borrower; unsecured shortfall
                      remains due. A dispute requires both original parties to
                      resume without repricing.
                    </p>
                    <p className="break-all font-mono">
                      Agreement {current.agreementHash}
                    </p>
                  </div>
                  {current.chain?.pending?.kind === "advance" && (
                    <Field
                      label="Exact treasury deposit credit ID for recovery (optional)"
                      hint="Use the immutable credit ID from the original treasury receipt if another deposit reused its reference. The loan sender, company and principal must still match."
                    >
                      <input
                        className={control}
                        value={recoveryCreditId}
                        onChange={(event) =>
                          setRecoveryCreditId(event.target.value.trim())
                        }
                        inputMode="numeric"
                        pattern="[1-9][0-9]*"
                        maxLength={20}
                      />
                    </Field>
                  )}
                  {current.chain ? (
                    <div className="grid min-w-0 grid-cols-1 gap-3 text-xs sm:grid-cols-2">
                      {[
                        [
                          "Lender principal funded",
                          current.chain.principal_funded,
                        ],
                        [
                          "Borrower bond funded",
                          current.chain.collateral_funded,
                        ],
                        ["Conclusive advance", current.chain.advanced],
                        ["Actual cash repayments", current.chain.cash_repaid],
                        [
                          "Bond applied on default",
                          current.chain.collateral_applied,
                        ],
                        [
                          "Lender withdrawable credit",
                          current.chain.lender_credit,
                        ],
                        ["Borrower bond refund", current.chain.borrower_refund],
                        [
                          "Remaining principal",
                          (
                            BigInt(current.agreement.principal) -
                            BigInt(current.chain.principal_paid)
                          ).toString(),
                        ],
                      ].map(([label, value]) => (
                        <p key={label}>
                          {label}
                          <br />
                          {usd(value)}
                        </p>
                      ))}
                      <p>
                        Maturity
                        <br />
                        {current.chain.due_at_ms
                          ? new Date(
                              Number(current.chain.due_at_ms),
                            ).toLocaleString()
                          : "No confirmed advance"}
                      </p>
                      <p>
                        Dispute
                        <br />
                        {current.chain.disputed
                          ? "Held pending bilateral resume"
                          : "No active dispute"}
                      </p>
                      {current.chain.pending && (
                        <p className="break-words text-amber-900 sm:col-span-2">
                          Pending {current.chain.pending.kind}:{" "}
                          {usd(current.chain.pending.amount)}. Unknown outcomes
                          retain this original authority; no timeout releases
                          it.
                        </p>
                      )}
                    </div>
                  ) : (
                    <Empty>
                      This agreement has not been conclusively observed on the
                      configured contract. Refresh or register its exact frozen
                      identity. A wallet result alone is not funding.
                    </Empty>
                  )}
                  <div className="flex flex-wrap gap-3">
                    <Action
                      disabled={!!busy}
                      onClick={() =>
                        void run("reconcile-financing", async () => {
                          await api(`${endpoint}/${current.id}/reconcile`, {});
                          refresh();
                        })
                      }
                    >
                      Reconcile actual contract
                    </Action>
                    {company && canManage && !current.chain && (
                      <Action
                        disabled={!!busy}
                        onClick={() => review("register")}
                      >
                        Review registration and storage deposit
                      </Action>
                    )}
                    {isBorrower &&
                      current.chain &&
                      current.chain.stage === "funding" &&
                      !current.chain.pending &&
                      !current.chain.disputed &&
                      current.chain.principal_funded ===
                        current.agreement.principal &&
                      current.chain.collateral_funded ===
                        current.agreement.collateral && (
                        <Action
                          disabled={!!busy}
                          onClick={() => review("advance")}
                        >
                          Review exact funded advance
                        </Action>
                      )}
                    {(
                      [
                        "cancel",
                        "withdraw",
                        "default",
                        "dispute",
                        "resume",
                        "recover_advance",
                      ] as const
                    )
                      .filter((action) => isBorrower || isLender)
                      .map((action) => (
                        <Action
                          key={action}
                          disabled={
                            !!busy ||
                            (action === "withdraw"
                              ? !!current.chain?.pending ||
                                !(
                                  (isBorrower &&
                                    BigInt(
                                      current.chain?.borrower_refund ?? "0",
                                    ) > 0n) ||
                                  (isLender &&
                                    BigInt(
                                      current.chain?.lender_credit ?? "0",
                                    ) > 0n)
                                )
                              : action === "recover_advance"
                                ? current.chain?.pending?.kind !== "advance"
                                : action === "resume"
                                  ? !current.chain?.disputed
                                  : action === "default"
                                    ? current.chain?.stage !== "active" ||
                                      !!current.chain?.disputed ||
                                      !!current.chain.pending ||
                                      !current.chain.due_at_ms ||
                                      Date.now() <
                                        Number(current.chain.due_at_ms) +
                                          current.terms.graceDays * 86400000
                                    : action === "dispute"
                                      ? !current.chain ||
                                        !!current.chain.disputed ||
                                        !!current.chain.pending ||
                                        ![
                                          "funding",
                                          "active",
                                          "defaulted",
                                        ].includes(current.chain.stage)
                                      : (!!current.chain &&
                                          current.chain.stage !== "funding") ||
                                        !!current.chain?.pending ||
                                        !!current.chain?.disputed)
                          }
                          onClick={() =>
                            review(
                              action,
                              action === "recover_advance" && recoveryCreditId
                                ? { creditId: recoveryCreditId }
                                : {},
                            )
                          }
                        >
                          {
                            {
                              cancel: "Review cancellation",
                              withdraw: "Review my fixed withdrawal",
                              default: "Review due-date bond default",
                              dispute: "Raise a loan dispute",
                              resume: "Consent to resume unchanged",
                              recover_advance:
                                "Recover matching advance evidence",
                            }[action]
                          }
                        </Action>
                      ))}
                    {current.unresolvedDeposit && (
                      <Action
                        disabled={!!busy}
                        onClick={() => review("void_deposit")}
                      >
                        Permanently void my unresolved deposit
                      </Action>
                    )}
                  </div>
                  {current.unresolvedDeposit && (
                    <p className="text-xs text-amber-900">
                      Your original {current.unresolvedDeposit.kind} deposit
                      remains unresolved. Reconcile its immutable deposit
                      marker, retry the same exact amount and identity, or
                      permanently void that identity on NEAR before another
                      deposit.
                    </p>
                  )}
                  <form
                    className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2"
                    onSubmit={(event) => {
                      event.preventDefault();
                      const values = new FormData(event.currentTarget);
                      void run("review-loan-deposit", async () => {
                        const exact = amount(values.get("amount")),
                          depositId = key([
                            "deposit",
                            current.id,
                            depositKind,
                            exact,
                            current.chain?.principal_funded,
                            current.chain?.collateral_funded,
                            current.chain?.cash_repaid,
                          ]);
                        setConfirmed(false);
                        setPreview(
                          await api<FinancingAction>(
                            `${endpoint}/${current.id}/action`,
                            { action: depositKind, amount: exact, depositId },
                          ),
                        );
                      });
                    }}
                  >
                    <fieldset className="contents" disabled={!!busy}>
                      <Field label="Separate native-USDC deposit">
                        <select
                          className={control}
                          value={depositKind}
                          onChange={(event) =>
                            setDepositKind(event.target.value)
                          }
                        >
                          <option value="principal">Lender principal</option>
                          <option value="collateral">
                            Borrower collateral bond
                          </option>
                          <option value="repayment">Borrower repayment</option>
                        </select>
                      </Field>
                      <Field label="Exact amount (USDC)">
                        <input
                          name="amount"
                          className={control}
                          required
                          inputMode="decimal"
                        />
                      </Field>
                      <div className="sm:col-span-2">
                        <Action disabled={!!busy || !current.chain}>
                          Review fixed escrow deposit
                        </Action>
                      </div>
                    </fieldset>
                  </form>
                </>
              )}
              {company &&
                current.chain &&
                BigInt(current.chain.advanced) > 0n && (
                  <form
                    className="grid min-w-0 grid-cols-1 gap-3 rounded-lg border p-3 sm:grid-cols-2"
                    onSubmit={(event) => {
                      event.preventDefault();
                      const values = new FormData(event.currentTarget);
                      void run("verify-loan-credit", async () => {
                        await api(
                          `${endpoint}/${current.id}/advance-evidence`,
                          {
                            transactionHash: String(
                              values.get("transaction"),
                            ).trim(),
                            signerAccount: String(values.get("signer")).trim(),
                          },
                        );
                        setNotice(
                          "The exact final tagged loan credit was recorded idempotently as financing liability, and company treasury balance was synchronized from its reviewed onchain ledger. No amount was added by this form and no revenue was recorded.",
                        );
                        refresh();
                      });
                    }}
                  >
                    <fieldset className="contents" disabled={!!busy}>
                      <Field label="Advance transaction hash">
                        <input
                          name="transaction"
                          className={control}
                          required
                          minLength={32}
                          maxLength={64}
                        />
                      </Field>
                      <Field label="Actual transaction signer">
                        <input
                          name="signer"
                          className={control}
                          defaultValue={current.agreement?.borrower}
                          required
                          minLength={2}
                          maxLength={64}
                        />
                      </Field>
                      <p className="text-xs text-muted-foreground sm:col-span-2">
                        Only an exact final native-USDC transfer from the
                        reviewed credit contract into this company&apos;s tagged
                        treasury deposit can support an ordinary cash credit.
                        Aggregate balances and wallet-reported success are
                        insufficient.
                      </p>
                      <div className="sm:col-span-2">
                        <Action
                          busy={busy === "verify-loan-credit"}
                          disabled={!!busy}
                        >
                          Verify tagged financing credit
                        </Action>
                      </div>
                    </fieldset>
                  </form>
                )}
              {company && canManage && current.state === "open" && (
                <Action
                  disabled={!!busy}
                  onClick={() =>
                    void run("withdraw-request", async () => {
                      await api(
                        `${endpoint}/${current.id}`,
                        undefined,
                        "DELETE",
                      );
                      refresh();
                    })
                  }
                >
                  Withdraw this unaccepted request
                </Action>
              )}
              <details className="min-w-0 text-xs">
                <summary className="cursor-pointer text-primary">
                  Recorded lifecycle history
                </summary>
                <div className="mt-3 grid min-w-0 grid-cols-1 gap-2">
                  {current.history.map((event) => (
                    <p key={event.id} className="break-words">
                      {event.kind} ·{" "}
                      {new Date(event.created_at).toLocaleString()}
                    </p>
                  ))}
                </div>
              </details>
              <p className="text-xs text-muted-foreground">
                Last verified snapshot:{" "}
                {current.reconciledAt
                  ? new Date(current.reconciledAt).toLocaleString()
                  : "none"}
                . This snapshot does not replace the separately verified company
                deposit ledger.
              </p>
            </article>
          )
        )}
        {preview && (
          <section className="grid min-w-0 grid-cols-1 gap-4 rounded-2xl border border-primary/30 bg-secondary/40 p-5">
            <h3 className="font-medium">Confirm this exact NEAR action</h3>
            {preview.warnings.map((value) => (
              <p
                key={value}
                className="text-xs leading-5 text-muted-foreground"
              >
                {value}
              </p>
            ))}
            {preview.walletActions.map((transaction, index) => (
              <div
                key={index}
                className="grid min-w-0 grid-cols-1 gap-2 rounded-lg bg-muted p-3 text-xs"
              >
                <Address
                  value={transaction.receiverId}
                  network={preview.network}
                />
                {transaction.actions.map((action, item) => (
                  <p key={item} className="break-words">
                    {action.params.methodName}. Attached NEAR:{" "}
                    {formatUnits(action.params.deposit, 24)}. The gas budget is
                    a cap, not measured gas burned.
                  </p>
                ))}
              </div>
            ))}
            <p className="break-all font-mono text-xs">
              Review {preview.reviewHash}
            </p>
            <label className="flex items-start gap-2 text-xs">
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(event) => setConfirmed(event.target.checked)}
              />
              I reviewed the fixed agreement, amount, receiving account and
              attached deposit. I understand that unknown outcomes retain the
              original operation.
            </label>
            <div className="flex flex-wrap gap-3">
              <Action
                disabled={!!busy || !confirmed}
                busy={busy === "sign-financing"}
                onClick={() => void sign()}
              >
                Confirm with the fixed NEAR account
              </Action>
              <Action
                disabled={!!busy}
                onClick={() => {
                  setPreview(null);
                  setConfirmed(false);
                }}
              >
                Close review
              </Action>
            </div>
          </section>
        )}
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
      </div>
    </Panel>
  );
}
