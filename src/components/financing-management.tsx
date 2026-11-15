"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ChevronRight, Plus } from "lucide-react";
import { TaskDrawer, openTaskDrawer, closeTaskDrawer, withTaskDrawerWallet } from "./workspace/task-drawer";
import { api } from "@/lib/api";
import { parseUnits, formatUnits } from "@/lib/money";
import { usd } from "@/lib/format";
import { signNearActionBatch, type NearWalletAction } from "@/lib/near-actions";
import { AssetIdentity } from "@/components/assets/asset-identity";
import type { FinancingAction, FinancingRequest, listCompanyFinancing, marketFinancing, ownFinancing } from "@/server/financing/service";
import { useIdentity } from "./auth/identity-provider";
import { useAction, useResource } from "./workspace/hooks";
import { Action, Address, control, Empty, Field, Panel, Status } from "./workspace/shared";

type CompanyList = ReturnType<typeof listCompanyFinancing>;
type List = ReturnType<typeof marketFinancing> | ReturnType<typeof ownFinancing>;
type Task = "offer" | "accept" | "deposit" | "recovery" | "evidence" | "wallet";
type Offer = FinancingRequest["offers"][number];
type Review = { plan: FinancingAction; request: FinancingRequest; action: string; input: Record<string, unknown> };
const secondary = "border border-border bg-white text-foreground hover:bg-muted";
const titles: Record<Task, string> = { offer: "Make an offer", accept: "Accept an offer", deposit: "Fund or repay", recovery: "Recover an advance", evidence: "Verify financing receipt", wallet: "Review transaction" };
const actionNames: Record<string, string> = { register: "Register agreement", advance: "Advance to treasury", principal: "Fund principal", collateral: "Fund collateral", repayment: "Repay loan", cancel: "Cancel agreement", withdraw: "Withdraw credit", default: "Apply collateral to debt", dispute: "Raise dispute", resume: "Resume agreement", recover_advance: "Recover advance", void_deposit: "Void unresolved deposit" };

function Terms({ request, offer }: { request: FinancingRequest; offer?: Offer }) {
  const terms = request.agreement ?? offer;
  const values = [
    ["Principal", usd(request.terms.principal)],
    ...(terms ? [["Fixed interest", usd(terms.interest)], ["Lender fee", usd(terms.fee)], ["Total repayment", usd((BigInt(request.terms.principal) + BigInt(terms.interest) + BigInt(terms.fee)).toString())]] : [["Interest + fee ceiling", usd(request.terms.maxCost)]]),
    ["Collateral bond", usd(request.terms.collateral)],
    ["Term from advance", `${request.terms.tenorDays} days`],
    ["Grace period", `${request.terms.graceDays} days`],
    ["Funding deadline", new Date(request.terms.fundBy).toLocaleString()],
    ...(offer ? [["Offer expires", new Date(offer.expiresAt).toLocaleString()]] : []),
  ];
  return <dl className="grid grid-cols-2 gap-x-5 gap-y-4 rounded-2xl bg-muted/60 p-4 text-sm">{values.map(([label, value]) => <div key={label} className="min-w-0"><dt className="text-xs text-muted-foreground">{label}</dt><dd className="mt-1 break-words font-medium tabular-nums">{value}</dd></div>)}</dl>;
}

function LoanRisk({ assigned }: { assigned: boolean }) {
  return <ul className="space-y-2 text-xs leading-5 text-muted-foreground"><li>Terms and repayment descriptions are public on NEAR. Funding and repayment are not guaranteed.</li><li>Repayment pays principal, interest, then fees. Default can use only this loan's bond; any shortfall remains due.</li><li>Unused bond returns to the borrower. Disputes require both parties to resume unchanged terms.</li>{assigned && <li>Receivable assignment covers Razor only. External liens and collection are unverified.</li>}</ul>;
}

export function FinancingManagement({ base, canManage = false, revision = 0, onRefresh }: { base?: string; canManage?: boolean; revision?: number; onRefresh?: () => void }) {
  const company = !!base, endpoint = base ? `${base}/financing` : "/financing";
  const { session, signInWallet } = useIdentity();
  const [tick, setTick] = useState(0), [page, setPage] = useState(1), [tab, setTab] = useState<"market" | "loans">("loans");
  const [selected, setSelected] = useState(""), [task, setTask] = useState<Task | null>(null), [preview, setPreview] = useState<Review | null>(null);
  const [confirmed, setConfirmed] = useState(false), [notice, setNotice] = useState(""), [offerId, setOfferId] = useState(""), [offerRisk, setOfferRisk] = useState("");
  const [depositKind, setDepositKind] = useState("repayment"), [recoveryCreditId, setRecoveryCreditId] = useState("");
  const requests = useResource<CompanyList | List>(session ? company ? `${endpoint}?page=${page}` : `${endpoint}/${tab}?page=${page}` : null, revision + tick);
  const detail = useResource<{ request: FinancingRequest }>(session && selected ? `${endpoint}/${selected}` : null, revision + tick);
  const current = detail.data?.request, { busy, error, run, setError } = useAction(), keys = useRef(new Map<string, string>());
  const identity = useRef({ selected, endpoint }); identity.current = { selected, endpoint };
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const blocked = !!busy || detail.refreshing || !!detail.error;
  const isBorrower = !!current?.agreement && session?.wallets.some(wallet => wallet.family === "near" && wallet.network === current.scope.network && wallet.address === current.agreement!.borrower);
  const isLender = !!current?.agreement && session?.wallets.some(wallet => wallet.family === "near" && wallet.network === current.scope.network && wallet.address === current.agreement!.lender);
  const scopes = requests.data && "scopes" in requests.data ? requests.data.scopes : [];
  const accounts = session?.wallets.filter(wallet => wallet.family === "near" && (!current || wallet.network === current.scope.network)) ?? [];
  const selectedOffer = current?.offers.find(offer => offer.id === offerId);
  const consentKey = current && selectedOffer ? JSON.stringify([current.id, current.terms, selectedOffer.offerHash]) : "";
  useEffect(() => {
    const drawer = document.getElementById("financing-action-flow");
    const closed = () => { if (drawer?.dataset.walletSuspended !== "true") { setTask(null); setPreview(null); setConfirmed(false); setOfferRisk(""); } };
    drawer?.addEventListener("close", closed);
    if (task) openTaskDrawer("financing-action-flow"); else closeTaskDrawer("financing-action-flow", true);
    return () => drawer?.removeEventListener("close", closed);
  }, [task]);
  function refresh() { setTick(value => value + 1); onRefresh?.(); }
  function key(value: unknown) { const digest = JSON.stringify(value), existing = keys.current.get(digest) ?? crypto.randomUUID(); keys.current.set(digest, existing); return existing; }
  function amount(value: FormDataEntryValue | null) { return parseUnits(String(value ?? "0")); }
  function finishTask() { closeTaskDrawer("financing-action-flow", true); setTask(null); setPreview(null); setConfirmed(false); setOfferRisk(""); }
  function openTask(value: Task) { setError(""); setConfirmed(false); setOfferRisk(""); setTask(value); requestAnimationFrame(() => openTaskDrawer("financing-action-flow")); }
  function choose(id: string) { finishTask(); setSelected(id); setRecoveryCreditId(""); setNotice(""); setError(""); }
  async function prepare(action: string, extra: Record<string, unknown> = {}) {
    if (!current || detail.refreshing || detail.error) return;
    const request = current, input = { action, ...extra }, path = endpoint;
    const plan = await api<FinancingAction>(`${path}/${request.id}/action`, input);
    if (!mounted.current || identity.current.selected !== request.id || identity.current.endpoint !== path) return;
    setConfirmed(false); setPreview({ plan, request, action, input }); setTask("wallet");
  }
  function review(action: string, extra: Record<string, unknown> = {}) { void run(`review-${action}`, () => prepare(action, extra)); }
  async function sign() {
    if (!preview || !confirmed || blocked) return;
    const reviewed = preview, plan = reviewed.plan;
    await run("sign-financing", async () => {
      const fresh = await api<FinancingAction>(`${endpoint}/${plan.requestId}/action`, reviewed.input);
      if (!mounted.current || identity.current.selected !== plan.requestId || identity.current.endpoint !== endpoint) return;
      if (JSON.stringify([fresh.reviewHash, fresh.agreementHash, fresh.walletActions, fresh.eligibleSigners, fresh.actionId]) !== JSON.stringify([plan.reviewHash, plan.agreementHash, plan.walletActions, plan.eligibleSigners, plan.actionId])) {
        finishTask(); refresh(); throw new Error("Transaction terms changed. Open a fresh review before signing.");
      }
      try {
        const result = await withTaskDrawerWallet(() => signNearActionBatch(plan.walletActions as NearWalletAction[], plan.network, plan.eligibleSigners, async signerAccount => {
          if (plan.actionId) await api(`${endpoint}/${plan.requestId}/begin`, { actionId: plan.actionId, reviewHash: plan.reviewHash, signerAccount });
        }));
        await api(`${endpoint}/${plan.requestId}/reconcile`, {});
        setNotice(result.complete ? "Contract refreshed. Verify the treasury receipt separately after an advance." : "Wallet result incomplete. Reconcile before trying again.");
      } finally { finishTask(); refresh(); }
    });
  }
  function unavailable(action: string) {
    if (!current) return true;
    return blocked || (action === "withdraw" ? !!current.chain?.pending || !((isBorrower && BigInt(current.chain?.borrower_refund ?? "0") > 0n) || (isLender && BigInt(current.chain?.lender_credit ?? "0") > 0n))
      : action === "recover_advance" ? current.chain?.pending?.kind !== "advance"
      : action === "resume" ? !current.chain?.disputed
      : action === "default" ? current.chain?.stage !== "active" || !!current.chain?.disputed || !!current.chain.pending || !current.chain.due_at_ms || Date.now() < Number(current.chain.due_at_ms) + current.terms.graceDays * 86400000
      : action === "dispute" ? !current.chain || !!current.chain.disputed || !!current.chain.pending || !["funding", "active", "defaulted"].includes(current.chain.stage)
      : (!!current.chain && current.chain.stage !== "funding") || !!current.chain?.pending || !!current.chain?.disputed);
  }
  if (!session) return <Panel title="Working capital"><Empty>Sign in to view financing.</Empty><a href="/sign-in" className="mt-4 inline-block text-sm text-primary">Sign in</a></Panel>;
  return <Panel title={selected ? current?.companyName ?? "Working capital" : company ? "Working capital" : "Financing"} tone="white" action={!selected && company && canManage ? <Action disabled={!!busy || requests.refreshing || !!requests.error} onClick={() => { setError(""); openTaskDrawer("financing-request-flow"); }}><Plus size={16}/> New request</Action> : undefined}>
    <div className="grid min-w-0 gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        {selected ? <button type="button" disabled={!!busy} className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground" onClick={() => choose("")}><ArrowLeft size={16}/> All {company ? "requests" : "financing"}</button> : !company ? <div className="flex gap-1 rounded-full bg-muted p-1">{(["loans", "market"] as const).map(value => <button key={value} type="button" disabled={!!busy} className={`rounded-full px-4 py-2 text-sm ${tab === value ? "bg-white shadow-sm" : "text-muted-foreground"}`} onClick={() => { setTab(value); setPage(1); choose(""); }}>{value === "market" ? "Opportunities" : "My agreements"}</button>)}</div> : <AssetIdentity symbol="USDC" network="near"/>}
        <div className="flex flex-wrap gap-3"><button type="button" className="text-sm text-muted-foreground hover:text-foreground" disabled={!!busy} onClick={() => void run("link-near", async () => { await signInWallet("near", true); refresh(); })}>Link NEAR account</button><button type="button" className="text-sm text-primary" disabled={!!busy || requests.refreshing || detail.refreshing} onClick={refresh}>Refresh</button></div>
      </div>
      {!selected && <>
        {requests.error && <p role="alert" className="text-sm text-destructive">{requests.error}</p>}
        {requests.loading ? <Empty>Loading financing...</Empty> : requests.data?.requests.length ? <div className="overflow-hidden rounded-2xl border bg-white divide-y">{requests.data.requests.map(item => <button key={item.id} type="button" disabled={!!busy} className="flex w-full items-center gap-4 p-5 text-left hover:bg-muted/50" onClick={() => choose(item.id)}><span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{item.companyName}</span><span className="mt-1 block text-xs text-muted-foreground">{item.scope.label} · {item.terms.tenorDays} days · {new Date(item.createdAt).toLocaleDateString()}</span></span><span className="text-right"><span className="mb-1 block font-medium tabular-nums">{usd(item.terms.principal)}</span><Status value={item.chain?.stage ?? item.state}/></span><ChevronRight size={16} className="shrink-0 text-muted-foreground"/></button>)}</div> : !requests.error && <Empty>No {tab === "market" && !company ? "invited opportunities" : "financing requests"} yet.</Empty>}
        {requests.data && "availability" in requests.data && requests.data.availability && <details className="text-xs text-muted-foreground"><summary className="cursor-pointer">Financing availability</summary><p className="mt-2">{requests.data.availability}</p></details>}
        {(page > 1 || requests.data?.hasMore) && <div className="flex items-center justify-between text-sm"><button disabled={page === 1 || requests.refreshing || !!busy} onClick={() => setPage(value => value - 1)}>Previous</button><span className="text-xs text-muted-foreground">Page {page}</span><button disabled={!requests.data?.hasMore || requests.refreshing || !!busy} onClick={() => setPage(value => value + 1)}>Next</button></div>}
      </>}
      {selected && detail.error && <p role="alert" className="text-sm text-destructive">{detail.error}</p>}
      {selected && detail.loading ? <Empty>Loading agreement...</Empty> : selected && current && <article className="grid min-w-0 gap-6">
        <div className="flex flex-wrap items-center justify-between gap-4"><div><p className="text-xs text-muted-foreground">Principal</p><p className="mt-1 text-3xl font-medium tracking-tight tabular-nums">{usd(current.terms.principal)}</p><div className="mt-3"><AssetIdentity symbol="USDC" network="near"/></div></div><div className="text-right"><Status value={current.chain?.stage ?? current.state}/><p className="mt-2 text-xs text-muted-foreground">{current.scope.label} · NEAR {current.scope.network}</p></div></div>
        {current.chain?.pending && <div className="rounded-xl bg-amber-50 p-4 text-sm text-amber-900"><strong>{current.chain.pending.kind.replaceAll("_", " ")} pending · {usd(current.chain.pending.amount)}</strong><p className="mt-1 text-xs">Reconcile this transfer before another payment. Timeouts do not release it.</p></div>}
        {current.unresolvedDeposit && <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-amber-50 p-4 text-sm text-amber-900"><span>Unresolved {current.unresolvedDeposit.kind} · {usd(current.unresolvedDeposit.amount)}</span><Action className={secondary} disabled={blocked || !current.chain || !(isBorrower || isLender)} onClick={() => { setDepositKind(current.unresolvedDeposit!.kind); openTask("deposit"); }}>Review deposit</Action></div>}
        {current.agreement ? <>
          <div className="grid gap-4 rounded-2xl bg-muted/60 p-4 sm:grid-cols-2"><div className="min-w-0"><p className="mb-2 text-xs text-muted-foreground">Borrower{isBorrower ? " · You" : ""}</p><Address value={current.agreement.borrower} network={current.scope.network}/></div><div className="min-w-0"><p className="mb-2 text-xs text-muted-foreground">Lender{isLender ? " · You" : ""}</p><Address value={current.agreement.lender} network={current.scope.network}/></div></div>
          {current.chain ? <dl className="grid grid-cols-2 gap-5 sm:grid-cols-3">{[
            ["Principal funded", current.chain.principal_funded], ["Bond funded", current.chain.collateral_funded], ["Advanced", current.chain.advanced], ["Cash repaid", current.chain.cash_repaid], ["Bond applied", current.chain.collateral_applied], ["Lender credit", current.chain.lender_credit], ["Borrower refund", current.chain.borrower_refund], ["Principal remaining", (BigInt(current.agreement.principal) - BigInt(current.chain.principal_paid)).toString()],
          ].filter(([label, value]) => BigInt(value) > 0n || label === "Principal remaining").map(([label, value]) => <div key={label}><dt className="text-xs text-muted-foreground">{label}</dt><dd className="mt-1 font-medium tabular-nums">{usd(value)}</dd></div>)}<div><dt className="text-xs text-muted-foreground">Maturity</dt><dd className="mt-1 text-sm">{current.chain.due_at_ms ? new Date(Number(current.chain.due_at_ms)).toLocaleString() : "After advance"}</dd></div>{current.chain.disputed && <div><dt className="text-xs text-muted-foreground">Dispute</dt><dd className="mt-1 text-sm text-amber-800">Awaiting both parties</dd></div>}</dl> : <p className="rounded-xl bg-muted p-4 text-sm">Agreement not yet verified on NEAR.</p>}
          <div className="flex flex-wrap items-center gap-3">
            {company && canManage && !current.chain && <Action disabled={blocked} onClick={() => review("register")}>Register agreement</Action>}
            {isBorrower && current.chain?.stage === "funding" && !current.chain.pending && !current.chain.disputed && current.chain.principal_funded === current.agreement.principal && current.chain.collateral_funded === current.agreement.collateral && <Action disabled={blocked} onClick={() => review("advance")}>Advance to treasury</Action>}
            {(isBorrower || isLender) && current.chain && !current.chain.pending && <Action disabled={blocked} onClick={() => { setDepositKind(current.unresolvedDeposit?.kind ?? (isLender && !isBorrower ? "principal" : current.chain?.stage === "funding" ? "collateral" : "repayment")); openTask("deposit"); }}>{isLender && !isBorrower ? "Fund principal" : "Fund or repay"}</Action>}
            <Action className={secondary} disabled={!!busy} onClick={() => void run("reconcile-financing", async () => { await api(`${endpoint}/${current.id}/reconcile`, {}); refresh(); })}>Reconcile</Action>
            {company && current.chain && BigInt(current.chain.advanced) > 0n && <Action className={secondary} disabled={blocked} onClick={() => openTask("evidence")}>Verify treasury receipt</Action>}
            {(isBorrower || isLender) && <select aria-label="Manage agreement" className={`${control} sm:max-w-64`} value="" disabled={blocked} onChange={event => { const value = event.target.value; if (value === "recover_advance") { setRecoveryCreditId(""); openTask("recovery"); } else review(value); }}><option value="" disabled>Manage agreement</option>{["withdraw", "cancel", "default", "dispute", "resume", "recover_advance"].map(action => <option key={action} value={action} disabled={unavailable(action)}>{actionNames[action]}</option>)}{current.unresolvedDeposit && <option value="void_deposit">Void unresolved deposit</option>}</select>}
          </div>
          <details className="border-t pt-4 text-sm"><summary className="cursor-pointer font-medium">Agreement terms</summary><div className="mt-4 grid gap-4"><Terms request={current}/><p className="text-xs text-muted-foreground">Repayment source: {current.terms.repaymentSource}</p><LoanRisk assigned={!!current.assignment}/></div></details>
        </> : <>
          <Terms request={current}/>
          <div><p className="text-xs text-muted-foreground">Purpose</p><p className="mt-1 break-words text-sm">{current.terms.purpose}</p></div>
          <section className="grid gap-3"><div className="flex items-center justify-between gap-3"><h3 className="text-base font-medium">Offers</h3>{!company && current.state === "open" && <Action disabled={blocked} onClick={() => openTask("offer")}><Plus size={16}/> Make offer</Action>}</div>{current.offers.length ? current.offers.map(offer => <div key={offer.id} className="flex flex-wrap items-center gap-4 rounded-2xl border p-4"><div className="min-w-0 flex-1"><Address value={offer.lenderAccount} network={current.scope.network}/><p className="mt-2 text-xs text-muted-foreground">Expires {new Date(offer.expiresAt).toLocaleString()}</p></div><div className="text-right"><p className="text-sm font-medium tabular-nums">{usd((BigInt(offer.interest) + BigInt(offer.fee)).toString())} cost</p><p className="mt-1 text-xs text-muted-foreground">{usd((BigInt(current.terms.principal) + BigInt(offer.interest) + BigInt(offer.fee)).toString())} repayment</p></div><Status value={offer.state}/><Action className={secondary} disabled={blocked} onClick={() => { setOfferId(offer.id); openTask("accept"); }}>View offer</Action></div>) : <Empty>No offers yet.</Empty>}</section>
          {company && canManage && current.state === "open" && <div className="border-t pt-4"><Action className={secondary} disabled={blocked} onClick={() => void run("withdraw-request", async () => { await api(`${endpoint}/${current.id}`, undefined, "DELETE"); setNotice("Request withdrawn."); refresh(); })}>Withdraw request</Action></div>}
        </>}
        <details className="border-t pt-4 text-xs text-muted-foreground"><summary className="cursor-pointer">Scope and history</summary><div className="mt-4 grid gap-4"><p>{current.scope.label} · {current.scope.eligibility}</p><p>Purpose: {current.terms.purpose}</p><p>Repayment source: {current.terms.repaymentSource}</p>{current.agreementHash && <Address value={current.agreementHash} label="agreement hash"/>}{current.history.map(event => <p key={event.id}>{event.kind.replaceAll("_", " ")} · {new Date(event.created_at).toLocaleString()}</p>)}<p>Last verified {current.reconciledAt ? new Date(current.reconciledAt).toLocaleString() : "not yet"}</p></div></details>
      </article>}
      {notice && <p role="status" className="text-sm">{notice}</p>}
      {error && !task && <p role="alert" className="text-sm text-destructive">{error}</p>}
    </div>
    {company && canManage && <TaskDrawer id="financing-request-flow" title="Request working capital"><div aria-busy={!!busy}>{!scopes.length ? <Empty>No financing scope is available for this company.</Empty> : <>
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
                    setSelected(result.request.id); closeTaskDrawer("financing-request-flow", true);
                    form.reset();
                    setNotice(
                      "Request published to invited lenders.",
                    );
                    refresh();
                  });
                }}
              >
                <fieldset className="contents" disabled={!!busy || requests.refreshing || !!requests.error}>
                  <Field label="Operating scope">
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
                  <Field label="Maximum interest + fees (USDC)">
                    <input
                      name="cost"
                      className={control}
                      required
                      inputMode="decimal"
                      defaultValue="0"
                    />
                  </Field>
                  <Field
                    label="Collateral bond (USDC)"
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
                  <Field label="Term from advance (days)">
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
                  <Field label="Grace period (days)">
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
                  <Field label="Fund by (local time)">
                    <input
                      name="fundBy"
                      className={control}
                      type="datetime-local"
                      required
                    />
                  </Field>
                  <Field
                    label="Receivable bill ID (optional)"
                    hint="Must be owed to your supplier identity. Assignment covers Razor only; lien priority and collection are unverified."
                  >
                    <input name="bill" className={control} maxLength={36} />
                  </Field>
                  <Field label="Purpose">
                    <textarea
                      name="purpose"
                      className={control}
                      minLength={10}
                      maxLength={500}
                      required
                    />
                  </Field>
                  <Field label="Repayment source">
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
                      disabled={!!busy || requests.refreshing || !!requests.error}
                    >
                      Publish request
                    </Action>
                  </div>
                </fieldset>
              </form>
    </>}{requests.error && <p role="alert" className="mt-4 text-sm text-destructive">{requests.error}</p>}{error && <p role="alert" className="mt-4 text-sm text-destructive">{error}</p>}</div></TaskDrawer>}
    <TaskDrawer id="financing-action-flow" title={task === "wallet" && preview ? actionNames[preview.action] ?? "Review transaction" : task ? titles[task] : "Financing"}>
      <div aria-busy={!!busy} className="grid min-w-0 gap-5" key={`${current?.id}:${task}:${selectedOffer?.offerHash ?? ""}`}>
        {task && current && <>
          {task !== "wallet" && <div className="flex flex-wrap items-center justify-between gap-3"><p className="font-medium">{current.companyName}</p><AssetIdentity symbol="USDC" network="near"/></div>}
          {task === "offer" && <><Terms request={current}/><p className="text-xs text-muted-foreground">No funding or repayment guarantee. Fixed interest and fees are not annual rates.</p>
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
                        "Offer submitted. Escrow is not yet funded.",
                      );
                      finishTask(); refresh();
                    });
                  }}
                >
                  <fieldset className="contents" disabled={blocked}>
                    <Field label="Lender account">
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
                    <Field label="Expires (local time)">
                      <input
                        name="expires"
                        className={control}
                        required
                        type="datetime-local"
                      />
                    </Field>
                    <div className="sm:col-span-2">
                      <Action disabled={blocked || !accounts.length}>
                        Submit offer
                      </Action>
                    </div>
                  </fieldset>
                </form>
          </>}
          {task === "accept" && selectedOffer && <><div><p className="mb-2 text-xs text-muted-foreground">Lender</p><Address value={selectedOffer.lenderAccount} network={current.scope.network} full/></div><Terms request={current} offer={selectedOffer}/><div><p className="text-xs text-muted-foreground">Repayment source</p><p className="mt-1 break-words text-sm">{current.terms.repaymentSource}</p></div><LoanRisk assigned={!!current.assignment}/>
            {company && canManage && current.state === "open" && selectedOffer.state === "proposed" && <><label className="flex items-start gap-3 text-sm"><input type="checkbox" className="mt-1" checked={offerRisk === consentKey} onChange={event => setOfferRisk(event.target.checked ? consentKey : "")}/>I accept these fixed terms and risks. Acceptance locks this offer.</label><Action disabled={blocked || offerRisk !== consentKey} busy={busy === `accept-${selectedOffer.id}`} onClick={() => void run(`accept-${selectedOffer.id}`, async () => { await api(`${endpoint}/${current.id}/accept`, { offerId: selectedOffer.id, offerHash: selectedOffer.offerHash, acknowledgeRisk: true }); finishTask(); setNotice("Offer accepted. Register the agreement before funding escrow."); refresh(); })}>Accept offer</Action></>}
            {!company && current.state === "open" && selectedOffer.state === "proposed" && <Action className={secondary} disabled={blocked} onClick={() => void run(`withdraw-${selectedOffer.id}`, async () => { await api(`${endpoint}/${current.id}/offers/${selectedOffer.id}/withdraw`, {}); finishTask(); refresh(); })}>Withdraw offer</Action>}
          </>}
          {task === "deposit" && current.agreement && <><p className="text-xs text-muted-foreground">Paid from the fixed {depositKind === "principal" ? "lender" : "borrower"} wallet into loan escrow.</p>{current.unresolvedDeposit && <p className="rounded-xl bg-amber-50 p-3 text-xs text-amber-900">This retries the original unresolved deposit. Its amount and purpose cannot change.</p>}
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
                        await prepare(depositKind, { amount: exact, depositId });
                      });
                    }}
                  >
                    <fieldset className="contents" disabled={blocked}>
                      <Field label="Purpose">
                        <select
                          className={control}
                          value={depositKind}
                          disabled={!!current.unresolvedDeposit}
                          onChange={(event) =>
                            setDepositKind(event.target.value)
                          }
                        >
                          {isLender && <option value="principal">Lender principal</option>}
                          {isBorrower && <option value="collateral">Collateral bond</option>}
                          {isBorrower && <option value="repayment">Repayment</option>}
                        </select>
                      </Field>
                      <Field label="Amount (USDC)">
                        <input
                          name="amount"
                          className={control}
                          required
                          defaultValue={current.unresolvedDeposit ? formatUnits(current.unresolvedDeposit.amount, 6) : undefined}
                          readOnly={!!current.unresolvedDeposit}
                          inputMode="decimal"
                        />
                      </Field>
                      <div className="sm:col-span-2">
                        <Action disabled={blocked || !current.chain}>
                          Review deposit
                        </Action>
                      </div>
                    </fieldset>
                  </form>
          </>}
          {task === "recovery" && <form className="grid gap-4" onSubmit={event => { event.preventDefault(); review("recover_advance", recoveryCreditId ? { creditId: recoveryCreditId } : {}); }}><p className="text-sm">Advance under review · {usd(current.chain?.pending?.amount ?? "0")}</p><Field label="Treasury credit ID (optional)" hint="Use the original receipt's credit ID if its reference was reused."><input className={control} value={recoveryCreditId} disabled={blocked} onChange={event => setRecoveryCreditId(event.target.value.trim())} inputMode="numeric" pattern="[1-9][0-9]*" maxLength={20}/></Field><Action disabled={blocked || unavailable("recover_advance")}>Review recovery</Action></form>}
          {task === "evidence" && <>
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
                          "Financing receipt verified and treasury synchronized.",
                        );
                        finishTask(); refresh();
                      });
                    }}
                  >
                    <fieldset className="contents" disabled={blocked}>
                      <Field label="Advance transaction hash">
                        <input
                          name="transaction"
                          className={control}
                          required
                          minLength={32}
                          maxLength={64}
                        />
                      </Field>
                      <Field label="Transaction signer">
                        <input
                          name="signer"
                          className={control}
                          defaultValue={current.agreement?.borrower}
                          required
                          minLength={2}
                          maxLength={64}
                        />
                      </Field>
                      <p className="text-xs text-muted-foreground sm:col-span-2">Requires the final tagged USDC transfer into your company treasury.</p>
                      <div className="sm:col-span-2">
                        <Action
                          busy={busy === "verify-loan-credit"}
                          disabled={blocked}
                        >
                          Verify receipt
                        </Action>
                      </div>
                    </fieldset>
                  </form>
          </>}
        </>}
        {task === "wallet" && preview && <WalletReview value={preview}/>}
        {task === "wallet" && preview && <><label className="flex items-start gap-3 text-sm"><input className="mt-1" type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)}/>I confirm these amounts, destinations and terms.</label><Action disabled={blocked || !confirmed} busy={busy === "sign-financing"} onClick={() => void sign()}>Confirm in NEAR wallet</Action></>}
        {detail.error && <p role="alert" className="text-sm text-destructive">{detail.error}</p>}
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      </div>
    </TaskDrawer>
  </Panel>;
}

function WalletReview({ value }: { value: Review }) {
  const { plan, request, action, input } = value;
  const attached = plan.walletActions.flatMap(transaction => transaction.actions).reduce((total, item) => total + BigInt(item.params.deposit), 0n);
  const gas = plan.walletActions.flatMap(transaction => transaction.actions).reduce((total, item) => total + BigInt(item.params.gas), 0n);
  const isBorrower = plan.eligibleSigners.includes(request.agreement?.borrower ?? "");
  const amount = typeof input.amount === "string" ? input.amount : action === "advance" ? request.terms.principal : action === "withdraw" ? (isBorrower ? request.chain?.borrower_refund : request.chain?.lender_credit) : action === "recover_advance" ? request.chain?.pending?.amount : action === "void_deposit" ? request.unresolvedDeposit?.amount : undefined;
  const destination = ["principal", "collateral", "repayment"].includes(action) ? request.scope.contractId : action === "advance" ? request.scope.treasuryId : action === "withdraw" ? plan.eligibleSigners[0] : null;
  return <>
    <div className="flex flex-wrap items-center justify-between gap-3"><p className="font-medium">{request.companyName}</p><AssetIdentity symbol="USDC" network="near"/></div>
    {amount && <div><p className="text-xs text-muted-foreground">{action === "void_deposit" ? "Unresolved deposit" : action === "recover_advance" ? "Advance under review" : "Amount"}</p><p className="mt-1 text-3xl font-medium tabular-nums">{usd(amount)}</p></div>}
    {destination && <div><p className="mb-2 text-xs text-muted-foreground">{action === "advance" ? "Company treasury" : action === "withdraw" ? "Receiving account" : "Loan escrow"}</p><Address value={destination} network={plan.network} full/></div>}
    <div><p className="mb-2 text-xs text-muted-foreground">Signing account · NEAR {plan.network}</p>{plan.eligibleSigners.map(account => <Address key={account} value={account} network={plan.network} full/>)}</div>
    {action === "register" && <Terms request={request}/>}
    {action === "default" && <div className="rounded-xl bg-amber-50 p-4 text-sm text-amber-900">Only the fixed {usd(request.terms.collateral)} bond can cover this debt after maturity and the {request.terms.graceDays}-day grace period. Unsecured shortfall remains due.</div>}
    {action === "cancel" && <p className="text-sm">Cancel this funding-stage agreement. Funded principal and unused bond become credits for their original owners.</p>}
    {action === "dispute" && <p className="text-sm">Hold this agreement until both original parties consent to resume.</p>}
    {action === "resume" && <p className="text-sm">Consent to resume the original terms without repricing. Both parties must consent.</p>}
    {action === "void_deposit" && <p className="text-sm text-amber-900">Permanently void this unresolved deposit identity before using a new one. This does not confirm a refund.</p>}
    {action === "repayment" && <p className="text-xs text-muted-foreground">Repayment uses only the borrower's wallet: principal first, then interest and fees.</p>}
    {action === "recover_advance" && <p className="text-xs text-muted-foreground">Match the original advance to treasury evidence. This does not authorize another advance.</p>}
    <div className="grid grid-cols-2 gap-4 rounded-2xl bg-muted/60 p-4 text-sm"><div><p className="text-xs text-muted-foreground">Attached NEAR</p><p className="mt-1 tabular-nums">{formatUnits(attached.toString(), 24)}</p></div><div><p className="text-xs text-muted-foreground">Gas limit</p><p className="mt-1 tabular-nums">{formatUnits(gas.toString(), 12)} Tgas</p></div></div>
    <p className="text-xs text-muted-foreground">Network fees are separate. Transfers and terms are public on NEAR. Unknown outcomes stay held.</p>
    {action === "register" && <LoanRisk assigned={!!request.assignment}/>}
    <details className="border-t pt-4 text-xs"><summary className="cursor-pointer text-muted-foreground">Transaction details</summary><div className="mt-4 grid min-w-0 gap-4"><Address value={plan.reviewHash} label="review hash"/>{plan.walletActions.map((transaction, index) => <div key={index} className="min-w-0"><Address value={transaction.receiverId} network={plan.network} label="contract"/><pre className="mt-2 max-w-full overflow-x-auto whitespace-pre-wrap break-all rounded-xl bg-muted p-3">{JSON.stringify(transaction.actions, null, 2)}</pre></div>)}{plan.warnings.map(warning => <p key={warning} className="text-muted-foreground">{warning}</p>)}</div></details>
  </>;
}
