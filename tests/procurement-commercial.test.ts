import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash, randomUUID } from "node:crypto";
import { ApiError } from "../src/server/context";
import { getDb, row, rows } from "../src/server/db";
import { decrypt, encrypt } from "../src/server/identity/crypto";
import { getAccess, PERMISSIONS } from "../src/server/identity/session";
import { createBill, approveBill } from "../src/server/business/service";
import { approveCommitment, getCommitment, reviewCommitment } from "../src/server/vendor-commitments/service";
import { awardQuote, createRequest, inspectRequest, publishRequest, quoteInput, recordReceipt, submitQuote, supplierRequests, matchInvoice } from "../src/server/procurement/service";
import { commercialInput, commercialTotals, type CommercialInput } from "../src/server/procurement/commercial";
import { procurementInvoiceReview, receivingTotals } from "../src/server/procurement/matching";

process.env.DATABASE_PATH = ":memory:"; process.env.DATA_ENCRYPTION_KEY = "c5".repeat(32);
const date = (days: number) => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10), time = (days: number) => new Date(Date.now() + days * 86400000).toISOString();
const code = (wanted: string) => (error: unknown) => error instanceof ApiError && error.code === wanted;
function commercial(): CommercialInput { return { version: 2, settlementUnit: "USDC", shippingAmount: "2000000", serviceAmount: "1000000", taxAmount: "3000000", otherAmount: "500000", taxTreatment: "included", taxConditions: "Fixed tax included in this quote", shippingConditions: "Tracked delivery to the buyer", serviceConditions: "Installation is included", deliveryConditions: "Deliver ten complete kits in one shipment", acceptanceConditions: "Buyer checks all kit serial numbers", otherChargeConditions: "One fixed packaging charge", excludedCharges: [{ kind: "other", description: "Optional future support needs a new approved order", estimateUSDC: "7000000" }], conversionEstimate: { amountUSDC: "250000", description: "Supplier estimate for receiving conversion only" } }; }
function fixture() {
  const organizationId = randomUUID(), owner = randomUUID(), supplier = randomUUID(), outsider = randomUUID(), recipientId = randomUUID(), role = randomUUID(), stamp = new Date().toISOString(), db = getDb();
  for (const user of [owner, supplier, outsider]) db.prepare("INSERT INTO users(id,name,created_at) VALUES(?,?,?)").run(user, "User", stamp);
  db.prepare("INSERT INTO organizations(id,name,owner_id,created_at,updated_at) VALUES(?,?,?,?,?)").run(organizationId, "Buyer", owner, stamp, stamp);
  db.prepare("INSERT INTO organization_roles(id,organization_id,name,permissions_json,is_owner,created_at) VALUES(?,?,?, ?,1,?)").run(role, organizationId, "Owner", JSON.stringify(PERMISSIONS), stamp);
  db.prepare("INSERT INTO memberships(organization_id,user_id,role_id,status,created_at) VALUES(?,?,?,'active',?)").run(organizationId, owner, role, stamp);
  db.prepare("INSERT INTO recipients(id,organization_id,user_id,name,kind,primary_asset,primary_network,primary_address,preference_status,confirmed_at,created_at,updated_at) VALUES(?,?,?,?,'business','USDT','eth',?,'confirmed',?,?,?)").run(recipientId, organizationId, supplier, encrypt("Actual supplier"), "0x1111111111111111111111111111111111111111", stamp, stamp, stamp);
  const access = getAccess(owner, organizationId), request = createRequest(access, { reference: randomUUID(), specification: "Ten complete hardware kits", quantity: "10", unit: "kits", budget: "100000000", deliveryFrom: date(0), deliveryTo: date(20), quoteDeadline: time(3), evidence: "Confirm kit counts and serial numbers", supplierIds: [recipientId], approvingRoleId: role });
  publishRequest(access, request.id, request.reviewToken);
  const input = { recipientId, expectedVersion: 0, payoutProfileVersion: 1, unitPrice: "5000000", deliveryDate: date(5), validUntil: time(5), terms: "Fixed complete commercial conditions apply", commercial: commercial() };
  return { access, supplier, outsider, recipientId, role, id: request.id, input };
}
function awarded() {
  const f = fixture(), quote = submitQuote(f.supplier, f.id, f.input), request = inspectRequest(f.access, f.id);
  const award = awardQuote(f.access, f.id, { recipientId: f.recipientId, quoteVersion: 1, reviewToken: request.reviewToken, quoteTermsHash: quote.fullTermsHash, commercialAcknowledged: true, purchaseReference: `PO-${f.id}` }).award!;
  return { ...f, quote, award };
}

test("commercial quotes add exact included charges while keeping estimates outside the commercial total", () => {
  const f = fixture(), quote = submitQuote(f.supplier, f.id, f.input);
  assert.equal(quote.total, "56500000"); assert.equal(quote.commercial!.lineSubtotal, "50000000"); assert.equal(quote.commercial!.fixedCharges, "6500000");
  assert.equal(quote.commercial!.conversionEstimate!.amountUSDC, "250000"); assert.equal(quote.commercial!.excludedCharges[0].estimateUSDC, "7000000");
  assert.deepEqual(quote.supplier, { name: "Actual supplier", asset: "USDT", network: "eth" });
  assert.deepEqual(supplierRequests(f.supplier)[0].payoutProfile, { recipientId: f.recipientId, version: 1, asset: "USDT", network: "eth" });
  assert.ok(!JSON.stringify(quote).includes("0x1111111111111111111111111111111111111111"));
  const stored = row<{ commercial_terms_ciphertext: string }>("SELECT commercial_terms_ciphertext FROM procurement_quotes WHERE request_id=?", f.id)!;
  assert.ok(stored.commercial_terms_ciphertext.startsWith("enc1:")); assert.ok(!stored.commercial_terms_ciphertext.includes("Tracked delivery"));
  assert.equal(rows("SELECT id FROM payments WHERE organization_id=?", f.access.organizationId).length, 0);
});

test("strict zero-allowed fixed charges reject malformed syntax, overflow and incompatible tax declarations", () => {
  const base = commercial();
  for (const value of [undefined, null, 3, {}, [], "", "01", "1.0", "-1", "1e3", "9".repeat(10000), (10n ** 30n + 1n).toString()]) {
    let parsed: { success: boolean } | undefined;
    assert.doesNotThrow(() => { parsed = commercialInput.safeParse({ ...base, taxAmount: value }); }); assert.equal(parsed!.success, false);
  }
  const zero = { ...base, shippingAmount: "0", serviceAmount: "0", taxAmount: "0", otherAmount: "0", taxTreatment: "not_applicable" as const };
  assert.equal(commercialTotals("1", (10n ** 30n).toString(), zero).commercialTotal, (10n ** 30n).toString());
  assert.throws(() => commercialTotals("1", (10n ** 30n).toString(), base), code("PROCUREMENT_BUDGET_EXCEEDED"));
  assert.equal(commercialInput.safeParse({ ...base, settlementUnit: "EUR" }).success, false);
  assert.equal(commercialInput.safeParse({ ...base, taxTreatment: "excluded" }).success, false);
  assert.equal(commercialInput.safeParse({ ...zero, taxTreatment: "excluded", excludedCharges: [{ kind: "tax", description: "Local import tax excluded", estimateUSDC: null }] }).success, true);
  assert.equal(commercialInput.safeParse({ ...base, paymentAddress: "attacker.near" }).success, false);
});

test("revision, supplier identity, actual payout snapshot and all-term hashes remain bound before award", () => {
  const f = fixture(), first = submitQuote(f.supplier, f.id, f.input), before = inspectRequest(f.access, f.id);
  assert.throws(() => submitQuote(f.outsider, f.id, { ...f.input, expectedVersion: 1 }), code("NOT_FOUND"));
  assert.equal(quoteInput.safeParse({ ...f.input, payoutAsset: "fake", payoutNetwork: "fake" }).success, false);
  getDb().prepare("UPDATE recipients SET version=2,primary_asset='USDC',primary_network='base' WHERE id=?").run(f.recipientId);
  assert.throws(() => submitQuote(f.supplier, f.id, { ...f.input, expectedVersion: 1 }), code("PROCUREMENT_PAYOUT_CHANGED"));
  const second = submitQuote(f.supplier, f.id, { ...f.input, payoutProfileVersion: 2, expectedVersion: 1, commercial: { ...commercial(), shippingConditions: "Buyer collection replaces tracked delivery" } });
  assert.equal(second.version, 2); assert.notEqual(second.fullTermsHash, first.fullTermsHash); assert.equal(second.supplier.asset, "USDC"); assert.equal(first.supplier.asset, "USDT");
  assert.throws(() => awardQuote(f.access, f.id, { recipientId: f.recipientId, quoteVersion: 1, reviewToken: before.reviewToken, purchaseReference: "STALE" }), code("PROCUREMENT_REVIEW_CHANGED"));
  const latest = inspectRequest(f.access, f.id), awardInput = { recipientId: f.recipientId, quoteVersion: 2, reviewToken: latest.reviewToken, purchaseReference: "PO-EXACT" };
  assert.throws(() => awardQuote(f.access, f.id, awardInput), code("PROCUREMENT_COMMERCIAL_REVIEW_REQUIRED"));
  assert.throws(() => awardQuote(f.access, f.id, { ...awardInput, commercialAcknowledged: true, quoteTermsHash: first.fullTermsHash }), code("PROCUREMENT_COMMERCIAL_REVIEW_REQUIRED"));
  const awarded = awardQuote(f.access, f.id, { ...awardInput, commercialAcknowledged: true, quoteTermsHash: second.fullTermsHash });
  const po = getCommitment(f.access, awarded.award!.commitment_id); assert.equal(po.state, "draft"); assert.equal(po.current_version, null); assert.equal(po.versions[0].allowance, second.total);
  assert.equal(supplierRequests(f.supplier)[0].quotes.length, 2); assert.equal(rows("SELECT id FROM payments WHERE organization_id=?", f.access.organizationId).length, 0);
});

test("the full commercial amount and budget are checked without folding in conversion estimates", () => {
  const f = fixture();
  assert.throws(() => submitQuote(f.supplier, f.id, { ...f.input, unitPrice: "9900000" }), code("PROCUREMENT_BUDGET_EXCEEDED"));
  const quote = submitQuote(f.supplier, f.id, { ...f.input, commercial: { ...commercial(), conversionEstimate: { amountUSDC: "999999999", description: "A supplier-only estimate that is not approved spend" } } });
  assert.equal(quote.total, "56500000");
  getDb().prepare("UPDATE organization_roles SET permissions_json=? WHERE id=?").run(JSON.stringify(PERMISSIONS.filter(permission => permission !== "payments:approve")), f.role);
  assert.throws(() => awardQuote(f.access, f.id, { recipientId: f.recipientId, quoteVersion: 1, reviewToken: inspectRequest(f.access, f.id).reviewToken, quoteTermsHash: quote.fullTermsHash, commercialAcknowledged: true, purchaseReference: "NO-ROLE" }), code("FORBIDDEN"));
});

test("fixed charge quotes allow one exact full invoice and hold partial invoices instead of reusing charges", () => {
  const f = awarded(); approveCommitment(f.access, f.award.commitment_id, reviewCommitment(f.access, f.award.commitment_id).reviewToken);
  recordReceipt(f.access, f.award.id, { requestKey: randomUUID(), kind: "accepted", quantity: "10", evidence: "All ten kits checked and accepted by buyer" });
  const create = (amount: string) => createBill(f.access, { recipientId: f.recipientId, reference: randomUUID(), title: "Supplier invoice", amount, maxFee: "0", commitmentReference: `PO-${f.id}`, commitmentDate: date(0), commitmentScopeConfirmed: true });
  const partial = create("20000000"); matchInvoice(f.access, f.award.id, { billId: partial.id, quantity: "4", invoiceDate: date(0), reason: "Partial invoice needs commercial allocation" });
  assert.equal(procurementInvoiceReview(f.access.organizationId, partial.id)!.fullInvoiceRequired, true); assert.throws(() => approveBill(f.access, partial.id), /Partial charge allocation is unsupported/);
  const full = create(f.quote.total); matchInvoice(f.access, f.award.id, { billId: full.id, quantity: "10", invoiceDate: date(0), reason: "Exact full quantity and fixed commercial charges" }); approveBill(f.access, full.id);
  assert.equal(receivingTotals(f.award.id).invoiced, "10"); assert.equal(getCommitment(f.access, f.award.commitment_id).used, f.quote.total);
  const repeat = create(f.quote.total); matchInvoice(f.access, f.award.id, { billId: repeat.id, quantity: "10", invoiceDate: date(0), reason: "Duplicate cannot reuse fixed charges or units" }); assert.throws(() => approveBill(f.access, repeat.id), /uninvoiced|allowance/);
});

test("legacy quote award hashes preserve the original byte-order projection and all-inclusive arithmetic", () => {
  const f = fixture(), { commercial: _commercial, payoutProfileVersion: _profile, ...legacyInput } = f.input, quote = submitQuote(f.supplier, f.id, legacyInput), review = inspectRequest(f.access, f.id);
  assert.equal(quote.commercial, null); assert.equal(quote.total, "50000000");
  const oldQuote = { request_id: quote.request_id, recipient_id: quote.recipient_id, version: quote.version, supplier_version: quote.supplier_version, supplier_user_id: quote.supplier_user_id, unit_price: quote.unit_price, total: quote.total, delivery_date: quote.delivery_date, valid_until: quote.valid_until, created_at: quote.created_at, supplier: quote.supplier, terms: quote.terms };
  const result = awardQuote(f.access, f.id, { recipientId: f.recipientId, quoteVersion: 1, reviewToken: review.reviewToken, purchaseReference: "PO-LEGACY" }), award = result.award!;
  const oldHash = createHash("sha256").update(JSON.stringify({ request: { id: f.id, quantity: review.quantity, unit: review.unit, budget: review.budget, specification: review.specification }, quote: oldQuote, commitmentId: award.commitment_id, commitmentVersion: 1 })).digest("hex");
  assert.equal(award.terms_hash, oldHash); assert.equal(inspectRequest(f.access, f.id).award!.terms_hash, oldHash);
  assert.equal(getCommitment(f.access, award.commitment_id).versions[0].allowance, "50000000");
});

test("a zero-fixed-charge modern quote preserves exact partial quantity matching", () => {
  const f = fixture(), terms = { ...commercial(), shippingAmount: "0", serviceAmount: "0", taxAmount: "0", otherAmount: "0", taxTreatment: "not_applicable" as const }, quote = submitQuote(f.supplier, f.id, { ...f.input, commercial: terms });
  const award = awardQuote(f.access, f.id, { recipientId: f.recipientId, quoteVersion: 1, reviewToken: inspectRequest(f.access, f.id).reviewToken, quoteTermsHash: quote.fullTermsHash, commercialAcknowledged: true, purchaseReference: `PO-ZERO-${f.id}` }).award!;
  approveCommitment(f.access, award.commitment_id, reviewCommitment(f.access, award.commitment_id).reviewToken);
  recordReceipt(f.access, award.id, { requestKey: randomUUID(), kind: "accepted", quantity: "4", evidence: "Four exact kits accepted by buyer" });
  const bill = createBill(f.access, { recipientId: f.recipientId, reference: randomUUID(), title: "Partial commercial invoice", amount: "20000000", maxFee: "0", commitmentReference: `PO-ZERO-${f.id}`, commitmentDate: date(0), commitmentScopeConfirmed: true });
  matchInvoice(f.access, award.id, { billId: bill.id, quantity: "4", invoiceDate: date(0), reason: "Four units with no fixed-charge allocation" }); approveBill(f.access, bill.id);
  assert.equal(procurementInvoiceReview(f.access.organizationId, bill.id)!.fullInvoiceRequired, false); assert.equal(receivingTotals(award.id).invoiced, "4"); assert.equal(getCommitment(f.access, award.commitment_id).used, "20000000");
});

test("a full-term award digest binds non-price conditions and indicative estimates even if totals stay equal", () => {
  const f = fixture(), quote = submitQuote(f.supplier, f.id, f.input), stored = row<{ commercial_terms_ciphertext: string }>("SELECT commercial_terms_ciphertext FROM procurement_quotes WHERE request_id=?", f.id)!;
  const payload = JSON.parse(decrypt(stored.commercial_terms_ciphertext)); payload.shippingConditions = "Changed shipping responsibility needs another explicit review"; payload.conversionEstimate.amountUSDC = "250001";
  getDb().prepare("UPDATE procurement_quotes SET commercial_terms_ciphertext=? WHERE request_id=?").run(encrypt(JSON.stringify(payload)), f.id);
  const changed = inspectRequest(f.access, f.id); assert.equal(changed.quotes[0].total, quote.total); assert.notEqual(changed.quotes[0].fullTermsHash, quote.fullTermsHash);
  assert.throws(() => awardQuote(f.access, f.id, { recipientId: f.recipientId, quoteVersion: 1, reviewToken: changed.reviewToken, quoteTermsHash: quote.fullTermsHash, commercialAcknowledged: true, purchaseReference: "MUST-REVIEW-ALL-TERMS" }), code("PROCUREMENT_COMMERCIAL_REVIEW_REQUIRED"));
  assert.equal(rows("SELECT id FROM vendor_commitments WHERE organization_id=?", f.access.organizationId).length, 0);
});
