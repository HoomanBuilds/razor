"use client";

import { CheckCircle2, Circle, Wallet, Users, ReceiptText, CalendarDays } from "lucide-react";
import { usd, dateLabel } from "@/lib/format";
import { useWorkspace } from "./context";
import { paymentLabel } from "@/lib/payment-label";
import { paymentBudget } from "@/lib/payment-budget";
import { useResource } from "./hooks";
import { DataTable, Empty, Panel, Status } from "./shared";
import type { Payment, Section, Treasury } from "./types";

export function Overview() {
  const { base, revision, recipients, navigate, organization } = useWorkspace();
  const { data: treasury } = useResource<Treasury>(`${base}/treasury`, revision);
  const {data:account}=useResource<{ownerWalletReady:boolean}>("/account/status",revision);
  const { data, error } = useResource<{ payments: Payment[] }>(`${base}/payments`, revision);
  const payments = data?.payments ?? [];
  const remainderParents = new Set(payments.flatMap(payment=>{try{const parent=JSON.parse(payment.metadata || "{}").partialOf;return typeof parent==="string"?[parent]:[];}catch{return [];}}));
  const unresolved = payments.filter((payment) => !["paid", "cancelled"].includes(payment.status) && (payment.status!=="partially_paid" || !remainderParents.has(payment.id)));
  const unreserved = unresolved.reduce((sum, payment) => sum + (payment.status==="partially_paid"?BigInt(payment.amount)-BigInt(payment.delivered_amount):paymentBudget(payment).unreserved), 0n);
  const shortage = unreserved - BigInt(treasury?.available ?? "0");
  const reserveDeficit = BigInt(treasury?.reserveDeficit ?? "0");
  const gap = shortage > reserveDeficit ? shortage : reserveDeficit;
  const steps: { title: string; done: boolean; section: Section; detail: string;href?:string }[] = [
    { title: "Company created", done: true, section: "settings", detail: organization.name },
    { title: "Link NEAR owner wallet",done:!!account?.ownerWalletReady,section:"treasury",detail:"Create or restore a wallet and verify ownership",href:"/account" },
    { title: "Connect NEAR treasury", done: !!treasury?.config, section: "treasury", detail: "Verify your company contract and owner" },
    { title: "Add your payees", done: recipients.length > 0, section: "recipients", detail: "Invite employees, contractors or suppliers" },
    { title: "Fund the company", done: BigInt(treasury?.balance ?? "0") > 0n, section: "treasury", detail: "Use any live supported source asset" },
    { title: "Complete a payment", done: payments.some((payment) => payment.status === "paid"), section: "payments", detail: "Approve, execute and reconcile delivery" },
  ];
  return <div className="grid gap-6"><div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">{[
    ["Available funds", usd(treasury?.available), "Confirmed USDC less reservations"],
    ["Reserved funds", usd(treasury?.totalReserved ?? treasury?.reserved), "Payments and client earmarks"],
    ["Open obligations", usd(unresolved.reduce((sum, payment) => sum + BigInt(payment.amount) - BigInt(payment.delivered_amount), 0n)), `${unresolved.length} unresolved payments`],
    ["Funding gap", usd(gap > 0n ? gap : 0n), "Unreserved budgets less spendable cash"],
  ].map(([label, value, detail]) => <div key={label} className="rounded-xl border bg-card p-5"><p className="text-xs font-medium text-muted-foreground">{label}</p><p className="mt-3 text-3xl font-semibold tracking-tight tabular-nums">{value}</p><p className="mt-2 text-xs text-muted-foreground">{detail}</p></div>)}</div>
    {!steps.every((step) => step.done) && <Panel title="Get your company ready" description="You can prepare bills and payroll while treasury setup is in progress."><div className="grid gap-3 md:grid-cols-3 xl:grid-cols-6">{steps.map((step) => <button key={step.title} className="rounded-lg border p-4 text-left hover:bg-muted/50" onClick={() => step.href?window.location.assign(step.href):navigate(step.section)}>{step.done ? <CheckCircle2 size={20} className="text-primary" /> : <Circle size={20} className="text-muted-foreground" />}<h3 className="mt-3 text-sm font-medium">{step.title}</h3><p className="mt-1 text-xs leading-relaxed text-muted-foreground">{step.detail}</p></button>)}</div></Panel>}
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">{[{ title: "Create payment", detail: "Pay a confirmed recipient", section: "payments" as const, icon: Wallet }, { title: "Prepare payroll", detail: "Build a pay run or import CSV", section: "payroll" as const, icon: CalendarDays }, { title: "Add invoice", detail: "Prepare a supplier payment", section: "bills" as const, icon: ReceiptText }, { title: "Invite payee", detail: "Confirm primary and backup details", section: "recipients" as const, icon: Users }].map((action) => <button key={action.title} className="flex items-center gap-4 rounded-xl border bg-card p-5 text-left hover:border-primary/40" onClick={() => navigate(action.section)}><action.icon size={22} className="text-primary" /><div><h3 className="text-sm font-semibold">{action.title}</h3><p className="mt-1 text-xs text-muted-foreground">{action.detail}</p></div></button>)}</div>
    <Panel title="Needs attention" description="Open obligations and held payments, ordered by creation." action={<button className="text-sm text-primary" onClick={() => navigate("payments")}>All payments</button>}>{error && <p role="alert">{error}</p>}{!unresolved.length ? <Empty>No outstanding payments. Create a bill or pay run to begin.</Empty> : <DataTable columns={["Reference", "Payee", "Amount", "Scheduled", "Status"]}>{unresolved.slice(0, 8).map((payment) => <tr key={payment.id}><td className="font-medium">{paymentLabel(payment)}</td><td>{recipients.find((recipient) => recipient.id === payment.recipient_id)?.name ?? "Payee"}</td><td className="tabular-nums">{usd(BigInt(payment.amount)-BigInt(payment.delivered_amount))}</td><td>{dateLabel(payment.scheduled_for)}</td><td><Status value={payment.status} />{payment.hold_reason && <p className="mt-1 max-w-60 text-xs text-amber-900">{payment.hold_reason}</p>}</td></tr>)}</DataTable>}</Panel>
    <p className="text-xs text-muted-foreground">Company authority runs on NEAR. Cross-chain routes use NEAR Intents. {treasury?.config?.network === "testnet" ? "Your treasury is on NEAR testnet; Intents settlement requires mainnet." : treasury?.lastSyncedAt ? `Last treasury sync: ${new Date(treasury.lastSyncedAt).toLocaleString()}.` : "Sync the treasury to check confirmed funds."}</p>
  </div>;
}
