import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { getDb, row } from "../src/server/db";
import { createBill } from "../src/server/business/service";
import { encrypt } from "../src/server/identity/crypto";
import type { AccessContext } from "../src/server/context";
import { classifyProjectFunding, projectExport, projectReports } from "../src/server/projects/service";

process.env.DATABASE_PATH = ":memory:";
process.env.DATA_ENCRYPTION_KEY = "51".repeat(32);

function fixture() {
  const id = randomUUID(), fundingId = randomUUID(), now = new Date().toISOString(), db = getDb();
  db.prepare("INSERT INTO users(id,name,created_at) VALUES(?,'Owner',?)").run(id, now);
  db.prepare("INSERT INTO organizations(id,name,owner_id,created_at,updated_at) VALUES(?,'Company',?,?,?)").run(id, id, now, now);
  db.prepare("INSERT INTO funding_legs(id,organization_id,reference,origin_asset,amount_in,expected_output,quote,deposit_address,recipient_address,status,credited_amount,created_at,updated_at) VALUES(?,?,'Receipt','USDC','100000000','100000000','{}','deposit','company.near','confirmed','100000000',?,?)").run(fundingId, id, now, now);
  const access: AccessContext = { userId: id, organizationId: id, permissions: ["company:read", "payments:read", "payments:approve", "reports:read"] };
  const input = { fundingId, projectReference: "=Private project", costCenterReference: "Delivery", classification: "earned_revenue" as const, evidence: "Customer accepted the delivered service", expectedVersion: 0 };
  return { access, input, now };
}

test("project revenue requires a final credited receipt and preserves reviewed private classification history", () => {
  const { access, input, now } = fixture(), db = getDb();
  assert.throws(() => classifyProjectFunding(access, input), /verified NEAR/);
  db.prepare("INSERT INTO funding_credit_receipts(id,funding_id,organization_id,network,token_contract,transaction_hash,receipt_id,log_index,data_index,amount,evidence,verified_by,verified_at) VALUES(?,?,?,'mainnet','fixture.near','fixture-tx',?,0,0,'100000000','{}',?,?)").run(randomUUID(), input.fundingId, access.organizationId, randomUUID(), access.userId, now);
  classifyProjectFunding(access, input);
  const report = projectReports(access);
  assert.equal(report.projects[0].earnedReceipts, "100000000");
  assert.equal(report.projects[0].cashResult, "100000000");
  assert.equal(report.costCenters[0].earnedReceipts, "100000000");
  assert.equal(report.costCenters[0].reference, "Delivery");
  assert.throws(() => classifyProjectFunding(access, input), /changed/);
  assert.notEqual(row<{ project_reference_ciphertext: string }>("SELECT project_reference_ciphertext FROM project_funding_classifications WHERE funding_id=?", input.fundingId)!.project_reference_ciphertext, input.projectReference);
  assert(projectExport(access).includes('"\'=Private project"'));
  assert.equal(projectReports({ ...access, organizationId: "other-company" }).projects.length, 0);
  classifyProjectFunding(access, { ...input, expectedVersion: 1, classification: "client_deposit" });
  assert.equal(projectReports(access).projects[0].earnedReceipts, "0");
  assert.equal(row<{ n: number }>("SELECT count(*) AS n FROM project_funding_events WHERE funding_id=?", input.fundingId)!.n, 2);
});

test("an active client earmark suppresses earned receipts even when added after classification", () => {
  const { access, input, now } = fixture(), db = getDb();
  db.prepare("INSERT INTO funding_credit_receipts(id,funding_id,organization_id,network,token_contract,transaction_hash,receipt_id,log_index,data_index,amount,evidence,verified_by,verified_at) VALUES(?,?,?,'mainnet','fixture.near','fixture-tx',?,0,0,'100000000','{}',?,?)").run(randomUUID(), input.fundingId, access.organizationId, randomUUID(), access.userId, now);
  classifyProjectFunding(access, input);
  db.prepare("INSERT INTO client_reserves(id,organization_id,request_key,creation_fingerprint,amount,purpose_ciphertext,funding_id,created_by,created_at,updated_at) VALUES(?,?,'fixture','fixture','50000000',?,?,?,?,?)").run(randomUUID(), access.organizationId, encrypt("Client principal"), input.fundingId, access.userId, now, now);
  const report = projectReports(access).projects[0];
  assert.equal(report.earnedReceipts, "0");
  assert.equal(report.heldReceipts, "100000000");
  assert.equal(report.cashResult, "0");
  assert.throws(() => classifyProjectFunding(access, { ...input, expectedVersion: 1 }), /client cash/);
});


test("business setoff is reported as discharged debt and never inflates project cash", () => {
  const { access, now } = fixture(), db = getDb();
  db.prepare("INSERT INTO recipients(id,organization_id,name,kind,primary_network,primary_address,created_at,updated_at) VALUES(?,?,'Supplier','business','near','supplier.near',?,?)").run(access.organizationId, access.organizationId, now, now);
  const bill = createBill({ ...access, permissions: [...access.permissions, "payments:prepare"] }, { recipientId: access.organizationId, reference: "setoff-report", title: "Services", amount: "1000000", projectReference: "Project", costCenterReference: "Delivery" });
  db.prepare("UPDATE bills SET setoff_amount='600000' WHERE id=?").run(bill.id);
  db.prepare("UPDATE payments SET status='cancelled' WHERE id=?").run(bill.payment_id);
  const report = projectReports(access);
  assert.equal(report.projects[0].dischargedDebt, "600000");
  assert.equal(report.costCenters[0].dischargedDebt, "600000");
  assert.equal(report.projects[0].cashResult, "0");
  assert.equal(report.projects[0].settledPayments, "0");
  assert(projectExport(access).includes("debt_discharged_without_cash_micro_usdc"));
});
