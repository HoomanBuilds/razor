import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ApiError, type AccessContext } from "../src/server/context";
import { getDb, row } from "../src/server/db";
import { approveBill, createBill, listBills } from "../src/server/business/service";
import { addBillInstallment, setBillTerms } from "../src/server/business/bill-terms";
import { approveBillBatch, previewBillBatch } from "../src/server/payment-management/service";
import { getPayment } from "../src/server/payments";
import { offerInvoice, revokeInvoice } from "../src/server/clearing/service";
import { prepareInvoiceRequest, submitInvoice } from "../src/server/recipient-workspace/service";
import { reviewDocument, uploadDocument } from "../src/server/document-intake/service";
import { amendCommitment, approveCommitment, billCommitmentReview, commitmentExport, commitmentInput, createCommitment, getCommitment, listCommitments, matchBillCommitment, reviewCommitment, withdrawCommitmentProposal } from "../src/server/vendor-commitments/service";

process.env.DATABASE_PATH = ":memory:";
process.env.DATA_ENCRYPTION_KEY = "81".repeat(32);
const date = new Date().toISOString().slice(0, 10), year = date.slice(0, 4);

function fixture() {
  const id = randomUUID(), recipientId = randomUUID(), timestamp = new Date().toISOString(), db = getDb();
  db.prepare("INSERT INTO users(id,name,created_at) VALUES(?,?,?)").run(id, "Company owner", timestamp);
  db.prepare("INSERT INTO organizations(id,name,owner_id,created_at,updated_at) VALUES(?,?,?,?,?)").run(id, "Purchasing company", id, timestamp, timestamp);
  db.prepare("INSERT INTO recipients(id,organization_id,user_id,name,kind,primary_asset,primary_network,primary_address,preference_status,confirmed_at,created_at,updated_at) VALUES(?,?,?,'Supplier','business','USDC','near','supplier.near','confirmed',?,?,?)").run(recipientId, id, id, timestamp, timestamp, timestamp);
  const access: AccessContext = { organizationId: id, userId: id, permissions: ["company:read", "company:manage", "payments:read", "payments:prepare", "payments:approve", "reports:read", "documents:manage"] };
  const terms = { recipientId, reference: "PO-100", settlementUnit: "USDC" as const, scope: "Private consulting scope: ten reviewed units", allowance: "100000000", cadence: "total" as "total" | "monthly", startsOn: `${Number(year) - 1}-01-01`, endsOn: `${Number(year) + 1}-12-31`, targetState: "active" as "active" | "paused" | "cancelled", reason: "Reviewed company purchasing request" };
  return { access, recipientId, terms };
}
function approved(f = fixture()) {
  const draft = createCommitment(f.access, f.terms);
  approveCommitment(f.access, draft.id, reviewCommitment(f.access, draft.id).reviewToken);
  return { ...f, id: draft.id };
}
function invoice(f: ReturnType<typeof fixture>, reference = randomUUID(), amount = "60000000", extra = {}) {
  return createBill(f.access, { recipientId: f.recipientId, title: "Supplier invoice", reference, amount, commitmentReference: f.terms.reference, commitmentDate: date, commitmentScopeConfirmed: true, ...extra });
}
function hasCode(code: string) { return (error: unknown) => error instanceof ApiError && error.code === code; }
function approveProposal(f: ReturnType<typeof approved>, changes = {}) {
  const current = getCommitment(f.access, f.id);
  amendCommitment(f.access, f.id, current.current_version!, { ...f.terms, ...changes });
  return approveCommitment(f.access, f.id, reviewCommitment(f.access, f.id).reviewToken);
}

test("purchase proposals precede invoices, preserve private scope and enforce company permissions", () => {
  const f = fixture(), preparer = { ...f.access, permissions: ["payments:read", "payments:prepare"] }, approver = { ...f.access, permissions: ["payments:read", "payments:approve"] };
  const proposal = createCommitment(preparer, f.terms);
  assert.equal(proposal.state, "draft"); assert.equal(proposal.current, null); assert.equal(proposal.versions[0].scope, f.terms.scope);
  assert.equal(row<{ n: number }>("SELECT COUNT(*) n FROM bills WHERE organization_id=?", f.access.organizationId)!.n, 0);
  assert.equal(row<{ n: number }>("SELECT COUNT(*) n FROM payments WHERE organization_id=?", f.access.organizationId)!.n, 0);
  assert.notEqual(row<{ scope_ciphertext: string }>("SELECT scope_ciphertext FROM vendor_commitment_versions WHERE commitment_id=?", proposal.id)!.scope_ciphertext, f.terms.scope);
  assert.throws(() => approveCommitment(preparer, proposal.id, reviewCommitment(preparer, proposal.id).reviewToken), hasCode("FORBIDDEN"));
  assert.equal(approveCommitment(approver, proposal.id, reviewCommitment(approver, proposal.id).reviewToken).state, "active");
  assert.throws(() => createCommitment(approver, { ...f.terms, reference: "OTHER" }), hasCode("FORBIDDEN"));
  assert.throws(() => getCommitment(fixture().access, proposal.id), hasCode("COMMITMENT_NOT_FOUND"));
  assert.equal(listCommitments(f.access, "po-10").length, 1);
  assert.throws(() => createCommitment(f.access, f.terms), hasCode("COMMITMENT_REFERENCE_EXISTS"));
  for (const allowance of ["0", "-1", "1.2", "", (10n ** 30n + 1n).toString()]) assert.equal(commitmentInput.safeParse({ ...f.terms, allowance }).success, false);
  assert.equal(commitmentInput.safeParse({ ...f.terms, settlementUnit: "EUR" }).success, false);
  assert.throws(() => createCommitment(f.access, { ...f.terms, reference: "DATES", startsOn: f.terms.endsOn, endsOn: f.terms.startsOn }), hasCode("COMMITMENT_DATES_INVALID"));
});

test("a named draft, unknown reference, supplier mismatch, missing scope or invalid period cannot fall back", () => {
  const f = fixture(), proposal = createCommitment(f.access, f.terms), held = invoice(f);
  assert.throws(() => approveBill(f.access, held.id), hasCode("COMMITMENT_HOLD"));
  assert.equal(getPayment(f.access, held.payment_id!).status, "draft");
  assert.throws(() => invoice(f, "UNKNOWN", "1", { commitmentReference: "TYPO" }), hasCode("COMMITMENT_NOT_FOUND"));
  assert.throws(() => invoice(f, "DATE", "1", { commitmentDate: undefined }), hasCode("COMMITMENT_DATE_REQUIRED"));
  approveCommitment(f.access, proposal.id, reviewCommitment(f.access, proposal.id).reviewToken);
  const noScope = invoice(f, "NO-SCOPE", "1", { commitmentScopeConfirmed: false });
  assert.throws(() => approveBill(f.access, noScope.id), /scope and quantities/);
  const other = fixture();
  getDb().prepare("UPDATE recipients SET organization_id=? WHERE id=?").run(f.access.organizationId, other.recipientId);
  const wrong = invoice(f, "WRONG", "1", { recipientId: other.recipientId });
  assert.throws(() => approveBill(f.access, wrong.id), /supplier differs/);
  const outside = invoice(f, "OUTSIDE", "1", { commitmentDate: `${Number(year) - 2}-12-31` });
  assert.throws(() => approveBill(f.access, outside.id), /outside the approved dates/);
  const ordinary = createBill(f.access, { recipientId: f.recipientId, reference: "NO-PO", title: "Ordinary invoice", amount: "1" });
  assert.equal(approveBill(f.access, ordinary.id).status, "approved_unfunded");
  assert.equal(listBills(f.access).find(value => value.id === held.id)!.vendorCommitment?.reference, f.terms.reference);
});

test("full commercial value is consumed once across installments, partial delivery, disputes and setoff", () => {
  const f = approved(), value = invoice(f, "INSTALLMENTS", f.terms.allowance);
  setBillTerms(f.access, value.id, { paymentAmount: "20000000", maxFee: "1", requiresAcceptance: false });
  approveBill(f.access, value.id); approveBill(f.access, value.id);
  assert.equal(getCommitment(f.access, f.id).used, f.terms.allowance);
  getDb().prepare("UPDATE payments SET status='paid',delivered_amount=amount WHERE id=?").run(value.payment_id!);
  const second = addBillInstallment(f.access, value.id, { amount: "80000000", maxFee: "1" });
  approveBill(f.access, value.id);
  getDb().prepare("UPDATE payments SET status='partially_paid',delivered_amount='30000000' WHERE id=?").run(second.payment_id!);
  getDb().prepare("UPDATE bills SET setoff_amount='10000000',status='disputed' WHERE id=?").run(value.id);
  const result = getCommitment(f.access, f.id);
  assert.equal(result.uses.length, 1); assert.equal(result.used, "100000000"); assert.equal(result.remaining, "0");
  assert.equal(result.paid, "50000000"); assert.equal(result.setoff, "10000000");
  const overrun = invoice(f, "OVER", "1");
  assert.throws(() => approveBill(f.access, overrun.id), /remaining purchase allowance/);
  assert.equal(row<{ n: number }>("SELECT COUNT(*) n FROM vendor_commitment_uses WHERE commitment_id=?", f.id)!.n, 1);
});

test("route cancellation and failed attempts never restore accepted purchasing allowance", () => {
  const f = approved(), value = invoice(f, "CANCELLED", "60000000");
  approveBill(f.access, value.id);
  getDb().prepare("UPDATE payments SET status='cancelled',reserved_amount='0' WHERE id=?").run(value.payment_id!);
  const another = invoice(f, "OVER-AFTER-CANCEL", "40000001");
  assert.throws(() => approveBill(f.access, another.id), hasCode("COMMITMENT_HOLD"));
  assert.equal(getCommitment(f.access, f.id).remaining, "40000000");
  assert.throws(() => matchBillCommitment(f.access, value.id, { commitmentReference: f.terms.reference, commitmentDate: date, commitmentScopeConfirmed: true, reason: "Try to reuse cancelled invoice" }), hasCode("COMMITMENT_MATCH_LOCKED"));
});

test("failed invoice approval rolls back its allowance and duplicate source retries cannot bypass a match", () => {
  const f = approved(), source = { documentHash: "7a".repeat(32) }, value = invoice(f, "IDEMPOTENT", "60000000", source);
  assert.equal(invoice(f, "IDEMPOTENT", "60000000", source).id, value.id);
  assert.throws(() => invoice(f, "IDEMPOTENT", "60000000", { ...source, commitmentReference: undefined, commitmentDate: undefined, commitmentScopeConfirmed: undefined }), hasCode("DUPLICATE_INVOICE"));
  getDb().prepare("UPDATE recipients SET preference_status='pending_confirmation' WHERE id=?").run(f.recipientId);
  assert.throws(() => approveBill(f.access, value.id), hasCode("RECIPIENT_CONFIRMATION_REQUIRED"));
  assert.equal(getCommitment(f.access, f.id).used, "0"); assert.equal(getPayment(f.access, value.payment_id!).status, "draft");
  getDb().prepare("UPDATE recipients SET preference_status='confirmed' WHERE id=?").run(f.recipientId);
  approveBill(f.access, value.id);
  assert.throws(() => invoice(f, "DUPLICATE-SOURCE", "1", source), hasCode("DUPLICATE_DOCUMENT"));
  assert.equal(getCommitment(f.access, f.id).used, "60000000");
});

test("approved amendments retain history, reject reductions below use and stop new commitments when paused or cancelled", () => {
  const f = approved(), value = invoice(f); approveBill(f.access, value.id);
  assert.throws(() => amendCommitment(f.access, f.id, 1, { ...f.terms, allowance: "59999999" }), hasCode("COMMITMENT_BELOW_USE"));
  const raised = approveProposal(f, { allowance: "120000000", reason: "Approve increased service scope" });
  assert.equal(raised.current_version, 2); assert.equal(raised.versions.filter(version => version.approved_at).length, 2);
  assert.equal(raised.versions.find(version => version.version === 1)!.allowance, f.terms.allowance);
  assert.equal(raised.uses[0].version, 1); assert.equal(raised.remaining, "60000000");
  assert.equal(billCommitmentReview(f.access.organizationId, value.id)?.agreedAllowance, "100000000");
  assert.equal(billCommitmentReview(f.access.organizationId, value.id)?.allowance, "120000000");
  assert.equal(billCommitmentReview(f.access.organizationId, value.id)?.version, 1);
  approveProposal(f, { allowance: "120000000", targetState: "paused" });
  const next = invoice(f, "PAUSED", "1"); assert.throws(() => approveBill(f.access, next.id), /approved and active/);
  approveProposal(f, { allowance: "120000000", targetState: "cancelled" });
  assert.throws(() => approveBill(f.access, next.id), hasCode("COMMITMENT_HOLD"));
  assert.equal(getCommitment(f.access, f.id).used, "60000000");
  assert.throws(() => amendCommitment(f.access, f.id, 4, f.terms), hasCode("COMMITMENT_CANCELLED"));
});

test("pending proposals can be corrected without erasing history and stale review tokens are rejected", () => {
  const f = fixture(), initial = createCommitment(f.access, f.terms), stale = reviewCommitment(f.access, initial.id).reviewToken;
  withdrawCommitmentProposal(f.access, initial.id, 1, "Correct the initially proposed amount");
  amendCommitment(f.access, initial.id, 0, { ...f.terms, allowance: "200000000" });
  assert.throws(() => approveCommitment(f.access, initial.id, stale), hasCode("COMMITMENT_REVIEW_CHANGED"));
  const accepted = approveCommitment(f.access, initial.id, reviewCommitment(f.access, initial.id).reviewToken);
  assert.equal(accepted.current_version, 2); assert.ok(accepted.versions.find(value => value.version === 1)!.withdrawn_at);
  amendCommitment(f.access, initial.id, 2, { ...f.terms, allowance: "300000000" });
  const review = reviewCommitment(f.access, initial.id);
  approveBill(f.access, invoice(f).id);
  assert.throws(() => approveCommitment(f.access, initial.id, review.reviewToken), hasCode("COMMITMENT_REVIEW_CHANGED"));
});

test("UTC monthly allowances have independent periods, no rollover, and preserve historical consumption floors", () => {
  const f = approved();
  const monthly = createCommitment(f.access, { ...f.terms, recipientId: f.recipientId, reference: "MONTHLY", cadence: "monthly" });
  approveCommitment(f.access, monthly.id, reviewCommitment(f.access, monthly.id).reviewToken);
  const previousMonth = new Date(`${date.slice(0, 7)}-01T00:00:00Z`); previousMonth.setUTCMonth(previousMonth.getUTCMonth() - 1);
  const previousDate = previousMonth.toISOString().slice(0, 10), extra = { commitmentReference: "MONTHLY" };
  approveBill(f.access, invoice(f, "PRIOR-MONTH", "100000000", { ...extra, commitmentDate: previousDate }).id);
  assert.equal(getCommitment(f.access, monthly.id).used, "0");
  approveBill(f.access, invoice(f, "CURRENT-MONTH", "100000000", extra).id);
  assert.equal(getCommitment(f.access, monthly.id).remaining, "0");
  assert.throws(() => approveBill(f.access, invoice(f, "NO-ROLLOVER", "1", extra).id), hasCode("COMMITMENT_HOLD"));
  assert.throws(() => amendCommitment(f.access, monthly.id, 1, { ...f.terms, reference: "MONTHLY", cadence: "monthly", allowance: "99999999" }), hasCode("COMMITMENT_BELOW_USE"));
  const expired = createCommitment(f.access, { ...f.terms, reference: "EXPIRED", endsOn: `${Number(year) - 1}-12-31` });
  approveCommitment(f.access, expired.id, reviewCommitment(f.access, expired.id).reviewToken);
  assert.throws(() => approveBill(f.access, invoice(f, "EXPIRED-BILL", "1", { commitmentReference: "EXPIRED", commitmentDate: `${Number(year) - 1}-06-01` }).id), /outside the approved dates/);
});

test("existing unapproved bills can be matched, while named PO corrections need authorized reasons", () => {
  const f = approved(), other = createCommitment(f.access, { ...f.terms, reference: "PO-OTHER" });
  approveCommitment(f.access, other.id, reviewCommitment(f.access, other.id).reviewToken);
  const value = createBill(f.access, { recipientId: f.recipientId, reference: "MATCH-LATER", title: "Supplier services", amount: "60000000" });
  const preparer = { ...f.access, permissions: ["payments:read", "payments:prepare"] }, match = { commitmentReference: f.terms.reference, commitmentDate: date, commitmentScopeConfirmed: true, reason: "Verified purchase reference from the agreement" };
  assert.equal(matchBillCommitment(preparer, value.id, match)?.problems.length, 0);
  assert.throws(() => matchBillCommitment(preparer, value.id, { ...match, commitmentReference: "PO-OTHER" }), hasCode("FORBIDDEN"));
  assert.equal(matchBillCommitment(f.access, value.id, { ...match, commitmentReference: "PO-OTHER", reason: "Corrected a recorded purchase reference" })?.reference, "PO-OTHER");
  approveBill(f.access, value.id);
  assert.throws(() => matchBillCommitment(f.access, value.id, match), hasCode("COMMITMENT_MATCH_LOCKED"));
});

test("supplier profile changes require a reviewed purchase amendment and invalidate pending supplier approval", () => {
  const f = approved(), value = invoice(f);
  getDb().prepare("UPDATE recipients SET version=version+1 WHERE id=?").run(f.recipientId);
  assert.throws(() => approveBill(f.access, value.id), /Supplier details changed/);
  const terms = { ...f.terms, reason: "Reviewed the supplier profile change" };
  amendCommitment(f.access, f.id, 1, terms);
  const prior = reviewCommitment(f.access, f.id);
  getDb().prepare("UPDATE recipients SET version=version+1 WHERE id=?").run(f.recipientId);
  assert.throws(() => approveCommitment(f.access, f.id, prior.reviewToken), hasCode("COMMITMENT_REVIEW_CHANGED"));
  assert.throws(() => approveCommitment(f.access, f.id, reviewCommitment(f.access, f.id).reviewToken), hasCode("COMMITMENT_SUPPLIER_CHANGED"));
  withdrawCommitmentProposal(f.access, f.id, 2, "Prepare the current supplier snapshot");
  amendCommitment(f.access, f.id, 1, terms);
  approveCommitment(f.access, f.id, reviewCommitment(f.access, f.id).reviewToken);
  assert.equal(getCommitment(f.access, f.id).current?.supplier_version, 3);
});

test("invoice batch review includes commitment state and usage, and all-or-nothing approval rejects aggregate overrun", () => {
  const f = approved(), a = invoice(f), b = invoice(f), review = previewBillBatch(f.access, [a.id, b.id]);
  assert.equal(review.bills[0].vendorCommitment?.allowance, f.terms.allowance);
  assert.throws(() => approveBillBatch(f.access, [a.id, b.id], review.reviewToken), hasCode("COMMITMENT_HOLD"));
  assert.equal(getCommitment(f.access, f.id).used, "0"); assert.equal(getPayment(f.access, a.payment_id!).status, "draft");
  const stale = previewBillBatch(f.access, [a.id]);
  approveProposal(f, { allowance: "200000000" });
  assert.throws(() => approveBillBatch(f.access, [a.id], stale.reviewToken), /changed/);
});

test("clearing offers reserve the same full invoice allowance and revocation cannot restore it", () => {
  const raw = fixture(), creditor = fixture(), timestamp = new Date().toISOString(), db = getDb();
  db.prepare("UPDATE recipients SET user_id=? WHERE id=?").run(creditor.access.userId, raw.recipientId);
  const f = approved(raw);
  for (const access of [f.access, creditor.access]) {
    db.prepare("INSERT INTO treasury_config(organization_id,near_account_id,network,token_contract,architecture,company_id,created_at) VALUES(?,'treasury.testnet','testnet','usdc.testnet','shared_v1',?,?)").run(access.organizationId, `${access.organizationId}:aaaaaaaaaaaaaaaa`, timestamp);
    db.prepare("INSERT INTO clearing_companies(organization_id,owner_user_id,treasury_id,owner_account_id,policy_version,network,token_contract,created_at,updated_at) VALUES(?,?,'treasury.testnet','owner.testnet','1','testnet','usdc.testnet',?,?)").run(access.organizationId, access.userId, timestamp, timestamp);
  }
  const value = invoice(f), input = { billId: value.id, creditorId: creditor.access.organizationId, startsAt: new Date(Date.now() - 60000).toISOString(), expiresAt: new Date(Date.now() + 3600000).toISOString() };
  const link = offerInvoice(f.access, input); offerInvoice(f.access, input);
  assert.equal(getCommitment(f.access, f.id).used, value.amount); assert.equal(getCommitment(f.access, f.id).uses.length, 1);
  revokeInvoice(f.access, link.id);
  const excess = invoice(f, "CLEARING-OVER", "40000001");
  assert.throws(() => offerInvoice(f.access, { ...input, billId: excess.id }), hasCode("COMMITMENT_HOLD"));
  assert.equal(getCommitment(f.access, f.id).used, value.amount);
});

test("supplier intake and document review preserve explicit PO requirements instead of stripping them", async () => {
  const f = approved(), request = submitInvoice(f.access.userId, { recipientId: f.recipientId, reference: "SUPPLIED-PO", amount: "60", currency: "USDC", commitmentReference: f.terms.reference, commitmentDate: date, lineItems: [{ description: "Services", quantity: "1", unitPrice: "60" }] });
  const prepared = prepareInvoiceRequest(f.access, request.id, { sourceFingerprint: request.sourceFingerprint, agreedUSDC: "60", maxFee: "1", reviewConfirmed: true });
  assert.equal(billCommitmentReview(f.access.organizationId, prepared.bill.id)?.reference, f.terms.reference);
  assert.throws(() => approveBill(f.access, prepared.bill.id), /scope and quantities/);
  assert.throws(() => prepareInvoiceRequest(f.access, request.id, { sourceFingerprint: request.sourceFingerprint, agreedUSDC: "60", maxFee: "1", commitmentReference: "DIFFERENT", reviewConfirmed: true }), hasCode("COMMITMENT_REFERENCE_CHANGED"));
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/amcAAAAASUVORK5CYII=", "base64");
  const { document } = await uploadDocument(f.access, { filename: "invoice.png", mediaType: "image/png", bytes: png });
  const reviewed = reviewDocument(f.access, document.id, { revision: document.revision, sourceHash: document.sourceHash, recipientId: f.recipientId, reference: "DOCUMENT-PO", title: "Reviewed document", agreedUSDC: "100.000001", maxFee: "1", reviewConfirmed: true, commitmentReference: f.terms.reference, commitmentDate: date, commitmentScopeConfirmed: true });
  assert.equal(billCommitmentReview(f.access.organizationId, reviewed.billId)?.reference, f.terms.reference);
  assert.throws(() => approveBill(f.access, reviewed.billId), hasCode("COMMITMENT_HOLD"));
  assert.equal(getCommitment(f.access, f.id).used, "0");
});

test("commitment export separates version approvals and commercial use from delivered payments and cash", () => {
  const f = approved(), value = invoice(f); approveBill(f.access, value.id);
  const csv = commitmentExport(f.access);
  assert.ok(csv.includes('"commitment_version"') && csv.includes('"accepted_invoice"') && csv.includes(value.id));
  assert.ok(csv.includes('"60000000","0","0"') && csv.includes("not cash or delivered payment"));
  assert.throws(() => commitmentExport({ ...f.access, permissions: ["payments:read"] }), hasCode("FORBIDDEN"));
});

test("concurrent database writers cannot accept invoices beyond the same remaining allowance", async () => {
  const f = approved(), a = invoice(f, "CONCURRENT-A"), b = invoice(f, "CONCURRENT-B"), directory = mkdtempSync(join(tmpdir(), "razor-commitments-")), filename = join(directory, "concurrency.sqlite");
  getDb().prepare("VACUUM INTO ?").run(filename);
  const source = 'import { approveBill } from "./src/server/business/service.ts"; try { approveBill(JSON.parse(process.argv[1]), process.argv[2]); process.stdout.write("approved"); } catch (error) { process.stdout.write(error.code ?? String(error)); }';
  function child(billId: string) {
    return new Promise<string>((resolve, reject) => {
      const process = spawn(globalThis.process.execPath, ["--max-old-space-size=256", "--import", "tsx", "--input-type=module", "--eval", source, JSON.stringify(f.access), billId], { env: { ...globalThis.process.env, DATABASE_PATH: filename }, stdio: ["ignore", "pipe", "pipe"] });
      let output = "", errors = "";
      process.stdout.on("data", value => { output += value; }); process.stderr.on("data", value => { errors += value; });
      process.on("error", reject); process.on("exit", code => code === 0 ? resolve(output) : reject(new Error(errors)));
    });
  }
  try {
    assert.deepEqual((await Promise.all([child(a.id), child(b.id)])).sort(), ["COMMITMENT_HOLD", "approved"]);
    const db = new DatabaseSync(filename);
    try { assert.equal((db.prepare("SELECT COUNT(*) n FROM vendor_commitment_uses WHERE commitment_id=?").get(f.id) as { n: number }).n, 1); }
    finally { db.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
