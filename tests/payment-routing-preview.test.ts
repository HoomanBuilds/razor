import assert from "node:assert/strict";
import { test } from "node:test";
import { createBill, createPayrollRun } from "../src/server/business/service";
import { getDb, row } from "../src/server/db";
import type { AccessContext } from "../src/server/context";
import { billBatchPreview, payrollPreview } from "../src/server/payment-management/service";
import { recipientRouteReadiness } from "../src/server/payment-management/routing";
import { getSupportedTokens, type Token } from "../src/server/payments/intents";
import { NATIVE_USDC } from "../src/server/payments/policy";
import type { RecipientSnapshot } from "../src/server/payments/types";

process.env.DATABASE_PATH = ":memory:";
process.env.DATA_ENCRYPTION_KEY = "52".repeat(32);
const near: Token = { assetId: `nep141:${NATIVE_USDC.near}`, blockchain: "near", symbol: "USDC", decimals: 6, contractAddress: NATIVE_USDC.near };
const base: Token = { assetId: "nep141:base-usdc.omft.near", blockchain: "base", symbol: "USDC", decimals: 6, contractAddress: NATIVE_USDC.base };
const profile: RecipientSnapshot = { id: "preview-payee", primary_asset: near.assetId, primary_network: "near", primary_address: "payee.near", primary_memo: null, backup_network: "base", backup_address: "0x1111111111111111111111111111111111111111", fallback_consent: 1, preference_status: "confirmed", confirmed_at: "2026-11-12T00:00:00.000Z", version: 1 };

test("route previews distinguish catalog support, missing data, invalid addresses and disabled backups", () => {
  const supported = recipientRouteReadiness(profile, [near, base], new Set());
  assert.equal(supported.primary.status, "supported"); assert.equal(supported.backup.status, "supported");
  assert.equal(supported.quoteRequired, true); assert.equal(supported.executionReady, false);
  const unknown = recipientRouteReadiness(profile, null, new Set());
  assert.equal(unknown.primary.status, "unknown"); assert.equal(unknown.backup.status, "unknown");
  const removed = recipientRouteReadiness(profile, [base], new Set(["base"]));
  assert.equal(removed.primary.status, "unsupported"); assert.equal(removed.backup.status, "unsupported");
  assert.ok(removed.exceptions.some(value => value.includes("not enabled")));
  assert.equal(recipientRouteReadiness({ ...profile, primary_address: "payee..near" }, [near, base], new Set()).primary.status, "invalid");
  assert.equal(recipientRouteReadiness({ ...profile, fallback_consent: 0 }, [near, base], new Set()).backup.status, "unsupported");
  assert.equal(recipientRouteReadiness({ ...profile, backup_network: "near", backup_address: "backup.near" }, [near, base], new Set()).backup.status, "invalid");
});

test("batch previews use only catalog reads and exclude transient health from exact approval tokens", async () => {
  const db = getDb(), now = new Date().toISOString();
  db.prepare("INSERT INTO users(id,name,created_at) VALUES('preview-owner','Owner',?)").run(now);
  db.prepare("INSERT INTO organizations(id,name,owner_id,created_at,updated_at) VALUES('preview-org','Company','preview-owner',?,?)").run(now, now);
  db.prepare("INSERT INTO recipients(id,organization_id,name,kind,primary_asset,primary_network,primary_address,backup_network,backup_address,fallback_consent,preference_status,confirmed_at,created_at,updated_at) VALUES(?,'preview-org','Payee','employee',?,?,?,?,?,1,'confirmed',?,?,?)")
    .run(profile.id, profile.primary_asset, profile.primary_network, profile.primary_address, profile.backup_network, profile.backup_address, now, now, now);
  const access: AccessContext = { userId: "preview-owner", organizationId: "preview-org", permissions: ["company:read", "payments:read", "payments:prepare"] };
  const run = createPayrollRun(access, { reference: "preview-run", periodStart: "2026-11-01", periodEnd: "2026-11-30", items: [{ recipientId: profile.id, amount: "1000000" }] });
  const bill = createBill(access, { recipientId: profile.id, reference: "preview-bill", title: "Reviewed work", amount: "2000000" });
  const original = globalThis.fetch;
  let catalog = [near, base], calls = 0;
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), "https://1click.chaindefuser.com/v0/tokens"); assert.equal(init?.method, "GET"); calls++;
    return Response.json(catalog);
  };
  try {
    await getSupportedTokens(true);
    const first = await payrollPreview(access, run.id), bills = await billBatchPreview(access, [bill.id]);
    assert.equal(first.items[0].routeReadiness.primary.status, "supported"); assert.equal(bills.bills[0].routeReadiness.primary.status, "supported");
    catalog = [base]; await getSupportedTokens(true);
    const changed = await payrollPreview(access, run.id), changedBills = await billBatchPreview(access, [bill.id]);
    assert.equal(changed.items[0].routeReadiness.primary.status, "unsupported"); assert.equal(changedBills.bills[0].routeReadiness.primary.status, "unsupported");
    assert.equal(changed.reviewToken, first.reviewToken); assert.equal(changedBills.reviewToken, bills.reviewToken);
    assert.equal(row<{ count: number }>("SELECT count(*) AS count FROM payout_attempts")!.count, 0);
    assert.equal(row<{ count: number }>("SELECT count(*) AS count FROM funding_legs")!.count, 0);
    assert.equal(row<{ count: number }>("SELECT count(*) AS count FROM payments")!.count, 2);
    assert.equal(calls, 2);
  } finally { globalThis.fetch = original; }
});
