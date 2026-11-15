"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowDownToLine, Check, ChevronDown, ChevronRight, Download, FileText, Info, RefreshCw, ShieldCheck, Wallet } from "lucide-react";
import { api, RequestError } from "@/lib/api";
import { microUsd, usd } from "@/lib/format";
import { signNearActions, type NearWalletAction } from "@/lib/near-actions";
import { useWorkspace } from "./context";
import { useAction, useResource } from "./hooks";
import { Action, Address, control, Field, Status } from "./shared";
import { PartialSettlementPanel, partialReviewId } from "./partial-settlement";
import { SettlementProof } from "./settlement-proof";
import type { Payment } from "./types";

interface Attempt { id: string; state: string; destination_network: string; destination_address: string; source_tx_hash: string | null; destination_tx_hash: string | null; provider_status: string | null; amount_in: string }
interface Funding { id: string; reference: string; status: string; provider_status: string | null; origin_asset: string; origin_symbol?: string; origin_network?: string; expected_output: string; credited_amount: string; destination_tx_hash: string | null }
interface Queue { payments: { payment: Payment; attempt: Attempt | null; provenance: string }[]; funding: { funding: Funding; provenance: string }[]; totals: { payments: number; funding: number; unresolvedEntitlementMicroUsdc: string }; page: number; pageSize: number; treasuryNetwork: string | null; more: { payments: boolean; funding: boolean } }
interface PrivateEvidence {id:string;evidence_kind:string;content_hash:string;receipt:string|null;created_at:string;expires_at:string;retained:boolean}
interface Prepared { label: string; paymentId: string; attemptId: string; walletActions: NearWalletAction[]; recordSource: boolean; treasuryNetwork: string; preparation: { path: string; body: object } }

const provenance: Record<string, string> = {
  unexecuted_obligation: "No source transfer recorded",
  near_native_transfer_callback: "Native NEAR token transfer confirmed",
  near_native_transfer_unresolved: "Direct NEAR transfer needs reconciliation",
  owner_reported_external_delivery: "Company reporter attested external delivery",
  near_refund_reconciled_with_reporter_attestation: "Refund reconciled on NEAR with reporter attestation",
  provider_report_only: "Provider report awaiting receipt confirmation",
  unresolved_route: "Delivery remains unresolved",
  unresolved_funding: "Funding has no verified credit yet",
};

export function Reconciliation() {
  const { base } = useWorkspace();
  return <ReconciliationWorkspace key={base} />;
}

function ReconciliationWorkspace() {
  const { base, revision, refresh, notify, organization } = useWorkspace();
  const [page, setPage] = useState(1);
  const [view, setView] = useState<"payments" | "funding">("payments");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [nestedBusy, setNestedBusy] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const reviewHeading = useRef<HTMLHeadingElement>(null);
  const resource = useResource<Queue>(`${base}/reconciliation?page=${page}`, revision);
  const { busy, error, run } = useAction();
  const [evidence,setEvidence]=useState<Record<string,PrivateEvidence[]>>({});
  const [prepared, setPrepared] = useState<Prepared | null>(null);
  const allowed = (permission: string) => organization.permissions?.includes(permission) ?? organization.role === "owner";
  const prepare = (key: string, label: string, paymentId: string, attemptId: string, path: string, input: object | (() => object) = {}, recordSource = false) => run(key, async () => {
    const treasuryNetwork = resource.data?.treasuryNetwork;
    if (!treasuryNetwork) throw new RequestError("Configure the company NEAR treasury first.", 409, "TREASURY_SETUP_REQUIRED");
    const body = typeof input === "function" ? input() : input;
    const result = await api<{ walletActions: NearWalletAction[]; sourceOutcome?: string }>(`${base}${path}`, body);
    if (result.walletActions.length) setPrepared({ label: result.sourceOutcome ? `${label}: ${result.sourceOutcome}` : label, paymentId, attemptId, walletActions: result.walletActions, recordSource, treasuryNetwork, preparation: { path: `${base}${path}`, body } });
    else { refresh(); notify("The recorded payment state has been refreshed."); }
  });
  const submit = () => run("sign", async () => {
    if (!prepared || resource.error || resource.loading) return;
    const fresh = await api<{ walletActions: NearWalletAction[] }>(prepared.preparation.path, prepared.preparation.body);
    if (JSON.stringify(fresh.walletActions) !== JSON.stringify(prepared.walletActions)) {
      setPrepared(null);
      throw new RequestError("The current authorization changed. Prepare and review the original attempt again.", 409, "SETTLEMENT_REVIEW_CHANGED");
    }
    try {
      const txHash = await signNearActions(prepared.walletActions, prepared.treasuryNetwork);
      if (txHash && prepared.recordSource) await api(`${base}/attempts/${prepared.attemptId}/submitted`, { txHash });
      await api(`${base}/payments/${prepared.paymentId}/reconcile`, {});
      notify("Wallet action recorded. Check the reconciled status before retrying.");
      refresh();
    } finally { setPrepared(null); }
  });
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const read = () => setNestedBusy(Boolean(element.querySelector('[aria-busy="true"]')));
    const observer = new MutationObserver(read);
    observer.observe(element, { subtree: true, childList: true, attributes: true, attributeFilter: ["aria-busy"] });
    read();
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (prepared) reviewHeading.current?.focus();
  }, [prepared]);
  const queue = resource.data;
  const locked = !!busy || nestedBusy;
  const navigatingLocked = locked || !!prepared || resource.loading;
  const total = queue ? queue.totals.payments + queue.totals.funding : 0;
  const currentRows = view === "payments" ? queue?.payments : queue?.funding;
  const hasMore = queue?.more[view] ?? false;
  const selectView = (next: "payments" | "funding") => {
    if (navigatingLocked) return;
    setView(next);
    setPage(1);
  };
  const toggleRecord = (id: string) => {
    if (navigatingLocked) return;
    setExpanded(current => current === id ? null : id);
  };

  return (
    <div ref={container} className="grid min-w-0 gap-6">
      <header className="flex flex-wrap items-start justify-between gap-4 px-1">
        <div>
          <h2 className="text-xl font-medium tracking-tight">Reconciliation</h2>
          <p className="mt-1.5 text-sm text-muted-foreground">Resolve payment exceptions and confirm incoming funds.</p>
        </div>
        {allowed("reports:read") && (
          <details className="group relative w-full max-w-full sm:w-auto">
            <summary className="inline-flex min-h-10 cursor-pointer list-none items-center gap-2 rounded-full border bg-white px-4 text-sm font-medium after:hidden hover:bg-muted">
              <Download size={15} aria-hidden="true" />Export<ChevronDown size={14} aria-hidden="true" />
            </summary>
            <div className="mt-3 w-full rounded-2xl border bg-white p-5 shadow-lg sm:absolute sm:right-0 sm:z-20 sm:mt-2 sm:w-80">
              <p className="text-sm font-medium">Accounting export</p>
              <p className="mt-2 text-xs leading-5 text-muted-foreground">Includes every record, across all pages. Filter by record type before calculating totals.</p>
              <a className="mt-4 inline-flex min-h-10 items-center gap-2 rounded-full bg-primary px-4 text-sm font-medium text-white" href={"/api" + base + "/reconciliation/export"}>
                <Download size={15} aria-hidden="true" />Download CSV
              </a>
              <details className="mt-4 border-t pt-3 text-xs">
                <summary className="cursor-pointer font-medium">How to read the export</summary>
                <ul className="mt-3 space-y-2 leading-5 text-muted-foreground">
                  <li>Invoice and payroll item rows summarize the liability, delivered amount, remaining principal and recorded costs.</li>
                  <li>Obligation rows include each authorization and its replacements. Attempt and receipt rows contain settlement evidence.</li>
                  <li>Do not add summary rows to linked obligation rows. Reservation ledger entries are not transfers.</li>
                </ul>
              </details>
            </div>
          </details>
        )}
      </header>

      <div className="grid grid-cols-1 divide-y rounded-3xl border bg-white sm:grid-cols-3 sm:divide-x sm:divide-y-0">
        <ReviewMetric label="Payments to review" value={queue ? String(queue.totals.payments) : null} icon={<FileText size={16} />} />
        <ReviewMetric label="Unresolved amount" value={queue ? usd(queue.totals.unresolvedEntitlementMicroUsdc) : null} suffix="USDC" icon={<Wallet size={16} />} />
        <ReviewMetric label="Funding to verify" value={queue ? String(queue.totals.funding) : null} icon={<ArrowDownToLine size={16} />} />
      </div>

      {(error || resource.error) && (
        <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-destructive/20 bg-red-50/40 px-5 py-4 text-sm text-destructive">
          <p className="min-w-0 flex-1">{error || resource.error}</p>
          {resource.error && <button type="button" className="font-medium underline underline-offset-4" disabled={locked} onClick={refresh}>Try again</button>}
        </div>
      )}

      {prepared && (
        <section aria-labelledby="reconciliation-wallet-review" className="rounded-3xl border border-primary/20 bg-secondary/40 p-5 sm:p-6">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="mb-2 text-xs font-medium text-primary">Wallet confirmation</p>
              <h3 ref={reviewHeading} tabIndex={-1} id="reconciliation-wallet-review" className="text-lg font-medium tracking-tight outline-none">{prepared.label}</h3>
              <p className="mt-2 text-sm text-muted-foreground">Your owner or appointed signer confirms this action on {prepared.treasuryNetwork}.</p>
            </div>
            <button type="button" className="rounded-full px-3 py-2 text-sm font-medium hover:bg-white" disabled={!!busy} onClick={() => setPrepared(null)}>Cancel review</button>
          </div>
          <details className="mt-5 rounded-2xl border bg-white p-4">
            <summary className="cursor-pointer text-sm font-medium">Exact wallet actions</summary>
            <pre className="mt-3 max-h-64 overflow-auto rounded-xl bg-muted p-3 text-xs">{JSON.stringify(prepared.walletActions, null, 2)}</pre>
          </details>
          <div className="mt-5 flex justify-end">
            <Action busy={busy === "sign"} disabled={!!busy || !!resource.error || resource.loading} onClick={() => void submit()}>
              {busy === "sign" ? "Confirming wallet action..." : "Confirm in NEAR wallet"}
            </Action>
          </div>
        </section>
      )}

      <section className="min-w-0 overflow-hidden rounded-3xl border bg-white" aria-label="Review queue">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-4 sm:px-6">
          <div className="flex flex-wrap gap-1" role="group" aria-label="Reconciliation record type">
            {(["payments", "funding"] as const).map(kind => (
              <button key={kind} type="button" aria-pressed={view === kind} disabled={navigatingLocked}
                onClick={() => selectView(kind)}
                className={"inline-flex min-h-10 items-center gap-2 rounded-full px-4 text-sm font-medium transition-colors disabled:opacity-60 " + (view === kind ? "bg-foreground text-white" : "text-muted-foreground hover:bg-muted hover:text-foreground")}>
                {kind === "payments" ? "Payments" : "Funding"}
                {queue && <span className={"min-w-5 rounded-full px-1.5 py-0.5 text-center text-[11px] tabular-nums " + (view === kind ? "bg-white/15" : "bg-muted")}>{queue.totals[kind]}</span>}
              </button>
            ))}
          </div>
          {queue && !resource.error && <span className="text-xs text-muted-foreground">{total === 0 ? "All caught up" : total + (total === 1 ? " item needs review" : " items need review")}</span>}
        </div>

        {resource.loading ? <QueueLoading /> : resource.error ? (
          <QueueEmpty title="Review queue unavailable" description="Refresh to load the latest payment and funding records." icon={<RefreshCw size={22} />} />
        ) : !queue ? null : (
          <>
            <div hidden={view !== "payments"}>
              {!queue.payments.length ? (
                <QueueEmpty
                  title={queue.totals.payments === 0 ? "No payments need review" : "No payments on this page"}
                  description={queue.totals.payments === 0 ? "Payment exceptions will appear here when they need your attention." : "Return to an earlier page to review outstanding payments."}
                  icon={<Check size={24} />}
                />
              ) : (
                <div className="divide-y">
                  {queue.payments.map(({ payment, attempt, provenance: source }) => {
                    const recordId = "payment-" + payment.id;
                    return (
                      <ReviewRecord key={payment.id} id={recordId} title={payment.reference} subtitle={payment.recipientName ?? "Recorded recipient"}
                        amount={usd(payment.amount)} status={payment.status} open={expanded === recordId} disabled={navigatingLocked} onToggle={() => toggleRecord(recordId)}>
                        <div className="flex flex-wrap items-start justify-between gap-4">
                          <div className="min-w-0 flex-1">
                            <p className="text-sm font-medium">{provenance[source] ?? source.replaceAll("_", " ")}</p>
                            {payment.hold_reason && <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">{payment.hold_reason}</p>}
                          </div>
                          <Action className="border bg-white text-foreground hover:bg-muted" busy={busy === payment.id + ":check"} disabled={!!busy}
                            onClick={() => void run(payment.id + ":check", async () => { await api(base + "/payments/" + payment.id + "/reconcile", {}); refresh(); })}>
                            <RefreshCw size={14} aria-hidden="true" />Check status
                          </Action>
                        </div>

                        {attempt?.state === "prepared" && allowed("payments:execute") && (
                          <div className="flex flex-wrap items-center gap-3 rounded-2xl bg-muted p-4">
                            <Action busy={busy === attempt.id + ":resume"} disabled={!!busy}
                              onClick={() => void prepare(attempt.id + ":resume", "Resume payment authorization", payment.id, attempt.id, "/attempts/" + attempt.id + "/resume", {}, true)}>Review remaining steps</Action>
                            <button type="button" className="min-h-10 rounded-full px-3 text-sm font-medium text-muted-foreground hover:text-foreground disabled:opacity-50" disabled={!!busy}
                              onClick={() => void prepare(attempt.id + ":close", "Close an unsent route", payment.id, attempt.id, "/attempts/" + attempt.id + "/close")}>Close unsent route</button>
                          </div>
                        )}

                        {attempt?.state === "reported_delivered" && allowed("payments:approve") && (
                          <form className="grid gap-4 rounded-2xl border bg-white p-5" onSubmit={event => {
                            event.preventDefault();
                            const values = new FormData(event.currentTarget);
                            void prepare(attempt.id + ":delivery", "Attest external delivery", payment.id, attempt.id, "/attempts/" + attempt.id + "/settlement", { outcome: "delivered", receipt: values.get("receipt") });
                          }}>
                            <div><h4 className="font-medium">Confirm reported delivery</h4><p className="mt-1 text-xs leading-5 text-muted-foreground">A provider report needs the company reporter's confirmation.</p></div>
                            <Field label="Delivery evidence"><input className={control} name="receipt" required maxLength={2000} defaultValue={attempt.destination_tx_hash ?? ""} placeholder="Checked transaction or receipt" /></Field>
                            <label className="flex items-start gap-3 text-sm leading-6"><input type="checkbox" required className="mt-1.5 size-4 shrink-0 accent-primary" /><span>I checked delivery to the confirmed recipient. The treasury will trust this owner or reporter attestation.</span></label>
                            <div className="flex justify-end border-t pt-4"><Action disabled={!!busy} busy={busy === attempt.id + ":delivery"}>Review delivery report</Action></div>
                          </form>
                        )}

                        {(attempt?.state === "reported_partial" || payment.status === "partially_paid" || partialReviewId(payment) !== payment.id) && <PartialSettlementPanel paymentId={partialReviewId(payment)} />}

                        {attempt && ["unknown", "processing", "submitted"].includes(attempt.state) && allowed("payments:approve") && (
                          <details className="rounded-2xl border bg-white p-5">
                            <summary className="cursor-pointer text-sm font-medium">Recover the original NEAR transfer</summary>
                            <p className="mt-3 max-w-xl text-xs leading-5 text-muted-foreground">Use the original wallet transaction. Razor verifies its final token receipt before preparing recovery for this attempt.</p>
                            <form className="mt-4 grid gap-4 sm:grid-cols-2" onSubmit={event => {
                              event.preventDefault();
                              const values = new FormData(event.currentTarget);
                              void prepare(attempt.id + ":source", "Recover final NEAR source outcome", payment.id, attempt.id, "/reconciliation/attempts/" + attempt.id + "/source", { senderAccountId: String(values.get("sender")).trim().toLowerCase(), transactionHash: String(values.get("hash")).trim() });
                            }}>
                              <Field label="Original NEAR signer"><input name="sender" className={control} required minLength={2} maxLength={64} autoCapitalize="none" spellCheck={false} placeholder="signer.near" /></Field>
                              <Field label="Original transaction hash"><input name="hash" className={control} required minLength={32} maxLength={64} defaultValue={attempt.source_tx_hash ?? ""} autoCapitalize="none" spellCheck={false} /></Field>
                              <div className="flex justify-end border-t pt-4 sm:col-span-2"><Action disabled={!!busy} busy={busy === attempt.id + ":source"}>Verify and review recovery</Action></div>
                            </form>
                          </details>
                        )}

                        {attempt && ["recovery_pending", "unknown"].includes(attempt.state) && allowed("payments:approve") && (
                          <details className="rounded-2xl border bg-white p-5">
                            <summary className="cursor-pointer text-sm font-medium">Review a closed route or refund</summary>
                            <form className="mt-4 grid gap-4" onSubmit={event => {
                              event.preventDefault();
                              const values = new FormData(event.currentTarget), action = values.get("action");
                              void prepare(attempt.id + ":refund", action === "confirm" ? "Confirm recovered funds" : "Report refund pending", payment.id, attempt.id, "/attempts/" + attempt.id + "/" + (action === "confirm" ? "refund" : "settlement"), () => {
                                let refundAmount = "0";
                                if (action === "confirm") {
                                  try { refundAmount = microUsd(String(values.get("refundAmount")), true); }
                                  catch (cause) { throw new RequestError((cause as Error).message, 422, "INVALID_REFUND_AMOUNT"); }
                                }
                                return action === "confirm" ? { refundAmount, receipt: values.get("receipt") } : { outcome: "refund_pending", receipt: values.get("receipt") };
                              });
                            }}>
                              <Field label="Recovery stage"><select name="action" className={control}><option value="report">Route closed, refund pending</option><option value="confirm">Funds returned on NEAR</option></select></Field>
                              <div className="grid gap-4 sm:grid-cols-2">
                                <Field label="Recovered USDC" hint="The amount returned for this attempt."><input name="refundAmount" className={control} inputMode="decimal" defaultValue="0" /></Field>
                                <Field label="Refund or closure evidence"><input name="receipt" className={control} required maxLength={2000} placeholder="Verified transaction or route closure" /></Field>
                              </div>
                              <label className="flex items-start gap-3 text-sm leading-6"><input type="checkbox" required className="mt-1.5 size-4 shrink-0 accent-primary" /><span>I checked that the earlier route cannot deliver. When confirming returned funds, I verified this attempt's refund. A treasury balance alone does not identify it.</span></label>
                              <div className="flex justify-end border-t pt-4"><Action disabled={!!busy} busy={busy === attempt.id + ":refund"}>Review recovery authorization</Action></div>
                            </form>
                          </details>
                        )}

                        {attempt && (
                          <details className="rounded-2xl border bg-white p-5">
                            <summary className="cursor-pointer text-sm font-medium">Transaction details and evidence</summary>
                            <div className="mt-4 grid gap-5">
                              <div className="grid gap-4 sm:grid-cols-2">
                                <div><p className="mb-2 text-xs text-muted-foreground">Receiving wallet on {attempt.destination_network}</p><Address value={attempt.destination_address} network={attempt.destination_network} /></div>
                                <div className="space-y-2 break-all text-xs text-muted-foreground">
                                  {attempt.source_tx_hash && <p>NEAR source: <span className="font-mono text-foreground">{attempt.source_tx_hash}</span></p>}
                                  {attempt.destination_tx_hash && <p>Reported destination: <span className="font-mono text-foreground">{attempt.destination_tx_hash}</span></p>}
                                </div>
                              </div>
                              <div className="flex flex-wrap items-center gap-4 border-t pt-4">
                                <button type="button" className="min-h-10 text-sm font-medium text-primary disabled:opacity-50" disabled={!!busy} onClick={() => void run("evidence:" + attempt.id, async () => {
                                  const result = await api<{ evidence: PrivateEvidence[] }>(base + "/reconciliation/attempts/" + attempt.id + "/evidence");
                                  setEvidence(current => ({ ...current, [attempt.id]: result.evidence }));
                                })}>Inspect private evidence</button>
                                <a className="inline-flex min-h-10 items-center gap-2 text-sm text-muted-foreground" href={"/api" + base + "/reconciliation/attempts/" + attempt.id + "/evidence?download=1"} download><Download size={14} aria-hidden="true" />Export evidence</a>
                              </div>
                              {evidence[attempt.id] && (evidence[attempt.id].length ? (
                                <div className="space-y-4 rounded-xl bg-muted p-4 text-xs">
                                  {evidence[attempt.id].map(record => <div key={record.id}>
                                    <p className="font-medium">{record.evidence_kind.replaceAll(":", " ")}</p>
                                    <p className="mt-2 whitespace-pre-wrap break-words leading-5">{record.retained ? record.receipt : "Private receipt removed after its retention period. The commitment remains in financial history."}</p>
                                    <p className="mt-2 break-all font-mono">sha256:{record.content_hash}</p>
                                    <p className="mt-2 text-muted-foreground">Retention ends {new Date(record.expires_at).toLocaleString()}</p>
                                  </div>)}
                                </div>
                              ) : <p className="text-xs leading-5 text-muted-foreground">No private receipt was retained. Review the recorded transactions and settlement source.</p>)}
                              <SettlementProof attemptId={attempt.id} onReportPrepared={plan => {
                                void prepare("structured:" + attempt.id, "Review structured delivery report", payment.id, attempt.id, "/attempts/" + attempt.id + "/settlement", { outcome: "delivered", receipt: plan.statement });
                              }} />
                            </div>
                          </details>
                        )}
                      </ReviewRecord>
                    );
                  })}
                </div>
              )}
            </div>

            <div hidden={view !== "funding"}>
              {!queue.funding.length ? (
                <QueueEmpty title={queue.totals.funding === 0 ? "No funding needs verification" : "No funding on this page"}
                  description={queue.totals.funding === 0 ? "Incoming deposits that need a receipt check will appear here." : "Return to an earlier page to review outstanding funding."} icon={<ArrowDownToLine size={24} />} />
              ) : (
                <div className="divide-y">
                  {queue.funding.map(({ funding, provenance: source }) => {
                    const recordId = "funding-" + funding.id;
                    return (
                      <ReviewRecord key={funding.id} id={recordId} title={funding.reference}
                        subtitle={(funding.origin_symbol ?? "Source asset") + (funding.origin_network ? " on " + funding.origin_network : "")}
                        amount={usd(funding.expected_output)} status={funding.status} open={expanded === recordId} disabled={navigatingLocked} onToggle={() => toggleRecord(recordId)}>
                        <div className="flex flex-wrap items-start justify-between gap-4">
                          <div><p className="text-sm font-medium">{provenance[source] ?? source.replaceAll("_", " ")}</p><p className="mt-2 text-xs text-muted-foreground">Verified credit: <span className="font-medium text-foreground">{usd(funding.credited_amount)} USDC</span></p></div>
                          {allowed("payments:prepare") && <Action className="border bg-white text-foreground hover:bg-muted" busy={busy === funding.id + ":check"} disabled={!!busy} onClick={() => void run(funding.id + ":check", async () => { await api(base + "/funding/" + funding.id + "/reconcile", {}); refresh(); })}><RefreshCw size={14} aria-hidden="true" />Check status</Action>}
                        </div>
                        {funding.destination_tx_hash && <a className="w-fit text-xs font-medium text-primary underline underline-offset-4" target="_blank" rel="noreferrer" href={"https://nearblocks.io/txns/" + encodeURIComponent(funding.destination_tx_hash)}>View NEAR transaction</a>}
                        {allowed("payments:prepare") && (
                          <form className="grid gap-4 rounded-2xl border bg-white p-5" onSubmit={event => {
                            event.preventDefault();
                            const values = new FormData(event.currentTarget);
                            void run(funding.id + ":verify", async () => {
                              const hash = String(values.get("hash") ?? "").trim();
                              await api(base + "/reconciliation/funding/" + funding.id + "/verify", { senderAccountId: String(values.get("sender") ?? "").trim().toLowerCase() || undefined, ...(hash ? { transactionHash: hash } : {}) });
                              notify("Final NEAR receipt verified. Funding credit recorded once.");
                              refresh();
                            });
                          }}>
                            <div><h4 className="text-sm font-medium">Verify this deposit</h4><p className="mt-1.5 text-xs leading-5 text-muted-foreground">Razor checks the final NEAR token receipt. A verified deposit is credited only once.</p></div>
                            <details className="rounded-xl bg-muted p-4">
                              <summary className="cursor-pointer text-sm font-medium">Manual receipt lookup</summary>
                              <div className="mt-4 grid gap-4 sm:grid-cols-2">
                                <Field label="Destination signer (optional)" hint="Use the signer shown by the NEAR explorer."><input name="sender" className={control} minLength={2} maxLength={64} autoCapitalize="none" spellCheck={false} placeholder="signer.near" /></Field>
                                <Field label="Transaction hash (optional)" hint="Leave empty for automatic lookup."><input name="hash" className={control} maxLength={64} defaultValue={funding.destination_tx_hash ?? ""} autoCapitalize="none" spellCheck={false} /></Field>
                              </div>
                            </details>
                            <div className="flex justify-end border-t pt-4"><Action busy={busy === funding.id + ":verify"} disabled={!!busy}><ShieldCheck size={15} aria-hidden="true" />Verify funding receipt</Action></div>
                          </form>
                        )}
                      </ReviewRecord>
                    );
                  })}
                </div>
              )}
            </div>
          </>
        )}

        {queue && !resource.loading && !resource.error && (page > 1 || hasMore) && (
          <div className="flex flex-wrap items-center justify-between gap-3 border-t px-5 py-4">
            <button type="button" className="min-h-10 rounded-full border px-4 text-sm font-medium hover:bg-muted disabled:opacity-40" disabled={navigatingLocked || page === 1} onClick={() => setPage(value => value - 1)}>Previous</button>
            <span className="text-xs text-muted-foreground">Page {page}{currentRows?.length ? " - " + currentRows.length + " records" : ""}</span>
            <button type="button" className="min-h-10 rounded-full border px-4 text-sm font-medium hover:bg-muted disabled:opacity-40" disabled={navigatingLocked || !hasMore} onClick={() => setPage(value => value + 1)}>Next</button>
          </div>
        )}
      </section>
      <p className="flex items-start gap-2 px-1 text-xs leading-5 text-muted-foreground"><Info size={14} className="mt-0.5 shrink-0" aria-hidden="true" />An unresolved payment stays on hold until its original outcome is confirmed.</p>
    </div>
  );
}

function ReviewMetric({ label, value, suffix, icon }: { label: string; value: string | null; suffix?: string; icon: ReactNode }) {
  return <div className="flex min-w-0 items-center justify-between gap-4 px-5 py-4 sm:block sm:px-6 sm:py-6">
    <div className="flex items-center justify-between gap-3"><p className="text-xs text-muted-foreground">{label}</p><span className="text-muted-foreground/70" aria-hidden="true">{icon}</span></div>
    {value === null ? <div className="h-8 w-24 animate-pulse rounded-lg bg-muted sm:mt-4" /> : <p className="break-words text-right text-2xl font-medium tracking-tight tabular-nums sm:mt-3 sm:text-left sm:text-3xl">{value}{suffix && <span className="ml-2 text-xs font-normal tracking-normal text-muted-foreground">{suffix}</span>}</p>}
  </div>;
}

function ReviewRecord({ id, title, subtitle, amount, status, open, disabled, onToggle, children }: { id: string; title: string; subtitle: string; amount: string; status: string; open: boolean; disabled: boolean; onToggle: () => void; children: ReactNode }) {
  return <article className={open ? "bg-muted/35" : "bg-white"}>
    <button type="button" aria-expanded={open} aria-controls={id} onClick={onToggle} disabled={disabled}
      className="grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-3 p-5 text-left transition-colors hover:bg-muted/60 focus-visible:-outline-offset-4 disabled:cursor-default sm:grid-cols-[minmax(0,1fr)_auto_minmax(9rem,auto)_5rem] sm:px-6">
      <span className="min-w-0"><span className="block break-words text-sm font-medium">{title}</span><span className="mt-1 block break-words text-xs text-muted-foreground">{subtitle}</span></span>
      <span className="min-w-0 max-w-40 text-right"><span className="block break-all text-base font-medium tabular-nums">{amount}</span><span className="mt-1 block text-[11px] text-muted-foreground">USDC</span></span>
      <span className="min-w-0 sm:text-right"><Status value={status} /></span>
      <span className="ml-auto inline-flex items-center gap-1.5 text-xs font-medium text-primary">{open ? "Close" : "Review"}{open ? <ChevronDown size={15} aria-hidden="true" /> : <ChevronRight size={15} aria-hidden="true" />}</span>
    </button>
    <div id={id} hidden={!open} className="space-y-4 border-t px-5 py-5 sm:px-6 sm:py-6">{children}</div>
  </article>;
}

function QueueEmpty({ title, description, icon }: { title: string; description: string; icon: ReactNode }) {
  return <div className="flex flex-col items-center px-6 py-14 text-center sm:py-16">
    <span className="mb-4 grid size-12 place-items-center rounded-2xl bg-secondary text-primary" aria-hidden="true">{icon}</span>
    <h3 className="text-base font-medium">{title}</h3>
    <p className="mt-2 max-w-sm text-sm leading-6 text-muted-foreground">{description}</p>
  </div>;
}

function QueueLoading() {
  return <div role="status" aria-label="Loading reconciliation" className="divide-y">
    {[0, 1, 2].map(index => <div key={index} className="flex items-center justify-between gap-6 px-6 py-6"><div className="space-y-2"><div className="h-4 w-28 animate-pulse rounded bg-muted" /><div className="h-3 w-40 animate-pulse rounded bg-muted" /></div><div className="h-7 w-24 animate-pulse rounded-lg bg-muted" /></div>)}
    <span className="sr-only">Loading reconciliation records...</span>
  </div>;
}
