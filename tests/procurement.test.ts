import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ApiError, type AccessContext } from "../src/server/context";
import { getDb, row, rows } from "../src/server/db";
import { encrypt } from "../src/server/identity/crypto";
import { createBill, approveBill } from "../src/server/business/service";
import { createCommitment, reviewCommitment, approveCommitment, matchBillCommitment, amendCommitment, getCommitment } from "../src/server/vendor-commitments/service";
import { adjustStock, awardQuote, cancelRequest, createInventory, createRequest, inspectRequest, matchInvoice, overview, publishRequest, recordReceipt, requestInput, submitQuote, supplierRequests, updateInventory } from "../src/server/procurement/service";
import { procurementInvoiceReview, receivingTotals } from "../src/server/procurement/matching";

process.env.DATABASE_PATH = ":memory:";
process.env.DATA_ENCRYPTION_KEY = "8d".repeat(32);
const dateAfter = (days: number) => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
const isoAfter = (days: number) => new Date(Date.now() + days * 86400000).toISOString();
const code = (expected: string) => (error: unknown) => error instanceof ApiError && error.code === expected;
const permissions = ["company:read", "company:manage", "payments:prepare", "payments:approve", "payments:read", "recipients:read", "reports:read"];

function fixture() {
  const organizationId = randomUUID(), userId = randomUUID(), supplierUser = randomUUID(), secondUser = randomUUID(), roleId = randomUUID(), preparerRole = randomUUID(), at = new Date().toISOString(), db = getDb();
  for (const id of [userId, supplierUser, secondUser]) db.prepare("INSERT INTO users(id,name,created_at) VALUES(?,?,?)").run(id, "User", at);
  db.prepare("INSERT INTO organizations(id,name,owner_id,created_at,updated_at) VALUES(?,?,?,?,?)").run(organizationId, "Buyer company", userId, at, at);
  db.prepare("INSERT INTO organization_roles(id,organization_id,name,permissions_json,is_owner,created_at) VALUES(?,?,?,? ,1,?)").run(roleId, organizationId, "Owner", JSON.stringify(permissions), at);
  db.prepare("INSERT INTO organization_roles(id,organization_id,name,permissions_json,created_at) VALUES(?,?,?,?,?)").run(preparerRole, organizationId, "Preparer", JSON.stringify(permissions.filter(permission => permission !== "payments:approve")), at);
  db.prepare("INSERT INTO memberships(organization_id,user_id,role_id,status,created_at) VALUES(?,?,?,?,?)").run(organizationId, userId, roleId, "active", at);
  const suppliers = [supplierUser, secondUser].map((id, index) => {
    const recipient = randomUUID();
    db.prepare("INSERT INTO recipients(id,organization_id,user_id,name,kind,primary_asset,primary_network,primary_address,preference_status,confirmed_at,created_at,updated_at) VALUES(?,?,?,?, 'business','USDC','near',?,'confirmed',?,?,?)")
      .run(recipient, organizationId, id, encrypt(`Supplier ${index + 1}`), `supplier${index}.near`, at, at, at); return recipient;
  });
  const access: AccessContext = { userId, organizationId, permissions };
  const terms = { reference: `RFQ-${randomUUID()}`, specification: "Ten reviewed hardware units", quantity: "10", unit: "units", budget: "100000000", deliveryFrom: dateAfter(0), deliveryTo: dateAfter(30), quoteDeadline: isoAfter(3), evidence: "Buyer confirms checked units and serial numbers", supplierIds: suppliers, approvingRoleId: roleId };
  return { access, supplierUser, secondUser, suppliers, roleId, preparerRole, terms };
}
function opened(f = fixture()) {
  const request = createRequest(f.access, f.terms); publishRequest(f.access, request.id, request.reviewToken); return { ...f, id: request.id };
}
function quoted(f = opened()) {
  const input = { recipientId: f.suppliers[0], expectedVersion: 0, unitPrice: "5000000", deliveryDate: dateAfter(5), validUntil: isoAfter(5), terms: "All-inclusive USDC price including delivery and tax" };
  submitQuote(f.supplierUser, f.id, input); return { ...f, quoteInput: input };
}
function awarded(f = quoted()) {
  const request = awardQuote(f.access, f.id, { recipientId: f.suppliers[0], quoteVersion: 1, reviewToken: inspectRequest(f.access, f.id).reviewToken, purchaseReference: `PO-${f.id}` });
  const award = request.award!; approveCommitment(f.access, award.commitment_id, reviewCommitment(f.access, award.commitment_id).reviewToken); return { ...f, award };
}
function invoice(f: ReturnType<typeof awarded>, quantity = "4", amount = (BigInt(quantity) * 5000000n).toString()) {
  return createBill(f.access, { recipientId: f.suppliers[0], reference: `INV-${randomUUID()}`, title: "Procurement invoice", amount, maxFee: "0", commitmentReference: `PO-${f.id}`, commitmentDate: dateAfter(0), commitmentScopeConfirmed: true });
}

test("RFQs use current company roles, private specs and exact bounded quantities", () => {
  const f = fixture(), request = createRequest(f.access, f.terms);
  assert.equal(request.state, "draft"); assert.equal(supplierRequests(f.supplierUser).length, 0);
  assert.notEqual(row<{ specification_ciphertext: string }>("SELECT specification_ciphertext FROM procurement_requests WHERE id=?", request.id)!.specification_ciphertext, f.terms.specification);
  assert.equal(row<{ n: number }>("SELECT COUNT(*) AS n FROM payments WHERE organization_id=?", f.access.organizationId)!.n, 0);
  assert.throws(() => createRequest(f.access, { ...f.terms, approvingRoleId: f.preparerRole }), code("PROCUREMENT_ROLE_INVALID"));
  assert.throws(() => inspectRequest(fixture().access, request.id), code("NOT_FOUND"));
  for (const quantity of ["0", "1.5", "-1", "1000000000000", ""]) assert.equal(requestInput.safeParse({ ...f.terms, quantity }).success, false);
  getDb().prepare("UPDATE memberships SET status='removed' WHERE user_id=?").run(f.access.userId);
  assert.throws(() => createRequest(f.access, f.terms), code("COMPANY_ACCESS_DENIED"));
});

test("suppliers see only their invitations and own immutable quote versions", () => {
  const f = opened();
  assert.equal(supplierRequests(f.supplierUser).length, 1); assert.equal(supplierRequests(randomUUID()).length, 0);
  assert.throws(() => submitQuote(f.secondUser, f.id, { recipientId: f.suppliers[0], expectedVersion: 0, unitPrice: "1", deliveryDate: dateAfter(4), validUntil: isoAfter(4), terms: "Forged supplier quote" }), code("NOT_FOUND"));
  const first = submitQuote(f.supplierUser, f.id, { recipientId: f.suppliers[0], expectedVersion: 0, unitPrice: "5000000", deliveryDate: dateAfter(4), validUntil: isoAfter(4), terms: "Original complete commercial terms" });
  assert.equal(first.total, "50000000");
  submitQuote(f.supplierUser, f.id, { recipientId: f.suppliers[0], expectedVersion: 1, unitPrice: "4000000", deliveryDate: dateAfter(4), validUntil: isoAfter(4), terms: "Revised complete commercial terms" });
  assert.equal(supplierRequests(f.supplierUser)[0].quotes.length, 2); assert.equal(supplierRequests(f.secondUser)[0].quotes.length, 0);
  assert.throws(() => submitQuote(f.supplierUser, f.id, { recipientId: f.suppliers[0], expectedVersion: 1, unitPrice: "1", deliveryDate: dateAfter(4), validUntil: isoAfter(4), terms: "Stale quote revision" }), code("PROCUREMENT_QUOTE_CHANGED"));
  assert.throws(() => submitQuote(f.supplierUser, f.id, { recipientId: f.suppliers[0], expectedVersion: 2, unitPrice: "10000001", deliveryDate: dateAfter(4), validUntil: isoAfter(4), terms: "Over budget terms" }), code("PROCUREMENT_BUDGET_EXCEEDED"));
  for (let version = 2; version < 20; version++) submitQuote(f.supplierUser, f.id, { recipientId: f.suppliers[0], expectedVersion: version, unitPrice: "4000000", deliveryDate: dateAfter(4), validUntil: isoAfter(4), terms: "Bounded supplier revision history" });
  assert.throws(() => submitQuote(f.supplierUser, f.id, { recipientId: f.suppliers[0], expectedVersion: 20, unitPrice: "4000000", deliveryDate: dateAfter(4), validUntil: isoAfter(4), terms: "One excess version" }), code("PROCUREMENT_QUOTE_LIMIT"));
  getDb().prepare("UPDATE recipients SET user_id=? WHERE id=?").run(f.secondUser, f.suppliers[0]);
  assert.equal(supplierRequests(f.supplierUser).length, 0); assert.equal(supplierRequests(f.secondUser).find(request => request.recipientId === f.suppliers[0])!.quotes.length, 0);
});

test("exact human awards bind current supplier and quote, create one unapproved PO and retain history", () => {
  const f = quoted(), before = inspectRequest(f.access, f.id);
  submitQuote(f.supplierUser, f.id, { ...f.quoteInput, expectedVersion: 1, unitPrice: "4000000" });
  assert.throws(() => awardQuote(f.access, f.id, { recipientId: f.suppliers[0], quoteVersion: 1, reviewToken: before.reviewToken, purchaseReference: "PO-STALE" }), code("PROCUREMENT_REVIEW_CHANGED"));
  const current = inspectRequest(f.access, f.id), input = { recipientId: f.suppliers[0], quoteVersion: 2, reviewToken: current.reviewToken, purchaseReference: `PO-${f.id}` };
  const award = awardQuote(f.access, f.id, input); assert.equal(award.award!.poState, "draft"); assert.equal(award.award!.poVersion, null);
  assert.equal(awardQuote(f.access, f.id, input).award!.id, award.award!.id);
  assert.equal(row<{ n: number }>("SELECT COUNT(*) AS n FROM vendor_commitments WHERE organization_id=?", f.access.organizationId)!.n, 1);
  assert.equal(row<{ n: number }>("SELECT COUNT(*) AS n FROM payments WHERE organization_id=?", f.access.organizationId)!.n, 0);
  assert.throws(() => cancelRequest(f.access, f.id, "Cancel awarded sourcing"), code("PROCUREMENT_ALREADY_AWARDED"));
  getDb().prepare("UPDATE organization_roles SET archived_at=? WHERE id=?").run(new Date().toISOString(), f.roleId);
  assert.throws(() => inspectRequest(f.access, f.id), code("COMPANY_ACCESS_DENIED"));
});

test("receiving quantity gates ordinary bill approval, partial invoices and attempts cannot bypass it", () => {
  const f = awarded(), bill = invoice(f);
  assert.throws(() => approveBill(f.access, bill.id), /Record the exact procurement invoice quantity/);
  matchInvoice(f.access, f.award.id, { billId: bill.id, quantity: "4", invoiceDate: dateAfter(0), reason: "Exact unit-price invoice match" });
  assert.throws(() => approveBill(f.access, bill.id), /accepted, unreturned and uninvoiced/);
  const receipt = { requestKey: randomUUID(), kind: "accepted", quantity: "4", evidence: "Buyer checked four units against serial numbers" };
  recordReceipt(f.access, f.award.id, receipt); recordReceipt(f.access, f.award.id, receipt);
  assert.equal(receivingTotals(f.award.id).accepted, "4"); approveBill(f.access, bill.id); approveBill(f.access, bill.id);
  assert.equal(receivingTotals(f.award.id).invoiced, "4"); assert.equal(getCommitment(f.access, f.award.commitment_id).used, "20000000");
  const over = invoice(f, "1"); matchInvoice(f.access, f.award.id, { billId: over.id, quantity: "1", invoiceDate: dateAfter(0), reason: "One more unit requested" });
  assert.throws(() => approveBill(f.access, over.id), /accepted, unreturned and uninvoiced/);
  assert.equal(row<{ status: string }>("SELECT status FROM payments WHERE id=?", over.payment_id!)!.status, "draft");
  const normal = createCommitment(f.access, { recipientId: f.suppliers[0], reference: `OTHER-${f.id}`, settlementUnit: "USDC", scope: "Separate reviewed scope", allowance: "100000000", cadence: "total", startsOn: dateAfter(0), endsOn: dateAfter(30), targetState: "active", reason: "Separate normal purchase" });
  assert.throws(() => matchBillCommitment(f.access, over.id, { commitmentReference: normal.reference, commitmentDate: dateAfter(0), commitmentScopeConfirmed: true, reason: "Try bypassing receiving" }), code("PROCUREMENT_MATCH_LOCKED"));
});

test("returns preserve accepted commercial liabilities and cannot credit or pay an invoice again", () => {
  const f = awarded(), bill = invoice(f);
  recordReceipt(f.access, f.award.id, { requestKey: randomUUID(), kind: "accepted", quantity: "4", evidence: "Buyer inspected four delivered units" });
  matchInvoice(f.access, f.award.id, { billId: bill.id, quantity: "4", invoiceDate: dateAfter(0), reason: "Approved received quantity" }); approveBill(f.access, bill.id);
  recordReceipt(f.access, f.award.id, { requestKey: randomUUID(), kind: "returned", quantity: "2", evidence: "Buyer returned two defective units, refund unresolved" });
  assert.equal(receivingTotals(f.award.id).discrepancy, true); assert.equal(receivingTotals(f.award.id).available, "-2");
  assert.deepEqual(procurementInvoiceReview(f.access.organizationId, bill.id)!.problems, []);
  assert.equal(getCommitment(f.access, f.award.commitment_id).used, "20000000"); assert.equal(row<{ amount: string }>("SELECT amount FROM payments WHERE id=?", bill.payment_id!)!.amount, "20000000");
  assert.throws(() => matchInvoice(f.access, f.award.id, { billId: bill.id, quantity: "2", invoiceDate: dateAfter(0), reason: "Try changing accepted invoice" }), code("PROCUREMENT_MATCH_LOCKED"));
  assert.throws(() => recordReceipt(f.access, f.award.id, { requestKey: randomUUID(), kind: "returned", quantity: "3", evidence: "Too many returned units" }), code("PROCUREMENT_RECEIPT_QUANTITY"));
});

test("changed PO versions and supplier/amount mismatches stay held instead of using another agreement", () => {
  const f = awarded(), bill = invoice(f, "4", "21000000"); recordReceipt(f.access, f.award.id, { requestKey: randomUUID(), kind: "accepted", quantity: "10", evidence: "All ten units inspected" });
  const wrongAmount = matchInvoice(f.access, f.award.id, { billId: bill.id, quantity: "4", invoiceDate: dateAfter(0), reason: "Try incorrect commercial amount" });
  assert.ok(wrongAmount!.problems.some(value => value.includes("unit price"))); assert.throws(() => approveBill(f.access, bill.id), /unit price/);
  const other = createBill(f.access, { recipientId: f.suppliers[1], reference: randomUUID(), title: "Other supplier", amount: "5000000" });
  assert.throws(() => matchInvoice(f.access, f.award.id, { billId: other.id, quantity: "1", invoiceDate: dateAfter(0), reason: "Wrong supplier match attempt" }), code("PROCUREMENT_SUPPLIER_MISMATCH"));
  const commitment = getCommitment(f.access, f.award.commitment_id), terms = commitment.current!;
  amendCommitment(f.access, commitment.id, 1, { recipientId: f.suppliers[0], reference: commitment.reference, settlementUnit: "USDC", scope: terms.scope, allowance: "60000000", cadence: "total", startsOn: terms.starts_on, endsOn: terms.ends_on, targetState: "active", reason: "Changed agreement requires separate procurement review" });
  approveCommitment(f.access, commitment.id, reviewCommitment(f.access, commitment.id).reviewToken);
  assert.ok(procurementInvoiceReview(f.access.organizationId, bill.id)!.problems.some(value => value.includes("awarded version")));
});

test("inventory adjustments conserve stock and create one bounded unpublished RFQ per threshold cycle", () => {
  const f = fixture(), input = { sku: `SKU-${randomUUID()}`, name: "Hardware kits", unit: "units", threshold: "5", reorderQuantity: "10", reorderBudget: "50000000", supplierIds: f.suppliers, approvingRoleId: f.roleId };
  const item = createInventory(f.access, input); assert.equal(item.on_hand, "0"); assert.ok(item.reorder);
  const first = inspectRequest(f.access, item.reorder!); assert.equal(first.state, "draft"); assert.equal(first.budget, input.reorderBudget); assert.equal(first.quantity, input.reorderQuantity);
  const adjustment = { requestKey: randomUUID(), delta: "1", reason: "Counted one available kit" }; adjustStock(f.access, item.id, adjustment); adjustStock(f.access, item.id, adjustment);
  assert.equal(overview(f.access).inventory[0].on_hand, "1"); assert.equal(rows("SELECT * FROM procurement_reorders WHERE item_id=?", item.id).length, 1);
  assert.throws(() => adjustStock(f.access, item.id, { ...adjustment, delta: "2" }), code("PROCUREMENT_STOCK_CHANGED"));
  assert.throws(() => adjustStock(f.access, item.id, { requestKey: randomUUID(), delta: "-2", reason: "Invalid negative stock" }), code("PROCUREMENT_STOCK_RANGE"));
  adjustStock(f.access, item.id, { requestKey: randomUUID(), delta: "9", reason: "Actual stock replenishment" });
  const low = adjustStock(f.access, item.id, { requestKey: randomUUID(), delta: "-6", reason: "Six kits used for actual work" });
  assert.equal(low.on_hand, "4"); assert.notEqual(low.reorder, item.reorder); assert.equal(rows("SELECT * FROM procurement_reorders WHERE item_id=?", item.id).length, 2);
  const updated = updateInventory(f.access, item.id, { ...input, reorderBudget: "40000000", expectedVersion: 1 }); assert.equal(updated.policy_version, 2);
  assert.equal(inspectRequest(f.access, low.reorder!).budget, "50000000");
  assert.throws(() => updateInventory(f.access, item.id, { ...input, expectedVersion: 1 }), code("PROCUREMENT_INVENTORY_CHANGED"));
  assert.equal(row<{ n: number }>("SELECT COUNT(*) AS n FROM payments WHERE organization_id=?", f.access.organizationId)!.n, 0);
});

test("receipt retries bind immutable terms and failed financial approval rolls back quantity consumption", () => {
  const f = awarded(), input = { requestKey: randomUUID(), kind: "accepted", quantity: "4", evidence: "Four units with signed buyer inspection note" };
  recordReceipt(f.access, f.award.id, input);
  assert.throws(() => recordReceipt(f.access, f.award.id, { ...input, quantity: "5" }), code("PROCUREMENT_RECEIPT_CHANGED"));
  const bill = invoice(f); matchInvoice(f.access, f.award.id, { billId: bill.id, quantity: "4", invoiceDate: dateAfter(0), reason: "Exact source invoice and receiving match" });
  getDb().prepare("UPDATE recipients SET preference_status='pending_confirmation' WHERE id=?").run(f.suppliers[0]);
  assert.throws(() => approveBill(f.access, bill.id), code("RECIPIENT_CONFIRMATION_REQUIRED"));
  assert.equal(receivingTotals(f.award.id).invoiced, "0"); assert.equal(getCommitment(f.access, f.award.commitment_id).used, "0");
});

test("selected review roles are enforced and archived policy leaves readable, cancellable history", () => {
  const f = fixture(), db = getDb(), at = new Date().toISOString();
  db.prepare("UPDATE organization_roles SET permissions_json=? WHERE id=?").run(JSON.stringify(permissions), f.preparerRole);
  db.prepare("INSERT INTO memberships(organization_id,user_id,role_id,status,created_at) VALUES(?,?,?,'active',?)").run(f.access.organizationId, f.secondUser, f.preparerRole, at);
  const request = createRequest(f.access, { ...f.terms, approvingRoleId: f.preparerRole });
  assert.throws(() => publishRequest(f.access, request.id, request.reviewToken), code("PROCUREMENT_REVIEW_ROLE_REQUIRED"));
  publishRequest({ ...f.access, userId: f.secondUser }, request.id, request.reviewToken);
  db.prepare("UPDATE organization_roles SET archived_at=? WHERE id=?").run(at, f.preparerRole);
  assert.ok(inspectRequest(f.access, request.id).role.archived_at);
  assert.equal(supplierRequests(f.supplierUser)[0].reviewerActive, false);
  assert.throws(() => submitQuote(f.supplierUser, request.id, { recipientId: f.suppliers[0], expectedVersion: 0, unitPrice: "1", deliveryDate: dateAfter(5), validUntil: isoAfter(5), terms: "Safe held supplier quote" }), code("PROCUREMENT_ROLE_INVALID"));
  assert.equal(cancelRequest(f.access, request.id, "Company manager stops sourcing after role archival").state, "cancelled");
});

test("expired quote or changed receiving version cannot become an award", () => {
  const f = quoted(), input = { recipientId: f.suppliers[0], quoteVersion: 1, reviewToken: inspectRequest(f.access, f.id).reviewToken, purchaseReference: "PO-FRESH-ONLY" };
  getDb().prepare("UPDATE recipients SET version=version+1 WHERE id=?").run(f.suppliers[0]);
  assert.throws(() => awardQuote(f.access, f.id, input), code("PROCUREMENT_QUOTE_CHANGED"));
  const other = quoted(); getDb().prepare("UPDATE procurement_quotes SET valid_until=? WHERE request_id=?").run(isoAfter(-1), other.id);
  assert.throws(() => awardQuote(other.access, other.id, { ...input, recipientId: other.suppliers[0], reviewToken: inspectRequest(other.access, other.id).reviewToken }), code("PROCUREMENT_QUOTE_EXPIRED"));
});

test("concurrent invoice approvals cannot reuse the same accepted receiving quantity", async () => {
  const f = awarded(), a = invoice(f), b = invoice(f);
  recordReceipt(f.access, f.award.id, { requestKey: randomUUID(), kind: "accepted", quantity: "4", evidence: "Only four physical units accepted" });
  for (const bill of [a, b]) matchInvoice(f.access, f.award.id, { billId: bill.id, quantity: "4", invoiceDate: dateAfter(0), reason: "Competing received quantity match" });
  const directory = mkdtempSync(join(tmpdir(), "razor-receiving-")), filename = join(directory, "race.sqlite");
  getDb().prepare("VACUUM INTO ?").run(filename);
  const source = 'import {approveBill} from "./src/server/business/service.ts";try{approveBill(JSON.parse(process.argv[1]),process.argv[2]);process.stdout.write("approved")}catch(error){process.stdout.write(error.code??String(error))}';
  function child(billId: string) { return new Promise<string>((resolve, reject) => {
    const worker = spawn(process.execPath, ["--max-old-space-size=256", "--import", "tsx", "--input-type=module", "--eval", source, JSON.stringify(f.access), billId], { env: { ...process.env, DATABASE_PATH: filename }, stdio: ["ignore", "pipe", "pipe"] });
    let output = "", errors = ""; worker.stdout.on("data", data => { output += data; }); worker.stderr.on("data", data => { errors += data; }); worker.on("error", reject); worker.on("exit", status => status === 0 ? resolve(output) : reject(new Error(errors)));
  }); }
  try {
    assert.deepEqual((await Promise.all([child(a.id), child(b.id)])).sort(), ["COMMITMENT_HOLD", "approved"]);
    const db = new DatabaseSync(filename); try { assert.equal((db.prepare("SELECT COUNT(*) AS n FROM procurement_invoice_matches WHERE award_id=? AND accepted_at IS NOT NULL").get(f.award.id) as { n: number }).n, 1); } finally { db.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
