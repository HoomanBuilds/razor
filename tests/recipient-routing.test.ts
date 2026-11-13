import assert from "node:assert/strict";
import { test } from "node:test";
import { Hono } from "hono";
import { DestinationError, normalizeDestination, usesEvmAddress } from "../src/lib/recipient-destination";
import { recipientWorkspaceRoutes } from "../src/server/recipient-workspace";
import { ApiError, type AccessContext, type AppEnv } from "../src/server/context";
import { getDb, row } from "../src/server/db";
import { hashToken } from "../src/server/identity/crypto";
import { createPayment, getPayment } from "../src/server/payments/service";
import { getRecipient, importRecipientCsv } from "../src/server/identity/recipients";

process.env.DATABASE_PATH = ":memory:";
process.env.DATA_ENCRYPTION_KEY = "51".repeat(32);
process.env.APP_URL = "http://localhost:3000";
const classic = "rGWrZyQqhTp9Xu7G5Pkayo7bXjH4k4QYpf";
// XRP vectors are from ripple-address-codec; see src/lib/recipient-destination.NOTICE.
const vectors = [
  ["0", "XVLhHMPHU98es4dbozjVtdWzVrDjtV8AqEL4xcZj5whKbmc"],
  ["1", "XVLhHMPHU98es4dbozjVtdWzVrDjtV8xvjGQTYPiAx6gwDC"],
  ["4294967295", "XVLhHMPHU98es4dbozjVtdWzVrDjtV18pX8yuPT7y4xaEHi"],
] as const;

test("XRP tags use canonical mainnet X-addresses including zero and the uint32 boundary", () => {
  for (const [memo, address] of vectors) {
    assert.deepEqual(normalizeDestination("xrp", classic, memo), { address, memo });
    assert.deepEqual(normalizeDestination("xrp", address), { address, memo });
  }
  assert.deepEqual(normalizeDestination("xrp", classic), { address: classic, memo: null });
  for (const memo of ["-1", "01", "4294967296", "1.5", "1e3"]) assert.throws(() => normalizeDestination("xrp", classic, memo));
  assert.throws(() => normalizeDestination("xrp", vectors[1][1], "0"), error => error instanceof DestinationError && error.code === "DESTINATION_TAG_MISMATCH");
  assert.throws(() => normalizeDestination("xrp", "TVE26TYGhfLC7tQDno7G8dGtxSkYQnSy8RHqGHoGJ59spi2"));
  assert.throws(() => normalizeDestination("xrp", vectors[1][1].slice(0, -1) + "1"));
});

test("destination validation checks network families and rejects unsupported receiving metadata", () => {
  for (const network of ["base", "xlayer", "scroll", "hood", "hlevm", "hypercore", "linea", "mantle", "blast", "celo", "zksync", "abs"]) assert.equal(normalizeDestination(network, "0x1111111111111111111111111111111111111111").memo, null);
  assert.equal(normalizeDestination("btc", "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa").memo, null);
  assert.equal(normalizeDestination("bch", "bitcoincash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a").memo, null);
  assert.equal(normalizeDestination("stellar", "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF").memo, null);
  assert.equal(normalizeDestination("ton", "EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c").memo, null);
  assert.equal(normalizeDestination("fogo", "11111111111111111111111111111111").memo, null);
  assert.throws(() => normalizeDestination("ltc", "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa"));
  assert.throws(() => normalizeDestination("tron", "TQ1shhBFTN2TwaRXyH1oLyCz3Yvfbzgmba"));
  assert.throws(() => normalizeDestination("stellar", "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF", "exchange-memo"), error => error instanceof DestinationError && error.code === "DESTINATION_METADATA_UNSUPPORTED");
  assert.throws(() => normalizeDestination("ton", "0:" + "11".repeat(32), "required-comment"));
  assert.throws(() => normalizeDestination("near", ""));
  assert.throws(() => normalizeDestination("future-network", "plausible-address"), error => error instanceof DestinationError && error.code === "DESTINATION_NETWORK_UNVERIFIED");
});

test("confirmation versions and immutable payment snapshots preserve encoded routing metadata", async () => {
  const db = getDb(), now = new Date().toISOString(), owner = "routing-owner", receiver = "routing-recipient", organizationId = "routing-company";
  for (const id of [owner, receiver]) db.prepare("INSERT INTO users(id,name,created_at) VALUES(?,?,?)").run(id, id, now);
  db.prepare("INSERT INTO organizations(id,name,owner_id,created_at,updated_at) VALUES(?,?,?,?,?)").run(organizationId, "Routing Company", owner, now, now);
  const access: AccessContext = { userId: owner, organizationId, permissions: ["recipients:manage", "payments:read", "payments:prepare"] };
  const token = { assetId: "nep141:xrp.omft.near", blockchain: "xrp", symbol: "XRP", decimals: 6, contractAddress: null };
  const csv = `external_id,name,kind,primary_asset,primary_network,primary_address,primary_memo\nxrp-worker,Worker,employee,${token.assetId},xrp,${classic},0`;
  const imported = importRecipientCsv(access, csv, [token]).results[0].recipient!;
  assert.equal(imported.primary_address, vectors[0][1]); assert.equal(imported.primary_memo, "0");
  assert.equal(imported.preference_status, "pending_confirmation");
  db.prepare("UPDATE recipients SET user_id=? WHERE id=?").run(receiver, imported.id);
  const session = "recipient-routing-session";
  db.prepare("INSERT INTO sessions(id,user_id,token_hash,expires_at,created_at) VALUES(?,?,?,?,?)").run(session, receiver, hashToken(session), new Date(Date.now() + 60000).toISOString(), now);
  const app = new Hono<AppEnv>().route("/", recipientWorkspaceRoutes);
  app.onError((error, c) => { if (error instanceof ApiError) return c.json({ code: error.code }, error.status as 400); throw error; });
  const confirm = (expectedVersion: number, memo: string) => app.request(`http://localhost:3000/profiles/${imported.id}/confirm`, { method: "POST", headers: { Origin: "http://localhost:3000", Cookie: `razor_session=${session}`, "Content-Type": "application/json" }, body: JSON.stringify({ expectedVersion, primaryAsset: token.assetId, primaryNetwork: "xrp", primaryAddress: classic, primaryMemo: memo, fallbackConsent: false }) });
  const first = await confirm(1, "0"); assert.equal(first.status, 200);
  const payment = createPayment(access, { recipientId: imported.id, reference: "routing-pay", amount: "1000000" });
  assert.equal(JSON.parse(payment.recipient_snapshot).primary_memo, "0");
  assert.equal((await confirm(2, "1")).status, 200);
  const updated = getRecipient(organizationId, imported.id);
  assert.equal(updated.version, 3); assert.equal(updated.primary_address, vectors[1][1]); assert.equal(updated.primary_memo, "1");
  assert.equal(JSON.parse(getPayment(access, payment.id).recipient_snapshot).primary_address, vectors[0][1]);
  assert.equal((await confirm(2, "0")).status, 409);
  assert.equal(importRecipientCsv(access, csv, null).results[0].status, "existing");
  assert.equal(row<{ count: number }>("SELECT count(*) AS count FROM recipient_versions WHERE recipient_id=?", imported.id)!.count, 3);
  assert.ok(row<{ profile_ciphertext: string }>("SELECT profile_ciphertext FROM recipient_versions WHERE recipient_id=? AND version=3", imported.id)!.profile_ciphertext.startsWith("enc1:"));
});


test("source wallet compatibility distinguishes EVM funding from manual-only networks", () => {
  assert.equal(usesEvmAddress("ethereum"), true);
  assert.equal(usesEvmAddress("linea"), true);
  assert.equal(usesEvmAddress("btc"), false);
  assert.equal(usesEvmAddress("ton"), false);
});
