import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { ZodError } from "zod";
import { getDb } from "../src/server/db";
import { encrypt } from "../src/server/identity/crypto";
import { ApiError, type AppEnv } from "../src/server/context";
import { assistantRoutes } from "../src/server/assistant";
import { financeRoutes } from "../src/server/assistant/finance";
import { deleteDraft, exportDraftPacket } from "../src/server/assistant/service";
import { deleteFinancePlan, exportFinancePacket } from "../src/server/assistant/finance/service";

process.env.DATABASE_PATH = ":memory:";
process.env.DATA_ENCRYPTION_KEY = "48".repeat(32);
const access = { userId: "packet-owner", organizationId: "packet-company", permissions: ["company:read", "documents:manage", "payments:read", "payments:prepare", "recipients:read"] };
const db = getDb(), now = new Date().toISOString(), expires = new Date(Date.now() + 86400000).toISOString();
db.prepare("INSERT INTO users(id,name,created_at) VALUES(?,'Packet owner',?)").run(access.userId, now);
for (const id of [access.organizationId, "other-packet-company"]) db.prepare("INSERT INTO organizations(id,name,owner_id,created_at,updated_at) VALUES(?,'Packet',?,?,?)").run(id, access.userId, now, now);
function seed(id: string, expiry = expires) {
  db.prepare("INSERT INTO assistant_drafts(id,organization_id,created_by,input_ciphertext,draft_ciphertext,evidence_ciphertext,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?)").run(id, access.organizationId, access.userId, encrypt("private invoice plaintext"), encrypt(JSON.stringify({ reference: "private reference", amount: "300" })), encrypt(JSON.stringify({ verification: { model: "legacy-fixture", ok: true }, decryptionKey: "must-not-export" })), now, expiry);
  db.prepare("INSERT INTO finance_plans(id,organization_id,created_by,plan_hash,source_fingerprint,payload_ciphertext,evidence_ciphertext,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?)").run(id, access.organizationId, access.userId, "0".repeat(64), "1".repeat(64), encrypt(JSON.stringify({ instruction: "private payroll instruction", verification: { model: "legacy-fixture" }, source: { reference: "private payroll reference" } })), encrypt(JSON.stringify({ decryptionKey: "must-not-export" })), now, expiry);
}
seed("packet-record"); seed("expired-packet", "2000-01-01T00:00:00.000Z"); seed("delete-packet");

test("company-authorized invoice and finance packet routes are private, attachment-only selective exports", async () => {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => { c.set("access", access); await next(); });
  app.onError((error, c) => c.json({ error: error.message }, (error instanceof ApiError ? error.status : error instanceof ZodError ? 422 : 500) as ContentfulStatusCode));
  app.route("/assistant", assistantRoutes); app.route("/finance", financeRoutes);
  for (const path of ["/assistant/drafts/packet-record/packet", "/finance/plans/packet-record/packet"]) {
    const response = await app.request(`${path}?disclosure=metadata`);
    assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.match(response.headers.get("content-disposition")!, /attachment; filename="razor-.*-evidence-v1.json"/);
    const body = await response.json(); assert.equal(body.schema, "razor.portable-evidence"); assert.equal(body.version, 1); assert.equal(body.disclosure.mode, "metadata");
    assert.equal(body.inference, null); assert.equal(body.chain, null);
    const exported = JSON.stringify(body);
    for (const value of ["private invoice plaintext", "private reference", "private payroll instruction", "must-not-export", '"decryptionKey"']) assert.equal(exported.includes(value), false, value);
    assert.equal((await app.request(`${path}?disclosure=plaintext`)).status, 422);
    assert.equal((await app.request(`${path}?includeKeys=1`)).status, 422);
  }
  const invoiceAudit = db.prepare("SELECT COUNT(*) AS total FROM assistant_audit WHERE draft_id='packet-record' AND action='invoice_packet_exported'").get() as { total: number };
  assert.equal(invoiceAudit.total, 1);
});

test("packet exports require every existing permission and exact company ownership", () => {
  for (const exportPacket of [exportDraftPacket, exportFinancePacket]) {
    assert.throws(() => exportPacket({ ...access, permissions: ["company:read"] }, "packet-record", "encrypted_wire"), error => error instanceof ApiError && error.status === 403);
    assert.throws(() => exportPacket({ ...access, organizationId: "other-packet-company" }, "packet-record", "encrypted_wire"), error => error instanceof ApiError && error.status === 404);
    assert.throws(() => exportPacket(access, "expired-packet", "encrypted_wire"), error => error instanceof ApiError && error.status === 404);
  }
  assert.throws(() => exportFinancePacket({ ...access, permissions: ["documents:manage"] }, "packet-record", "metadata"), error => error instanceof ApiError && error.status === 403);
});

test("retention expiry and deletion remove future export access", () => {
  deleteDraft(access, "delete-packet"); deleteFinancePlan(access, "delete-packet");
  assert.throws(() => exportDraftPacket(access, "delete-packet", "metadata"), error => error instanceof ApiError && error.status === 404);
  assert.throws(() => exportFinancePacket(access, "delete-packet", "metadata"), error => error instanceof ApiError && error.status === 404);
  db.prepare("UPDATE assistant_drafts SET expires_at='2000-01-01T00:00:00.000Z' WHERE id='packet-record'").run();
  db.prepare("UPDATE finance_plans SET expires_at='2000-01-01T00:00:00.000Z' WHERE id='packet-record'").run();
  assert.throws(() => exportDraftPacket(access, "packet-record", "metadata"), error => error instanceof ApiError && error.status === 404);
  assert.throws(() => exportFinancePacket(access, "packet-record", "metadata"), error => error instanceof ApiError && error.status === 404);
});
