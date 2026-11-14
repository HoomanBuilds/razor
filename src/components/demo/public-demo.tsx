"use client";

import { useRef, useState } from "react";
import { ArrowRight, BookOpen, Calculator, ShieldCheck } from "lucide-react";
import { api } from "@/lib/api";
import { usd } from "@/lib/format";
import { AssetIdentity } from "@/components/assets/asset-identity";
import {
  Action,
  DataTable,
  Field,
  Panel,
  Status,
  control,
} from "@/components/workspace/shared";
import type {
  PublicDemoScenario,
  PublicDemoSelection,
} from "@/server/demo/scenario";
import type { PublicDemoIdentity } from "@/server/demo/identity";
interface Snapshot {
  scenario: PublicDemoScenario;
  identity: PublicDemoIdentity;
}
function Amount({ value }: { value: string }) {
  return (
    <span
      className="tabular-nums"
      title="Exact USDC units; no FX valuation is inferred"
    >
      {usd(value).replace("$", "")}{" "}
      <span className="text-muted-foreground">USDC</span>
    </span>
  );
}
export function PublicDemo({ initial }: { initial: Snapshot }) {
  const [snapshot, setSnapshot] = useState(initial),
    [scenario, setScenario] = useState<PublicDemoSelection["scenario"]>(
      initial.scenario.selection.scenario,
    ),
    [recovery, setRecovery] = useState<PublicDemoSelection["recovery"]>(
      initial.scenario.selection.recovery,
    ),
    [clearing, setClearing] = useState<PublicDemoSelection["clearing"]>(
      initial.scenario.selection.clearing,
    ),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    locked = useRef(false);
  const data = snapshot.scenario,
    identity = snapshot.identity,
    names = new Map(
      data.companies.map((company) => [company.id, company.name]),
    );
  async function recalculate() {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setError("");
    try {
      const query = new URLSearchParams({ scenario, recovery, clearing });
      const result = await api<Snapshot>(`/demo/scenario?${query}`);
      if (
        result.scenario.schema !== "razor.public-product-demo" ||
        result.scenario.version !== 1 ||
        result.scenario.fictional !== true
      )
        throw new Error("Unexpected demo response");
      setSnapshot(result);
    } catch {
      setError(
        "The read-only scenario could not be recalculated. Your previous fictional calculation remains visible. Retry or restore the opening example; no financial action was sent.",
      );
    } finally {
      locked.current = false;
      setBusy(false);
    }
  }
  function reset() {
    if (locked.current) return;
    setSnapshot(initial);
    setScenario(initial.scenario.selection.scenario);
    setRecovery(initial.scenario.selection.recovery);
    setClearing(initial.scenario.selection.clearing);
    setError("");
  }
  return (
    <div className="grid min-w-0 grid-cols-1 gap-7">
      <Panel
        title="Explore a fictional company payment day"
        description="Public, read-only product preview. No wallet, account, company funds or administrator setup is needed."
      >
        <div className="grid min-w-0 grid-cols-1 gap-5">
          <p className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm leading-6 text-amber-950">
            Every company, person, amount and outcome below is fictional or
            hypothetical. The calculations use the current product algorithms.
            This page creates no company, payment, approval, deposit, clearing
            round or signature. Real receipts, balances and hardware evidence
            are unavailable.
          </p>
          <form
            className="grid min-w-0 grid-cols-1 items-end gap-4 sm:grid-cols-2"
            onSubmit={(event) => {
              event.preventDefault();
              void recalculate();
            }}
          >
            <fieldset disabled={busy} className="contents">
              <Field label="Product scenario">
                <select
                  className={control}
                  value={scenario}
                  onChange={(event) =>
                    setScenario(
                      event.target.value as PublicDemoSelection["scenario"],
                    )
                  }
                >
                  <option value="payments">
                    Payroll, contractor and supplier queue
                  </option>
                  <option value="clearing">
                    Three-company invoice clearing
                  </option>
                </select>
              </Field>
              {scenario === "payments" ? (
                <Field label="Fictional contractor branch">
                  <select
                    className={control}
                    value={recovery}
                    onChange={(event) =>
                      setRecovery(
                        event.target.value as PublicDemoSelection["recovery"],
                      )
                    }
                  >
                    <option value="held">
                      Original transfer remains unknown
                    </option>
                    <option value="no_send">
                      Assume conclusive original no-send evidence
                    </option>
                  </select>
                </Field>
              ) : (
                <Field label="Alternative hypothetical settlement path">
                  <select
                    className={control}
                    value={clearing}
                    onChange={(event) =>
                      setClearing(
                        event.target.value as PublicDemoSelection["clearing"],
                      )
                    }
                  >
                    <option value="debt_only">
                      Conserved debt setoff, no token movement
                    </option>
                    <option value="cash_backed">
                      Assume escrow funding and finalization
                    </option>
                    <option value="token_delivery">
                      Assume individual full token deliveries
                    </option>
                  </select>
                </Field>
              )}
              <div className="flex flex-wrap gap-3 sm:col-span-2">
                <Action disabled={busy} busy={busy} type="submit">
                  <Calculator size={16} aria-hidden="true" />
                  Recalculate fictional example
                </Action>
                <Action disabled={busy} type="button" onClick={reset}>
                  Restore opening example
                </Action>
              </div>
            </fieldset>
          </form>
          {busy && (
            <p role="status" className="text-sm">
              Recalculating the fixed fictional scenario with the current
              product helpers...
            </p>
          )}
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <p className="text-xs leading-5 text-muted-foreground">
            The numbers currently displayed belong to the last completed
            calculation:{" "}
            {data.selection.scenario === "payments"
              ? `payment queue, ${data.selection.recovery === "held" ? "unknown original" : "assumed conclusive no-send"}`
              : `invoice clearing, ${data.selection.clearing.replaceAll("_", " ")}`}
            . Changes to the selectors take effect when you recalculate.
          </p>
        </div>
      </Panel>
      <Panel
        title="Follow the workflow"
        description="These are hypothetical decision steps, with actual execution kept separate."
      >
        <ol className="grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-2">
          {data.steps.map((step, index) => (
            <li key={step.title} className="min-w-0 rounded-lg border p-4">
              <span className="text-xs font-semibold text-primary">
                Step {index + 1}
              </span>
              <h3 className="mt-2 text-sm font-semibold">{step.title}</h3>
              <p className="mt-2 break-words text-sm leading-6 text-muted-foreground">
                {step.detail}
              </p>
            </li>
          ))}
        </ol>
      </Panel>
      {data.selection.scenario === "payments" ? (
        <>
          <Panel
            title="Fictional payroll and invoice obligations"
            description="All obligations remain in exact USDC units. Recipient asset choices are preferences, not live quotes."
          >
            <div className="grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-3">
              <Metric
                label="Original fictional obligations"
                value={data.paymentSummary.originalFace}
              />
              <Metric
                label="Hypothetical total cost ceiling"
                value={data.paymentSummary.hypotheticalMaxCost}
              />
              <Metric
                label="Hypothetical unpaid principal"
                value={data.paymentSummary.hypotheticalRemaining}
              />
            </div>
            <div className="mt-5 grid min-w-0 grid-cols-1 gap-4">
              {data.payments.map((payment) => (
                <article
                  key={payment.id}
                  className="grid min-w-0 grid-cols-1 gap-4 rounded-lg border p-4"
                >
                  <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
                    <div className="min-w-0">
                      <h3 className="break-words text-sm font-semibold">
                        {payment.name}
                      </h3>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {payment.role}
                      </p>
                    </div>
                    <span className="rounded-full bg-muted px-3 py-1 text-xs">
                      Hypothetical{" "}
                      {payment.hypotheticalState.replaceAll("_", " ")}
                    </span>
                  </div>
                  <div className="grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-2">
                    <div>
                      <p className="mb-2 text-xs text-muted-foreground">
                        Fictional preferred asset
                      </p>
                      <AssetIdentity
                        symbol={payment.primary.symbol}
                        network={payment.primary.network}
                      />
                    </div>
                    <div>
                      <p className="mb-2 text-xs text-muted-foreground">
                        Fictional consented USDC backup
                      </p>
                      <AssetIdentity
                        symbol={payment.backup.symbol}
                        network={payment.backup.network}
                      />
                    </div>
                  </div>
                  <dl className="grid min-w-0 grid-cols-1 gap-3 text-xs sm:grid-cols-3">
                    <div>
                      <dt className="text-muted-foreground">Obligation</dt>
                      <dd className="mt-1 font-medium">
                        <Amount value={payment.amount} />
                      </dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">
                        Maximum routing cost assumption
                      </dt>
                      <dd className="mt-1 font-medium">
                        <Amount value={payment.maxFee} />
                      </dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">
                        Unpaid principal in this example
                      </dt>
                      <dd className="mt-1 font-medium">
                        <Amount value={payment.hypotheticalRemaining} />
                      </dd>
                    </div>
                  </dl>
                  {payment.hypotheticalState === "held_unknown" ? (
                    <p className="rounded-lg bg-amber-50 p-3 text-xs leading-5 text-amber-950">
                      Recoverable held line:{" "}
                      <Amount
                        value={payment.hypotheticalAwaitingReconciliation}
                      />{" "}
                      remains awaiting original reconciliation. Timeout does not
                      prove no-send or permit a backup. No hash, successful
                      receipt or retry authority is fabricated here.
                    </p>
                  ) : payment.hypotheticalState === "replacement_draft" ? (
                    <p className="rounded-lg bg-muted p-3 text-xs leading-5">
                      This branch assumes original no-send was conclusively
                      proved. Original hypothetical state:{" "}
                      {payment.hypotheticalOriginalState}; separate replacement:
                      draft. The liability calculation still counts one unpaid
                      obligation. Real no-send evidence remains unavailable.
                    </p>
                  ) : null}
                  <p className="text-xs leading-5 text-muted-foreground">
                    {payment.backupConsent} The quote, conversion quantity,
                    receiving address and destination receipt are unavailable.
                  </p>
                </article>
              ))}
            </div>
          </Panel>
          <Panel title="Read the spending plan without inventing a balance">
            <div className="grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-3">
              <Metric
                label="Hypothetical planning ceiling"
                value={data.paymentSummary.hypotheticalPlanningCeiling}
              />
              <Metric
                label="Hypothetical budget awaiting reconciliation"
                value={data.paymentSummary.hypotheticalAwaitingReconciliation}
              />
              <Metric
                label="Hypothetical unreserved new-work budget"
                value={data.paymentSummary.hypotheticalUnreserved}
              />
            </div>
            <p className="mt-4 text-sm leading-6 text-muted-foreground">
              Actual available company cash: unavailable. These are
              authorization/planning figures calculated from fictional rows.
              They are not funded balances, a fee quote or a withdrawal promise.
            </p>
          </Panel>
        </>
      ) : (
        <>
          <Panel
            title="Three fictional businesses, one original invoice book"
            description="Each alternative starts with the same 2700 USDC of original invoice faces. Reductions from different paths must stay separate."
          >
            <AssetIdentity symbol="USDC" network="near" />
            <div className="mt-5 grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-3">
              {data.companies.map((company) => (
                <div
                  key={company.id}
                  className="min-w-0 rounded-lg border p-3 text-sm font-medium"
                >
                  {company.name}
                </div>
              ))}
            </div>
            <div className="mt-5">
              <DataTable
                columns={[
                  "Fictional obligation",
                  "Original face",
                  "Noncash setoff (hypothetical)",
                  "Escrow-right discharge (hypothetical)",
                  "Token delivery (hypothetical)",
                  "Remaining liability (hypothetical)",
                ]}
              >
                {data.clearing.rows.map((row) => (
                  <tr key={row.id}>
                    <td className="min-w-56 break-words">
                      {names.get(row.debtor)}{" "}
                      <span aria-label="owes">
                        <ArrowRight
                          className="mx-1 inline-block"
                          size={14}
                          aria-hidden="true"
                        />
                      </span>
                      {names.get(row.creditor)}
                    </td>
                    <td className="text-right tabular-nums">
                      <Amount value={row.originalFace} />
                    </td>
                    <td className="text-right tabular-nums">
                      <Amount value={row.hypotheticalNoncashSetoff} />
                    </td>
                    <td className="text-right tabular-nums">
                      <Amount value={row.hypotheticalFundedDischarge} />
                    </td>
                    <td className="text-right tabular-nums">
                      <Amount value={row.hypotheticalTokenDelivery} />
                    </td>
                    <td className="text-right tabular-nums">
                      <Amount value={row.liability.remaining} />
                    </td>
                  </tr>
                ))}
              </DataTable>
            </div>
            <div className="mt-5 grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <Metric
                label="Original invoice face"
                value={data.clearing.originalFace}
              />
              <Metric
                label="Hypothetical noncash discharge"
                value={data.clearing.hypotheticalNoncashSetoff}
              />
              <Metric
                label="Hypothetical invoice face retired into escrow rights"
                value={data.clearing.hypotheticalFundedDischarge}
              />
              <Metric
                label="Hypothetical actual-token-delivery input"
                value={data.clearing.hypotheticalTokenDelivery}
              />
              <Metric
                label="Hypothetical remaining invoice liability"
                value={data.clearing.hypotheticalRemaining}
              />
            </div>
            <p className="mt-4 text-sm leading-6 text-muted-foreground">
              The token-delivery column is a fictional input to liability
              arithmetic. Actual observed token delivery is unavailable in every
              branch. Noncash setoff, gross invoice retirement and net escrow
              rights do not become earned revenue or shared company cash.
            </p>
          </Panel>
          <Panel
            title="Keep net escrow rights distinct from invoice face"
            description="The current funded-clearing helper computes requirements from original net company positions. It does not observe custody."
          >
            <div className="grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-2">
              <Metric
                label="Calculated original net-debtor deposit requirement"
                value={data.clearing.requiredNetEscrowDeposit}
              />
              <Metric
                label="Hypothetical creditor rights after exact funding/finalization"
                value={data.clearing.hypotheticalEscrowRights}
              />
            </div>
            <div className="mt-5 grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-3">
              {data.clearing.positions.map((position) => (
                <div
                  key={position.companyId}
                  className="min-w-0 rounded-lg border p-4"
                >
                  <h3 className="break-words text-sm font-semibold">
                    {names.get(position.companyId)}
                  </h3>
                  <p className="mt-3 text-xs">
                    Required net deposit:{" "}
                    <Amount value={position.requiredDeposit} />
                  </p>
                  <p className="mt-2 text-xs">
                    Hypothetical net credit right:{" "}
                    <Amount value={position.hypotheticalCreditRight} />
                  </p>
                </div>
              ))}
            </div>
            <p className="mt-4 text-sm leading-6 text-muted-foreground">
              Retiring 2700 USDC of invoice faces in the cash-backed branch
              would require 600 USDC of net debtor backing in this example. It
              would create 600 USDC of net creditor rights, not 2700 USDC of
              token deposits. Actual deposits, funded balances, finalization,
              fixed owner destinations and withdrawal receipts are unavailable.
            </p>
            <p className="mt-3 rounded-lg bg-amber-50 p-3 text-xs leading-5 text-amber-950">
              Recoverable held withdrawal: if a real owner withdrawal were
              submitted with an unknown outcome, its exact original nonce would
              remain held. The product requires reconciliation of that same
              transfer. This preview has no withdrawal operation or successful
              callback.
            </p>
          </Panel>
          <Panel title="What the current clearing calculation does show">
            <dl className="grid min-w-0 grid-cols-1 gap-3 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-muted-foreground">Computation method</dt>
                <dd className="mt-1">
                  Conserved cycle cancellation with bounded maximum-weight
                  circulation
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">
                  Calculation result for this fixed example
                </dt>
                <dd className="mt-1">
                  {data.clearing.algorithm.status} ·{" "}
                  {data.clearing.algorithm.iterations ?? "Unavailable"}{" "}
                  optimizer iterations
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">
                  Debt-only residual transfer volume
                </dt>
                <dd className="mt-1">
                  <Amount value={data.clearing.residualTransferVolume} />
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">
                  Mathematical starting-liquidity lower bound
                </dt>
                <dd className="mt-1">
                  <Amount value={data.clearing.minimumStartingLiquidity} />
                </dd>
              </div>
            </dl>
            <p className="mt-4 text-xs leading-5 text-muted-foreground">
              {data.clearing.minimumLiquidityAssumption} Actual wallet gas and
              settlement fees are unavailable. An optimizer result is not a
              signature, accepted clearing round or proof of execution.
            </p>
          </Panel>
        </>
      )}
      <Panel
        title="Real evidence remains unavailable"
        description="A local calculation does not supply transaction, custody or hardware proof."
      >
        <div className="grid min-w-0 grid-cols-1 gap-3">
          {data.evidence.map((item) => (
            <div
              key={item.claim}
              className="grid min-w-0 grid-cols-1 gap-2 rounded-lg border p-4 sm:grid-cols-[minmax(0,1fr)_auto]"
            >
              <strong className="text-sm">{item.claim}</strong>
              <Status value={item.status} />
              <p className="break-words text-xs leading-5 text-muted-foreground sm:col-span-2">
                {item.detail}
              </p>
            </div>
          ))}
        </div>
        <a
          href="/verify"
          className="mt-5 inline-flex max-w-full items-center gap-2 text-sm font-medium text-primary underline underline-offset-4"
        >
          <ShieldCheck size={16} aria-hidden="true" />
          Open the independent local evidence verifier
        </a>
      </Panel>
      <Panel
        title="Source, build and deployment identity"
        description="Only explicitly published source metadata and configured public pins appear here. No live lookup is performed."
      >
        <dl className="grid min-w-0 grid-cols-1 gap-4 text-xs sm:grid-cols-2">
          <div>
            <dt className="text-muted-foreground">Source revision</dt>
            <dd className="mt-1 break-all font-mono">
              {identity.sourceRevision ??
                "Unavailable - no source revision was published"}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Publisher</dt>
            <dd className="mt-1 break-words">
              {identity.publisher ??
                "Unavailable - publisher identity was not supplied"}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Build time</dt>
            <dd className="mt-1">
              {identity.builtAt ?? "Unavailable - build time was not supplied"}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Configured app network</dt>
            <dd className="mt-1">
              {identity.network ?? "Unavailable"} (not independently observed)
            </dd>
          </div>
        </dl>
        {identity.sourceUrl && (
          <a
            href={identity.sourceUrl}
            rel="noreferrer noopener"
            target="_blank"
            className="mt-4 block w-fit max-w-full break-all text-sm text-primary underline"
          >
            Open publisher-declared source
          </a>
        )}
        <div className="mt-5 grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2">
          {identity.contracts.map((contract) => (
            <div
              key={contract.kind}
              className="grid min-w-0 grid-cols-1 gap-2 rounded-lg border p-3 text-xs"
            >
              <strong className="capitalize">{contract.kind}</strong>
              <p className="break-all">
                Configured account: {contract.accountId ?? "Unavailable"}
              </p>
              <p className="break-all font-mono">
                Expected code pin: {contract.expectedCodeHash ?? "Unavailable"}
              </p>
              <p>
                Published state version:{" "}
                {contract.stateVersion ?? "Unavailable"}
              </p>
              <p className="text-muted-foreground">
                Deployment verification: unavailable
              </p>
            </div>
          ))}
        </div>
        <p className="mt-4 text-xs leading-5 text-muted-foreground">
          {identity.limitation}
        </p>
        <details className="mt-4 min-w-0 text-xs">
          <summary className="cursor-pointer font-medium">
            Reproducible fictional-input identity
          </summary>
          <p className="mt-3 break-all font-mono">
            SHA-256 {data.datasetSha256}
          </p>
          <p className="mt-2 text-muted-foreground">
            This hash identifies only the fixed fictional inputs and branch
            selection. It is not a transaction hash, build signature or hardware
            attestation. Calculation generated {data.calculatedAt}; no execution
            time is implied.
          </p>
        </details>
      </Panel>
      <Panel title="Continue in the actual product">
        <div className="flex flex-wrap gap-4">
          <a
            href="/app"
            className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
          >
            Open company workspace
          </a>
          <a
            href="/receive"
            className="rounded-md border px-4 py-2 text-sm font-medium"
          >
            Open receiving workspace
          </a>
          <a
            href="/help"
            className="inline-flex items-center gap-2 rounded-md border px-4 py-2 text-sm font-medium"
          >
            <BookOpen size={16} aria-hidden="true" />
            Read the product guides
          </a>
        </div>
        <ul className="mt-5 grid min-w-0 grid-cols-1 gap-2 text-xs leading-5 text-muted-foreground">
          {data.limitations.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </Panel>
    </div>
  );
}
function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-lg bg-muted p-4">
      <p className="break-words text-xs leading-5 text-muted-foreground">
        {label}
      </p>
      <p className="mt-2 break-words text-base font-semibold">
        <Amount value={value} />
      </p>
    </div>
  );
}
