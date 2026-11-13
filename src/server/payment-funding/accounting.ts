import { row, rows } from "../db";
import { paymentTermsHash, reservePositions, sourceIsUnresolved } from "../client-reserves/accounting";
import { paymentBudget } from "../../lib/payment-budget";
import type { FundingLeg, Payment, TreasuryConfig } from "../payments/types";

export interface FundingTask { payment_id: string; organization_id: string; terms_hash: string; cash_committed: string; created_by: string; created_at: string; updated_at: string }
const min = (a: bigint, b: bigint) => a < b ? a : b;

export function verifiedLinkedCredit(organizationId: string, funding: FundingLeg): bigint {
  const config = row<TreasuryConfig>("SELECT * FROM treasury_config WHERE organization_id=?", organizationId);
  if (!config || funding.status !== "confirmed" || funding.recipient_address !== config.near_account_id) return 0n;
  const amount = rows<{ amount: string }>("SELECT amount FROM funding_credit_receipts WHERE funding_id=? AND organization_id=? AND network=? AND token_contract=?", funding.id, organizationId, config.network, config.token_contract).reduce((sum, value) => sum + BigInt(value.amount), 0n);
  return amount > 0n && amount === BigInt(funding.credited_amount) ? amount : 0n;
}

export function fundingPositions(organizationId: string) {
  const tasks = new Map(rows<FundingTask>("SELECT * FROM payment_funding_tasks WHERE organization_id=?", organizationId).map(task => [task.payment_id, task]));
  const funding = rows<FundingLeg>("SELECT * FROM funding_legs WHERE organization_id=? AND payment_id IS NOT NULL", organizationId);
  const clientPositions = reservePositions(organizationId);
  return rows<Payment>("SELECT * FROM payments WHERE organization_id=?", organizationId).map(payment => {
    const task = tasks.get(payment.id), legs = funding.filter(leg => leg.payment_id === payment.id);
    const credit = legs.reduce((sum, leg) => sum + verifiedLinkedCredit(organizationId, leg), 0n);
    const budget = paymentBudget(payment);
    const clientCash = clientPositions.filter(position => (position.activePaymentId ?? position.payment?.id) === payment.id && !["released", "terms_changed"].includes(position.state)).reduce((sum, position) => sum + position.clientReserved, 0n);
    const committed = BigInt(task?.cash_committed ?? "0");
    const outstanding = budget.remaining > BigInt(payment.reserved_amount) + clientCash ? budget.remaining - BigInt(payment.reserved_amount) - clientCash : 0n;
    const closed = ["paid", "cancelled", "partially_paid"].includes(payment.status);
    const held = !closed && payment.approved_at && !sourceIsUnresolved(payment) ? min(outstanding, credit + committed) : 0n;
    return { payment, task, legs, credit, committed, clientCash, held, termsMatch: !task || task.terms_hash === paymentTermsHash(payment), sourceInFlight: sourceIsUnresolved(payment) };
  });
}

export function linkedFundingTotals(organizationId: string) {
  return { linkedFundingReserved: fundingPositions(organizationId).reduce((sum, position) => sum + position.held, 0n).toString() };
}
