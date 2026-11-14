import { randomUUID } from "node:crypto";
import { ApiError, requirePermission, type AccessContext } from "../context";
import { getDb, row, rows, transaction } from "../db";
import { decrypt, encrypt } from "../identity/crypto";
import { reservePositions } from "../client-reserves/accounting";
import { paymentBudget } from "../../lib/payment-budget";
import type { FundingLeg, Payment } from "../payments/types";
import { liabilityTotals } from "../reconciliation/liability";
import { csvCell } from "../reconciliation/export";

type Classification = "earned_revenue" | "client_deposit" | "internal_transfer";
interface Entry { funding_id: string; project_reference_ciphertext: string; cost_center_reference_ciphertext: string | null; classification: Classification; evidence_ciphertext: string; version: number; updated_at: string }
interface Bucket { reference: string; earnedReceipts: bigint; clientDeposits: bigint; internalTransfers: bigint; heldReceipts: bigint; settledPayments: bigint; sourceSpent: bigint; dischargedDebt: bigint; fundedDischargedDebt:bigint; openBudget: bigint; unpreparedLiability:bigint; remainingLiability:bigint; unresolvedPayments: number }

function verifiedCredit(organizationId: string, funding: FundingLeg) {
  const receipts = rows<{ amount: string }>("SELECT amount FROM funding_credit_receipts WHERE organization_id=? AND funding_id=?", organizationId, funding.id);
  const amount = receipts.reduce((sum, receipt) => sum + BigInt(receipt.amount), 0n);
  return funding.status === "confirmed" && amount > 0n && amount === BigInt(funding.credited_amount) ? amount : 0n;
}
function clientRestrictions(organizationId: string) {
  const holds = reservePositions(organizationId).filter(item => !["released", "closed"].includes(item.state));
  return { funding: new Set(holds.map(item => item.reserve.funding_id).filter(Boolean)), unassigned: holds.some(item => !item.reserve.funding_id) };
}

export function classifyProjectFunding(access: AccessContext, input: { fundingId: string; projectReference: string; costCenterReference?: string; classification: Classification; evidence: string; expectedVersion: number }) {
  requirePermission(access, "reports:read");
  requirePermission(access, "payments:approve");
  const projectReference = input.projectReference.trim(), costCenterReference = input.costCenterReference?.trim() || null, evidence = input.evidence.trim();
  if (!projectReference || projectReference.length > 120 || (costCenterReference?.length ?? 0) > 120 || evidence.length < 3 || evidence.length > 2000) throw new ApiError(422, "Add valid project and cost center references and the evidence for this classification", "PROJECT_CLASSIFICATION_INVALID");
  return transaction(db => {
    const funding = row<FundingLeg>("SELECT * FROM funding_legs WHERE id=? AND organization_id=?", input.fundingId, access.organizationId);
    if (!funding || verifiedCredit(access.organizationId, funding) === 0n) throw new ApiError(409, "Classify only funding backed by final verified NEAR token receipts", "PROJECT_FUNDING_UNVERIFIED");
    const held = clientRestrictions(access.organizationId);
    if (input.classification === "earned_revenue" && (held.unassigned || held.funding.has(funding.id))) throw new ApiError(409, "Resolve or attribute active client cash earmarks before classifying this receipt as earned", "PROJECT_CLIENT_FUNDS_HELD");
    const existing = row<Entry>("SELECT * FROM project_funding_classifications WHERE funding_id=? AND organization_id=?", funding.id, access.organizationId);
    if ((existing?.version ?? 0) !== input.expectedVersion) throw new ApiError(409, "The funding classification changed. Review its latest evidence before editing", "PROJECT_CLASSIFICATION_STALE");
    const version = input.expectedVersion + 1, now = new Date().toISOString();
    db.prepare("INSERT INTO project_funding_classifications(funding_id,organization_id,project_reference_ciphertext,classification,evidence_ciphertext,version,updated_by,updated_at,cost_center_reference_ciphertext) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(funding_id) DO UPDATE SET project_reference_ciphertext=excluded.project_reference_ciphertext,cost_center_reference_ciphertext=excluded.cost_center_reference_ciphertext,classification=excluded.classification,evidence_ciphertext=excluded.evidence_ciphertext,version=excluded.version,updated_by=excluded.updated_by,updated_at=excluded.updated_at").run(funding.id, access.organizationId, encrypt(projectReference), input.classification, encrypt(evidence), version, access.userId, now, costCenterReference ? encrypt(costCenterReference) : null);
    db.prepare("INSERT INTO project_funding_events(id,funding_id,organization_id,version,details_ciphertext,actor_id,created_at) VALUES(?,?,?,?,?,?,?)").run(randomUUID(), funding.id, access.organizationId, version, encrypt(JSON.stringify({ projectReference, costCenterReference, classification: input.classification, evidence })), access.userId, now);
    return { fundingId: funding.id, projectReference, classification: input.classification, version };
  });
}

export function projectReports(access: AccessContext) {
  requirePermission(access, "reports:read");
  requirePermission(access, "payments:read");
  return transaction(() => projectReportSnapshot(access));
}

function projectReportSnapshot(access: AccessContext) {
  const held = clientRestrictions(access.organizationId);
  const projects = new Map<string, Bucket>(), costCenters = new Map<string, Bucket>();
  const bucket = (map: Map<string, Bucket>, reference: string) => {
    if (!map.has(reference)) map.set(reference, { reference, earnedReceipts: 0n, clientDeposits: 0n, internalTransfers: 0n, heldReceipts: 0n, settledPayments: 0n, sourceSpent: 0n, dischargedDebt: 0n, fundedDischargedDebt:0n, openBudget: 0n, unpreparedLiability:0n, remainingLiability:0n, unresolvedPayments: 0 });
    return map.get(reference)!;
  };
  const dimensions = (projectReference: string | null, costCenterReference: string | null) => [projectReference ? bucket(projects, projectReference) : null, costCenterReference ? bucket(costCenters, costCenterReference) : null].filter((value): value is Bucket => value !== null);
  const classified = new Map(rows<Entry>("SELECT * FROM project_funding_classifications WHERE organization_id=?", access.organizationId).map(item => [item.funding_id, item]));
  const funding = rows<FundingLeg>("SELECT * FROM funding_legs WHERE organization_id=? ORDER BY created_at DESC,id", access.organizationId).map(leg => {
    const credit = verifiedCredit(access.organizationId, leg), entry = classified.get(leg.id);
    const reference = entry ? decrypt(entry.project_reference_ciphertext) : null;
    const costCenterReference = entry?.cost_center_reference_ciphertext ? decrypt(entry.cost_center_reference_ciphertext) : null;
    const heldForClient = held.unassigned || held.funding.has(leg.id);
    if (credit > 0n && entry) for (const value of dimensions(reference, costCenterReference)) {
      if (entry.classification === "earned_revenue") { if (heldForClient) value.heldReceipts += credit; else value.earnedReceipts += credit; }
      else if (entry.classification === "client_deposit") value.clientDeposits += credit;
      else value.internalTransfers += credit;
    }
    return { id: leg.id, reference: leg.reference, verifiedCredit: credit.toString(), projectReference: reference, costCenterReference, classification: entry?.classification ?? null, version: entry?.version ?? 0, evidence: entry ? decrypt(entry.evidence_ciphertext) : null, heldForClient };
  });
  for (const bill of rows<{ id: string; project_reference: string | null; cost_center_reference: string | null; amount:string; setoff_amount:string; funded_clearing_amount:string }>("SELECT id,project_reference,cost_center_reference,amount,setoff_amount,funded_clearing_amount FROM bills WHERE organization_id=? AND (project_reference IS NOT NULL OR cost_center_reference IS NOT NULL)", access.organizationId)) {
    const values = dimensions(bill.project_reference ? decrypt(bill.project_reference) : null, bill.cost_center_reference ? decrypt(bill.cost_center_reference) : null);
    for (const value of values) {value.dischargedDebt += BigInt(bill.setoff_amount);value.fundedDischargedDebt+=BigInt(bill.funded_clearing_amount);}
    const payments = rows<Payment>("SELECT p.* FROM payments p JOIN bill_installments i ON i.payment_id=p.id WHERE i.bill_id=? AND p.organization_id=?", bill.id, access.organizationId);
    const totals=liabilityTotals(bill.amount,payments,bill.setoff_amount,bill.funded_clearing_amount);
    for(const value of values){value.unpreparedLiability+=totals.unprepared;value.remainingLiability+=totals.remaining;}
    for (const value of values) for (const payment of payments) {
      value.sourceSpent += BigInt(payment.total_spent);
      if (["paid", "partially_paid"].includes(payment.status)) value.settledPayments += BigInt(payment.total_spent);
      else if (payment.status !== "cancelled") { value.openBudget += paymentBudget(payment).remaining; value.unresolvedPayments++; }
    }
  }
  const serialize = (map: Map<string, Bucket>) => [...map.values()].sort((a, b) => a.reference.localeCompare(b.reference)).map(value => ({ ...value, earnedReceipts: value.earnedReceipts.toString(), clientDeposits: value.clientDeposits.toString(), internalTransfers: value.internalTransfers.toString(), heldReceipts: value.heldReceipts.toString(), settledPayments: value.settledPayments.toString(), sourceSpent: value.sourceSpent.toString(), dischargedDebt: value.dischargedDebt.toString(), fundedDischargedDebt:value.fundedDischargedDebt.toString(), openBudget: value.openBudget.toString(), unpreparedLiability:value.unpreparedLiability.toString(), remainingLiability:value.remainingLiability.toString(), cashResult: (value.earnedReceipts - value.sourceSpent).toString() }));
  return { projects: serialize(projects), costCenters: serialize(costCenters), funding, canClassify: access.permissions.includes("payments:approve"), unassignedClientHolds: held.unassigned };
}

export function projectExport(access: AccessContext) {
  const headers = ["dimension", "reference", "earned_receipts_micro_usdc", "client_deposits_micro_usdc", "internal_transfers_micro_usdc", "receipts_held_for_client_review_micro_usdc", "settled_payment_cost_micro_usdc", "actual_source_spent_micro_usdc", "debt_discharged_without_cash_micro_usdc", "open_maximum_budget_micro_usdc", "unprepared_net_liability_micro_usdc", "remaining_invoice_liability_micro_usdc", "classified_cash_result_micro_usdc", "unresolved_payment_count", "escrow_backed_debt_discharge_micro_usdc"];
  const report = projectReports(access);
  return [headers, ...[["project", report.projects], ["cost_center", report.costCenters]].flatMap(([dimension, values]) => (values as typeof report.projects).map(item => [dimension, item.reference, item.earnedReceipts, item.clientDeposits, item.internalTransfers, item.heldReceipts, item.settledPayments, item.sourceSpent, item.dischargedDebt, item.openBudget, item.unpreparedLiability, item.remainingLiability, item.cashResult, item.unresolvedPayments,item.fundedDischargedDebt]))].map(values => values.map(csvCell).join(",")).join("\r\n");
}
