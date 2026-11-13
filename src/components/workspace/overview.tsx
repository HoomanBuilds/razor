"use client";

import { CheckCircle2, Circle, Wallet, Users, ReceiptText, CalendarDays } from "lucide-react";
import { usd, dateLabel } from "@/lib/format";
import { hasPermissions } from "@/lib/workspace-access";
import { useWorkspace } from "./context";
import { paymentLabel } from "@/lib/payment-label";
import { useResource } from "./hooks";
import { DataTable, Empty, Panel, Status } from "./shared";
import type { Payment, Section, Treasury } from "./types";

interface Summary {
  openPrincipal: string; uncommittedInvoicePrincipal: string; fundingGap: string;
  openCount: number; paidCount: number; treasury: Treasury;
  attention: Array<{ payment: Payment; recipientName: string; outstandingPrincipal: string; state: string; rootPaymentId: string; billId?: string }>;
}

export function Overview() {
  const { base, revision, recipients, navigate, organization } = useWorkspace();
  const permissions = organization.permissions ?? [];
  const canReadPayments = hasPermissions(permissions, ["payments:read"]);
  const canPrepare = hasPermissions(permissions, ["payments:prepare", "recipients:read"]);
  const canManage = hasPermissions(permissions, ["company:manage"]);
  const canManageRecipients = hasPermissions(permissions, ["recipients:manage"]);
  const summary = useResource<Summary>(canReadPayments ? `${base}/payments/summary` : null, revision);
  const balance = useResource<Treasury>(!canReadPayments ? `${base}/treasury` : null, revision);
  const { data: account } = useResource<{ ownerWalletReady: boolean }>(canManage || canPrepare ? "/account/status" : null, revision);
  const treasury = summary.data?.treasury ?? balance.data;
  const steps: { title: string; done: boolean; section: Section; detail: string; href?: string; show: boolean }[] = [
    { title: "Company created", done: true, section: "settings", detail: organization.name, show: true },
    { title: "Link a NEAR signing wallet", done: !!account?.ownerWalletReady, section: "treasury", detail: "Verify your wallet, then check its company authority", href: "/account", show: canManage || canPrepare },
    { title: "Connect NEAR treasury", done: !!treasury?.config, section: "treasury", detail: "Verify your company contract and owner", show: canManage },
    { title: "Add your payees", done: recipients.length > 0, section: "recipients", detail: "Invite employees, contractors or suppliers", show: canManageRecipients },
    { title: "Fund the company", done: BigInt(treasury?.balance ?? "0") > 0n, section: "treasury", detail: "Use any live supported source asset", show: canPrepare },
    { title: "Complete a payment", done: (summary.data?.paidCount ?? 0) > 0, section: "payments", detail: "Approve, execute and reconcile delivery", show: canPrepare },
  ];
  const visibleSteps = steps.filter(step => step.show);
  const actions = [
    { title: "Create payment", detail: "Pay a confirmed recipient", section: "payments" as const, icon: Wallet, show: canPrepare },
    { title: "Prepare payroll", detail: "Build a pay run or import CSV", section: "payroll" as const, icon: CalendarDays, show: canPrepare },
    { title: "Add invoice", detail: "Prepare a supplier payment", section: "bills" as const, icon: ReceiptText, show: canPrepare },
    { title: "Invite payee", detail: "Confirm primary and backup details", section: "recipients" as const, icon: Users, show: canManageRecipients },
  ].filter(action => action.show);
  const cards = [
    ["Available funds", treasury ? usd(treasury.available) : "Loading...", "Confirmed USDC less reservations"],
    ["Reserved funds", treasury ? usd(treasury.totalReserved ?? treasury.reserved) : "Loading...", "Payments and client earmarks"],
    ...(canReadPayments ? [
      ["Outstanding liabilities", summary.data ? usd(summary.data.openPrincipal) : "Loading...", summary.data ? `${summary.data.openCount} open obligations, including full invoice balances` : "Loading all company obligations"],
      ["Current payment funding gap", summary.data ? usd(summary.data.fundingGap) : "Loading...", "Current budgets after their protected funds and available cash"],
    ] : []),
  ];
  return <div className="grid gap-6">
    {(summary.error || balance.error) && <p role="alert" className="rounded-lg border p-4 text-sm text-destructive">{summary.error || balance.error} Use Refresh workspace to try again.</p>}
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">{cards.map(([label, value, detail]) => <div key={label} className="rounded-xl border bg-card p-5"><p className="text-xs font-medium text-muted-foreground">{label}</p><p className="mt-3 text-3xl font-semibold tracking-tight tabular-nums">{value}</p><p className="mt-2 text-xs text-muted-foreground">{detail}</p></div>)}</div>
    {summary.data && BigInt(summary.data.uncommittedInvoicePrincipal) > 0n && <p className="text-sm text-muted-foreground">{usd(summary.data.uncommittedInvoicePrincipal)} of invoice debt still needs future installments. It is included in outstanding liabilities and is separate from the current payment funding gap.</p>}
    {(canManage || canPrepare || canManageRecipients) && !visibleSteps.every(step => step.done) && <Panel title="Get your company ready" description="Prepare bills and payroll while treasury setup is in progress."><div className="grid gap-3 md:grid-cols-3 xl:grid-cols-6">{visibleSteps.map(step => <button key={step.title} className="rounded-lg border p-4 text-left hover:bg-muted/50" onClick={() => step.href ? window.location.assign(step.href) : navigate(step.section)}>{step.done ? <CheckCircle2 size={20} className="text-primary" /> : <Circle size={20} className="text-muted-foreground" />}<h3 className="mt-3 text-sm font-medium">{step.title}</h3><p className="mt-1 text-xs leading-relaxed text-muted-foreground">{step.detail}</p></button>)}</div></Panel>}
    {actions.length > 0 && <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">{actions.map(action => <button key={action.title} className="flex items-center gap-4 rounded-xl border bg-card p-5 text-left hover:border-primary/40" onClick={() => navigate(action.section)}><action.icon size={22} className="text-primary" /><div><h3 className="text-sm font-semibold">{action.title}</h3><p className="mt-1 text-xs text-muted-foreground">{action.detail}</p></div></button>)}</div>}
    {canReadPayments && <Panel title="Needs attention" description="Open liabilities and held payments across the entire company." action={<button className="text-sm text-primary" onClick={() => navigate("payments")}>All payments</button>}>
      {summary.loading ? <Empty>Loading company obligations...</Empty> : !summary.data ? <Empty>Company obligations could not be loaded.</Empty> : !summary.data.attention.length ? <Empty>No outstanding payments.</Empty> : <DataTable columns={["Reference", "Payee", "Outstanding", "Scheduled", "Status"]}>{summary.data.attention.map(item => <tr key={item.billId ?? item.rootPaymentId}><td><button className="text-left font-medium text-primary" onClick={() => item.state === "needs_installment" ? navigate("bills") : navigate("payments", ["needs_remainder", "needs_replacement"].includes(item.state) ? item.rootPaymentId : item.payment.id)}>{paymentLabel(item.payment)}</button></td><td>{item.recipientName}</td><td className="tabular-nums">{usd(item.outstandingPrincipal)}</td><td>{dateLabel(item.payment.scheduled_for)}</td><td><Status value={item.state} />{item.payment.hold_reason && <p className="mt-1 max-w-60 text-xs text-amber-900">{item.payment.hold_reason}</p>}</td></tr>)}</DataTable>}
    </Panel>}
    {!canReadPayments && <Panel title="Your company workspace" description="Your role can view company information. Ask an administrator if you also need access to payment records."><button className="text-sm text-primary" onClick={() => navigate("settings")}>Open company settings</button></Panel>}
    <p className="text-xs text-muted-foreground">Company authority runs on NEAR. Cross-chain routes use NEAR Intents. {treasury?.config?.network === "testnet" ? "Your treasury is on NEAR testnet; Intents settlement requires mainnet." : treasury?.lastSyncedAt ? `Last treasury sync: ${new Date(treasury.lastSyncedAt).toLocaleString()}.` : "Sync the treasury to check confirmed funds."}</p>
  </div>;
}
