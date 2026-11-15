import { createHash } from "node:crypto";
import type { Token } from "../../src/server/payments/intents";
import { getDb } from "../../src/server/db";
import { encrypt } from "../../src/server/identity/crypto";
import { getRecipient } from "../../src/server/identity/recipients";
import { createBill, approveBill } from "../../src/server/business/service";
import { companyExpense, reviewExpense, saveExpensePolicy } from "../../src/server/expenses/service";
import { createRequest, publishRequest, submitQuote, inspectRequest, awardQuote, recordReceipt } from "../../src/server/procurement/service";
import { createCommitment, reviewCommitment, approveCommitment } from "../../src/server/vendor-commitments/service";
import { createRecurring, notify } from "../../src/server/operations/service";
import { createDistribution } from "../../src/server/distributions/service";
import { distributionTermsHash, type FrozenPlan, type ChainDistribution } from "../../src/server/distributions/model";
import { access, companies, identities, insert, nearUsdc, seed, stableId, type DemoSeed } from "../demo/seed";

export interface PublicDemoSeed extends DemoSeed {
  fixtureIds: {
    expenses: string[];
    documents: string[];
    projects: string[];
    costCenters: string[];
    procurementRequests: string[];
    commitments: string[];
    recurring: string[];
    distributions: string[];
    supplierRecipient: string;
    nativeRecipient: string;
  };
  distributionStates: Record<string, ChainDistribution>;
}

const digest = (value: string | Buffer | object) => createHash("sha256").update(typeof value === "string" || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest("hex");
const at = (days: number) => new Date(Date.now() + days * 86400000).toISOString();
const date = (days: number) => at(days).slice(0, 10);
const id = (value: string) => stableId(`public-demo:${value}`);

function receiptPdf(lines: string[]) {
  const escaped = lines.map(line => line.replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)"));
  const stream = `BT /F1 12 Tf 50 760 Td 18 TL ${escaped.map((line, index) => `${index ? "T* " : ""}(${line}) Tj`).join("\n")} ET`;
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>", "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>", "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>", `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`];
  let content = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) { offsets.push(Buffer.byteLength(content)); content += `${index + 1} 0 obj\n${object}\nendobj\n`; }
  const xref = Buffer.byteLength(content);
  content += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(content);
}

export function seedPublicDemo(tokens: Token[]): PublicDemoSeed {
  if (process.env.DATABASE_PATH !== ":memory:") throw new Error("Public demo fixtures require an isolated in-memory database");
  const scenario = seed(tokens), db = getDb(), owner = access(), now = at(0);
  const fixtureIds: PublicDemoSeed["fixtureIds"] = { expenses: [], documents: [], projects: ["Atlas launch", "Platform operations"], costCenters: ["Product", "Engineering", "Operations"], procurementRequests: [], commitments: [], recurring: [], distributions: [], supplierRecipient: id("leo-supplier"), nativeRecipient: id("maya-rewards") };
  const distributionStates: PublicDemoSeed["distributionStates"] = {};

  db.prepare("UPDATE payroll_runs SET reference=?,period_start=?,period_end=?,scheduled_for=? WHERE id=?").run("TEAM PAY - CURRENT PERIOD", date(-14), date(0), at(2), scenario.runId);
  db.prepare("UPDATE payroll_items SET note=? WHERE run_id=? AND recipient_id=?").run(encrypt("Engineering retainer"), scenario.runId, scenario.recipientIds.leo);
  db.prepare("UPDATE sessions SET expires_at=?").run(at(30));
  db.prepare("UPDATE funding_legs SET reference=? WHERE id=?").run("OPERATING CAPITAL - PREVIOUS PERIOD", stableId("opening-funding:0"));
  db.prepare("UPDATE funding_legs SET reference=? WHERE id=?").run("OPERATING CAPITAL - CURRENT PERIOD", stableId("opening-funding:1"));

  function profile(key: string, name: string, userId: string, kind: "employee" | "business", address: string) {
    const recipientId = id(key), token = tokens.find(value => value.blockchain === "near" && value.symbol === "USDC");
    if (!token) throw new Error("The explicit demo token fixture must include native NEAR USDC");
    insert(db, "recipients", { id: recipientId, organization_id: companies.northstar.id, user_id: userId, name: encrypt(name), email: encrypt(`${key}@demo.example`), kind, primary_asset: `nep141:${nearUsdc}`, primary_network: "near", primary_address: address, backup_network: "base", backup_address: `0x${digest(key).slice(0, 40)}`, fallback_consent: 1, preference_status: "confirmed", confirmed_at: at(-20), created_at: at(-25), updated_at: now });
    insert(db, "recipient_versions", { recipient_id: recipientId, version: 1, profile_ciphertext: encrypt(JSON.stringify(getRecipient(companies.northstar.id, recipientId))), changed_by: userId, created_at: at(-20) });
    insert(db, "linked_wallets", { id: id(`${key}:wallet`), user_id: userId, family: "near", address, network: "mainnet", label: name, created_at: at(-20) });
    return recipientId;
  }
  profile("leo-supplier", "Martins Engineering", identities.leo.id, "business", "martins.demo.near");
  profile("maya-rewards", "Maya Chen - team rewards", identities.maya.id, "employee", "maya.demo.near");

  const attributed = db.prepare("SELECT id FROM bills WHERE organization_id=? ORDER BY reference,id").all(companies.northstar.id) as { id: string }[];
  for (const [index, bill] of attributed.entries()) db.prepare("UPDATE bills SET project_reference=?,cost_center_reference=? WHERE id=?").run(encrypt(fixtureIds.projects[index % 2]), encrypt(fixtureIds.costCenters[index % 3]), bill.id);

  for (const company of [companies.northstar, companies.harbor]) saveExpensePolicy(access(company.id), { expectedVersion: 0, enabled: true, perExpenseLimitUSDC: "1500", monthlyPersonLimitUSDC: "3000", requireCostCenter: true, costCenters: fixtureIds.costCenters });
  const expenseSpecs = [
    { key: "workshop", user: identities.maya, recipientId: scenario.recipientIds.maya, company: companies.northstar, merchant: "Foundry Workshop", amount: "245.00", purpose: "Product design workshop for the Atlas launch", center: "Product", age: 2, original: "245.00 USD", decision: null },
    { key: "coworking", user: identities.leo, recipientId: scenario.recipientIds.leo, company: companies.northstar, merchant: "Harbor Workspace", amount: "180.00", purpose: "Engineering coworking day passes", center: "Engineering", age: 5, original: "180.00 USD", decision: "return" },
    { key: "rail", user: identities.maya, recipientId: scenario.recipientIds.maya, company: companies.northstar, merchant: "Coastal Rail", amount: "128.50", purpose: "Travel to the client planning session", center: "Operations", age: 9, original: "118.00 EUR", decision: "accept" },
    { key: "supplies", user: identities.maya, recipientId: scenario.recipientIds.mayaHarbor, company: companies.harbor, merchant: "Paper & Desk", amount: "64.20", purpose: "Materials for the partner design review", center: "Product", age: 4, original: "64.20 USD", decision: null },
  ] as const;
  for (const spec of expenseSpecs) {
    const expenseId = id(`expense:${spec.key}`), documentId = id(`document:${spec.key}`), reference = `EXP-${spec.key.toUpperCase()}`, submittedAt = at(-spec.age);
    const fields = { merchant: spec.merchant, receiptReference: reference, expenseDate: date(-spec.age), amountUSDC: spec.amount, purpose: spec.purpose, costCenter: spec.center };
    const sourceLines = ["FICTIONAL DEMO RECEIPT", spec.merchant, `Receipt ${reference}`, `Date ${fields.expenseDate}`, `Original receipt: ${spec.original}`, `Agreed reimbursement: ${spec.amount} USDC`, spec.purpose, "Sample data only. No actual purchase or transfer."];
    const bytes = receiptPdf(sourceLines), text = sourceLines.join("\n"), sourceHash = digest(bytes), amount = BigInt(spec.amount.replace(".", "")).toString() + "0000", recipient = getRecipient(spec.company.id, spec.recipientId);
    insert(db, "invoice_documents", { id: documentId, organization_id: spec.company.id, created_by: spec.user.id, filename_ciphertext: encrypt(`${reference.toLowerCase()}-sample.pdf`), media_type: "application/pdf", byte_length: bytes.length, source_hash: sourceHash, original_ciphertext: encrypt(bytes.toString("base64")), text_ciphertext: encrypt(text), text_hash: digest(text), status: "ready", created_at: submittedAt, updated_at: submittedAt, expires_at: at(60) });
    insert(db, "expense_requests", { id: expenseId, organization_id: spec.company.id, submitted_by: spec.user.id, recipient_id: spec.recipientId, recipient_version: 1, recipient_snapshot_ciphertext: encrypt(JSON.stringify(recipient)), submitter_name_ciphertext: encrypt(spec.user.name), request_key: `public-demo:${spec.key}`, request_hash: digest({ recipientId: spec.recipientId, input: fields, sourceHash }), source_hash: sourceHash, identity_hash: digest({ merchant: spec.merchant.toLowerCase(), reference: reference.toLowerCase(), date: fields.expenseDate }), document_id: documentId, amount, payload_ciphertext: encrypt(JSON.stringify(fields)), status: "submitted", policy_month: submittedAt.slice(0, 7), submitted_at: submittedAt, updated_at: submittedAt });
    insert(db, "expense_versions", { expense_id: expenseId, version: 1, payload_ciphertext: encrypt(JSON.stringify(fields)), recipient_snapshot_ciphertext: encrypt(JSON.stringify(recipient)), amount, changed_by: spec.user.id, created_at: submittedAt });
    insert(db, "expense_events", { id: id(`expense-event:${spec.key}`), expense_id: expenseId, actor_id: spec.user.id, decision: "submitted", note_ciphertext: encrypt("Sample receipt submitted with the agreed USDC reimbursement amount."), created_at: submittedAt });
    fixtureIds.expenses.push(expenseId); fixtureIds.documents.push(documentId);
    if (spec.decision) {
      const review = companyExpense(access(spec.company.id), expenseId);
      reviewExpense(access(spec.company.id), expenseId, { reviewToken: review.reviewToken, decision: spec.decision, note: spec.decision === "return" ? "Please identify the project and attach the itemized workspace receipt." : "Client travel accepted at the explicitly agreed USDC reimbursement amount.", maxFeeUSDC: "1", confirmed: true });
      db.prepare("UPDATE payments SET metadata=json_set(metadata,'$.displayReference',?) WHERE id=(SELECT b.payment_id FROM expense_requests e JOIN bills b ON b.id=e.bill_id AND b.organization_id=e.organization_id WHERE e.id=?)").run(reference,expenseId);
    }
  }

  const harborSupplier = stableId("harbor-payee"), roleId = stableId("northstar:owner");
  const requestSpecs = [
    { reference: "RFQ-ATLAS-INTERFACES", specification: "Six production-ready onboarding screens, accessible components and source design files for Atlas.", quantity: "6", unit: "screens", budget: "4800000000", suppliers: [harborSupplier, fixtureIds.supplierRecipient], award: true },
    { reference: "RFQ-INTEGRATION-REVIEW", specification: "Review the company payout integration, deliver implementation notes and resolve three prioritized issues.", quantity: "1", unit: "engagement", budget: "2400000000", suppliers: [fixtureIds.supplierRecipient, harborSupplier], award: false },
  ];
  for (const spec of requestSpecs) {
    const request = createRequest(owner, { reference: spec.reference, specification: spec.specification, quantity: spec.quantity, unit: spec.unit, budget: spec.budget, deliveryFrom: date(2), deliveryTo: date(21), quoteDeadline: at(5), evidence: "Source files, review notes and written acceptance from the project lead.", supplierIds: spec.suppliers, approvingRoleId: roleId });
    publishRequest(owner, request.id, request.reviewToken);
    for (const [index, recipientId] of spec.suppliers.entries()) submitQuote(recipientId === harborSupplier ? identities.owner.id : identities.leo.id, request.id, { recipientId, expectedVersion: 0, payoutProfileVersion: 1, unitPrice: spec.award ? index === 0 ? "680000000" : "725000000" : index === 0 ? "1800000000" : "2100000000", deliveryDate: date(12 + index), validUntil: at(10), terms: "Includes source handover and one revision round. Payment follows acceptance of the agreed deliverables.", commercial: { version: 2, settlementUnit: "USDC", shippingAmount: "0", serviceAmount: "0", taxAmount: "0", otherAmount: "0", taxTreatment: "not_applicable", taxConditions: "No additional tax in this sample quote", shippingConditions: "Digital delivery; no shipping charge", serviceConditions: "One revision round included", deliveryConditions: "Deliver the files in the shared project workspace", acceptanceConditions: "Written acceptance against the requested evidence", otherChargeConditions: "No other fixed charges", excludedCharges: [], conversionEstimate: null } });
    fixtureIds.procurementRequests.push(request.id);
    if (spec.award) {
      const review = inspectRequest(owner, request.id), quote = review.quotes.find(value => value.recipient_id === harborSupplier)!;
      const awarded = awardQuote(owner, request.id, { recipientId: harborSupplier, quoteVersion: quote.version, reviewToken: review.reviewToken, purchaseReference: "PO-ATLAS-INTERFACES", quoteTermsHash: quote.fullTermsHash, commercialAcknowledged: true });
      const commitmentId = awarded.award!.commitment_id;
      approveCommitment(owner, commitmentId, reviewCommitment(owner, commitmentId).reviewToken);
      recordReceipt(owner, awarded.award!.id, { requestKey: "public-demo:atlas-accepted", kind: "accepted", quantity: "4", evidence: "Sample review: four interface screens accepted by the design lead." });
      recordReceipt(owner, awarded.award!.id, { requestKey: "public-demo:atlas-returned", kind: "returned", quantity: "1", evidence: "Sample review: one screen returned for keyboard-navigation improvements." });
      fixtureIds.commitments.push(commitmentId);
    }
  }

  const commitment = createCommitment(owner, { recipientId: harborSupplier, reference: "PO-PLATFORM-SUPPORT", settlementUnit: "USDC", scope: "Monthly infrastructure support, routine monitoring and incident response. New development requires separate approval.", allowance: "2400000000", cadence: "monthly", startsOn: date(-15), endsOn: date(90), targetState: "active", reason: "Agreed monthly operating support allowance" });
  approveCommitment(owner, commitment.id, reviewCommitment(owner, commitment.id).reviewToken);
  fixtureIds.commitments.push(commitment.id);
  const monthlyBill = createBill(owner, { recipientId: harborSupplier, reference: "SUPPORT-CURRENT", title: "Monthly platform support", amount: "1200000000", maxFee: "1000000", dueDate: at(3), projectReference: "Platform operations", costCenterReference: "Engineering", commitmentReference: "PO-PLATFORM-SUPPORT", commitmentDate: date(0), commitmentScopeConfirmed: true, evidence: "Sample monthly service review approved by the engineering lead." });
  approveBill(owner, monthlyBill.id);
  const recurring = createRecurring(owner, { kind: "bill", entityId: monthlyBill.id, intervalDays: 30, nextRunAt: at(30), maxAmount: "1500000000", cadence: "months", intervalMonths: 1, monthEnd: false });
  fixtureIds.recurring.push(recurring.id);
  notify(companies.northstar.id, "public-demo:expense-review", "Two receipts need review", "Review the workshop and workspace receipts before scheduling reimbursement.", fixtureIds.expenses[0], "payments:read");
  notify(companies.northstar.id, "public-demo:supplier-quote", "New supplier quotes", "Two quotes are ready for the integration review.", fixtureIds.procurementRequests[1], "payments:read");
  notify(companies.northstar.id, "public-demo:recurring", "Next support bill scheduled", "The next cycle will prepare a draft for company approval.", recurring.id, "payments:read");

  const draft = createDistribution(owner, { reference: "TEAM MILESTONE - DRAFT", requestKey: id("distribution-draft-key"), deadline: at(30), items: [{ recipientId: fixtureIds.nativeRecipient, amount: "250000000" }] });
  fixtureIds.distributions.push(draft.id);
  const active = createDistribution(owner, { reference: "ATLAS RELEASE REWARDS", requestKey: id("distribution-active-key"), deadline: at(21), items: [{ recipientId: fixtureIds.nativeRecipient, amount: "400000000" }] });
  const frozen: FrozenPlan = { network: "mainnet", treasury: "treasury.demo.near", companyId: `${companies.northstar.id}:abcdef0123456789`, token: nearUsdc, owner: companies.northstar.account, policyVersion: "1", requiredApprovals: 1, deadlineMs: String(Date.parse(active.payload.deadline)), id: active.id, reference: active.reference, total: active.total_amount, allocations: active.payload.items.map(item => ({ claim_id: item.claimId, recipient_id: item.recipientId, recipient_version: String(item.recipientVersion), amount: item.amount, destination: item.address })) };
  db.prepare("UPDATE claim_distributions SET stage='observed',chain_status='active',chain_reserved=total_amount,plan_ciphertext=?,plan_hash=?,updated_at=? WHERE id=?").run(encrypt(JSON.stringify(frozen)), distributionTermsHash(frozen), now, active.id);
  db.prepare("UPDATE claim_distribution_allocations SET observed_status='ready' WHERE distribution_id=?").run(active.id);
  distributionStates[active.id] = { id: active.id, reference: active.reference, network: "mainnet", token_contract: nearUsdc, deadline_ms: frozen.deadlineMs, total: active.total_amount, unclaimed: active.total_amount, pending: "0", paid: "0", reclaimed: "0", policy_version: "1", terms_hash: distributionTermsHash(frozen), required_approvals: 1, approvals: [companies.northstar.account], status: "active", claims: frozen.allocations.map(item => ({ allocation: { claim_id: item.claim_id, recipient_id: item.recipient_id, recipient_version: item.recipient_version, amount: item.amount }, destination: item.destination, status: "ready", nonce: "0", sent_day: "0" })) };
  fixtureIds.distributions.push(active.id);
  return { ...scenario, fixtureIds, distributionStates };
}
