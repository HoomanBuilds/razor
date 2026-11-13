import { rows } from "../db";
import { reservePositions } from "../client-reserves/accounting";
import { fundingPositions } from "../payment-funding/accounting";
import { paymentBudget } from "../../lib/payment-budget";
import type { Payment } from "./types";
import { decrypt } from "../identity/crypto";

export interface PaymentAttention {
  payment: Payment;
  recipientName: string;
  outstandingPrincipal: string;
  state: string;
  rootPaymentId: string;
}

export function buildPaymentSummary<T extends { available: string; reserveDeficit: string }>(organizationId: string, treasury: T) {
  const payments = rows<Payment>("SELECT * FROM payments WHERE organization_id=? ORDER BY created_at,id", organizationId);
  const edges = rows<{ parent: string; child: string }>("SELECT original_payment_id AS parent,remainder_payment_id AS child FROM partial_remainders WHERE organization_id=? UNION SELECT old_payment_id AS parent,new_payment_id AS child FROM payment_replacements WHERE organization_id=?", organizationId, organizationId);
  const byId = new Map(payments.map(payment => [payment.id, payment]));
  const payrollPrincipal = new Map(rows<{ payment_id: string; amount: string }>("SELECT i.payment_id,i.amount FROM payroll_items i JOIN payroll_runs r ON r.id=i.run_id WHERE r.organization_id=? AND i.payment_id IS NOT NULL", organizationId).map(item => [item.payment_id, item.amount]));
  const adjacent = new Map<string, string[]>(), children = new Set<string>(), parents = new Set<string>();
  for (const edge of edges) {
    if (!byId.has(edge.parent) || !byId.has(edge.child)) continue;
    adjacent.set(edge.parent, [...adjacent.get(edge.parent) ?? [], edge.child]);
    adjacent.set(edge.child, [...adjacent.get(edge.child) ?? [], edge.parent]);
    children.add(edge.child);
    parents.add(edge.parent);
  }
  const clientCash = new Map<string, bigint>(), linkedCash = new Map<string, bigint>();
  for (const position of reservePositions(organizationId)) {
    if (!position.payment || ["released", "terms_changed", "ambiguous_lineage"].includes(position.state)) continue;
    clientCash.set(position.payment.id, (clientCash.get(position.payment.id) ?? 0n) + position.clientReserved);
  }
  for (const position of fundingPositions(organizationId)) linkedCash.set(position.payment.id, position.held);
  const names = new Map(rows<{ id: string; name: string; version: number }>("SELECT id,name,version FROM recipients WHERE organization_id=?", organizationId).map(recipient => [`${recipient.id}:${recipient.version}`, decrypt(recipient.name)]));
  for (const version of rows<{ recipient_id: string; version: number; profile_ciphertext: string }>("SELECT v.recipient_id,v.version,v.profile_ciphertext FROM recipient_versions v JOIN recipients r ON r.id=v.recipient_id WHERE r.organization_id=?", organizationId)) {
    const profile = JSON.parse(decrypt(version.profile_ciphertext)) as { name: string };
    names.set(`${version.recipient_id}:${version.version}`, decrypt(profile.name));
  }
  const visited = new Set<string>(), attention: PaymentAttention[] = [];
  let openPrincipal = 0n, unreservedBudget = 0n, protectedCash = 0n, openCount = 0, paidCount = 0;
  for (const first of payments) {
    if (visited.has(first.id)) continue;
    const lineage: Payment[] = [], pending = [first.id];
    while (pending.length) {
      const next = pending.pop()!;
      if (visited.has(next)) continue;
      visited.add(next);
      lineage.push(byId.get(next)!);
      pending.push(...adjacent.get(next) ?? []);
    }
    lineage.sort((left, right) => left.created_at.localeCompare(right.created_at) || left.id.localeCompare(right.id));
    const root = lineage.find(payment => !children.has(payment.id)) ?? lineage[0];
    const delivered = lineage.reduce((sum, payment) => sum + BigInt(payment.status === "paid" ? payment.amount : payment.delivered_amount), 0n);
    const principal = BigInt(lineage.map(payment => payrollPrincipal.get(payment.id)).find(amount => amount !== undefined) ?? root.amount);
    const remaining = principal > delivered ? principal - delivered : 0n;
    if (remaining === 0n) { paidCount++; continue; }
    const active = lineage.filter(payment => !["paid", "cancelled", "partially_paid"].includes(payment.status));
    const partial = lineage.some(payment => payment.status === "partially_paid");
    if (active.length === 0 && !partial) continue;
    const payment = active.at(-1) ?? lineage.filter(item => !parents.has(item.id)).at(-1) ?? lineage.at(-1)!;
    const state = active.length > 1 ? "ambiguous_lineage" : active.length ? payment.status : payment.status === "cancelled" ? "needs_replacement" : "needs_remainder";
    const budget = active.length ? active.reduce((sum, item) => sum + paymentBudget(item).unreserved, 0n) : remaining;
    const held = lineage.reduce((sum, item) => sum + (clientCash.get(item.id) ?? 0n) + (linkedCash.get(item.id) ?? 0n), 0n);
    openPrincipal += remaining;
    unreservedBudget += budget;
    protectedCash += held < budget ? held : budget;
    openCount++;
    attention.push({ payment, recipientName: names.get(`${payment.recipient_id}:${payment.recipient_version}`) ?? `Recipient version ${payment.recipient_version}`, outstandingPrincipal: remaining.toString(), state, rootPaymentId: root.id });
  }
  const shortage = unreservedBudget - protectedCash - BigInt(treasury.available), deficit = BigInt(treasury.reserveDeficit);
  return { openPrincipal: openPrincipal.toString(), unreservedBudget: unreservedBudget.toString(), fundingGap: (shortage > deficit ? shortage : deficit).toString(), openCount, paidCount, paymentCount: payments.length, attention: attention.slice(0, 8), treasury };
}
