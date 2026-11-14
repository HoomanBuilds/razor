import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { link, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApiError, type AccessContext } from "../src/server/context";
import { getDb, row } from "../src/server/db";
import { hashToken, decrypt } from "../src/server/identity/crypto";
import { PERMISSIONS } from "../src/server/identity/session";
import { app } from "../src/server/app";
import { boundedInvoiceRequest, withDocumentIngress } from "../src/server/document-intake/limits";
import { documentOriginal, getDocument, listDocuments } from "../src/server/document-intake/service";
import { authenticateFolder, createInvoiceChannel, folderEventStatus, listInvoiceChannels, processPendingInvoiceEvents, purgeInvoiceChannelRetention, receiveFolder, receiveTelegram, receiveWhatsApp, replaceChannelSecrets, retryInvoiceEvent, revokeInvoiceChannel, rotateChannelCredential, verifyWhatsAppChallenge } from "../src/server/invoice-channels/service";
import { publicProviderAddress, safeProviderUrl, type ProviderTransport } from "../src/server/invoice-channels/transport";
import { readAllowedInvoiceFolder, watchInvoiceFolder } from "../scripts/watch-invoices";

process.env.DATABASE_PATH = ":memory:";
process.env.DATA_ENCRYPTION_KEY = "4c".repeat(32);
process.env.APP_URL = "http://localhost:3000";
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/amcAAAAASUVORK5CYII=", "base64");
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
function fixture(permissions = PERMISSIONS) {
  const id = randomUUID(), created = new Date().toISOString(), token = randomUUID(), db = getDb();
  db.prepare("INSERT INTO users(id,name,created_at) VALUES(?,?,?)").run(id, "Invoice connection owner", created);
  db.prepare("INSERT INTO organizations(id,name,owner_id,created_at,updated_at) VALUES(?,?,?,?,?)").run(id, "Connection company", id, created, created);
  db.prepare("INSERT INTO organization_roles(id,organization_id,name,permissions_json,is_owner,created_at) VALUES(?,?,?, ?,1,?)").run(id, id, "Owner", JSON.stringify(permissions), created);
  db.prepare("INSERT INTO memberships(organization_id,user_id,role_id,created_at) VALUES(?,?,?,?)").run(id, id, id, created);
  db.prepare("INSERT INTO sessions(id,user_id,token_hash,expires_at,created_at) VALUES(?,?,?,?,?)").run(randomUUID(), id, hashToken(token), new Date(Date.now() + 3600000).toISOString(), created);
  return { access: { userId: id, organizationId: id, permissions } satisfies AccessContext, cookie: `razor_session=${token}` };
}
function telegram(access: AccessContext, token = true) {
  const botId = String(Math.floor(Math.random() * 1e12) + 1000);
  return createInvoiceChannel(access, { provider: "telegram", label: "Company Telegram", botId, chatId: "-98765", senderId: "12345", botToken: token ? `${botId}:${"T".repeat(30)}` : "", privacyAcknowledged: true });
}
function update(id = 100) { return { update_id: id, message: { message_id: 5, date: 1700000000, chat: { id: -98765 }, from: { id: 12345 }, document: { file_id: "provider-file-id", file_name: "invoice.png", file_size: png.length, mime_type: "image/png" } } }; }
function whatsapp(access: AccessContext, supplied = true) {
  const phoneNumberId = String(Math.floor(Math.random() * 1e12) + 1000);
  return createInvoiceChannel(access, { provider: "whatsapp", label: "Company WhatsApp", businessAccountId: "987654", phoneNumberId, senderId: "919999999999", graphVersion: "v24.0", accessToken: supplied ? "meta-fixture-access-token" : "", appSecret: supplied ? "meta-fixture-app-secret" : "", privacyAcknowledged: true });
}
function metaBody(channel: ReturnType<typeof whatsapp>["channel"], id = "wamid.invoice-1") {
  return Buffer.from(JSON.stringify({ object: "whatsapp_business_account", entry: [{ id: "987654", changes: [{ field: "messages", value: { metadata: { phone_number_id: channel.config.phoneNumberId }, messages: [{ id, from: "919999999999", timestamp: "1700000000", type: "image", image: { id: "12345678", mime_type: "image/png", sha256: hash(png) } }] } }] }] }));
}
const signature = (body: Buffer) => `sha256=${createHmac("sha256", "meta-fixture-app-secret").update(body).digest("hex")}`;
const telegramTransport: ProviderTransport = async (url, headers, cap) => {
  assert.equal(url.hostname, "api.telegram.org"); assert.deepEqual(headers, {});
  if (url.pathname.endsWith("/getFile")) { assert.equal(url.searchParams.get("file_id"), "provider-file-id"); assert.equal(cap, 32768); return Buffer.from(JSON.stringify({ ok: true, result: { file_id: "provider-file-id", file_path: "documents/invoice.png", file_size: png.length } })); }
  assert.match(url.pathname, /\/file\/bot\d+:T+\/documents\/invoice.png$/); assert.equal(cap, 3 * 1024 * 1024); return png;
};

test("owner authorization, encrypted credentials, visible missing setup and binding isolation", () => {
  const { access } = fixture(), other = fixture(), pending = telegram(access, false);
  assert.equal(pending.channel.status, "setup_required"); assert.equal(pending.channel.verifiedAt, null);
  assert.throws(() => receiveTelegram(pending.channel.id, pending.setup.webhookSecret!, update()), /authentication/);
  const stored = row<{ secrets_ciphertext: string; config_ciphertext: string }>("SELECT secrets_ciphertext,config_ciphertext FROM invoice_channels WHERE id=?", pending.channel.id)!;
  assert.ok(stored.secrets_ciphertext.startsWith("enc1:")); assert.ok(stored.config_ciphertext.startsWith("enc1:"));
  assert.ok(decrypt(stored.secrets_ciphertext).includes(pending.setup.webhookSecret!));
  assert.equal(JSON.stringify(listInvoiceChannels(access)).includes(pending.setup.webhookSecret!), false);
  assert.equal(listInvoiceChannels(other.access).channels.length, 0);
  assert.throws(() => revokeInvoiceChannel(other.access, pending.channel.id), /not found/);
  assert.throws(() => createInvoiceChannel(other.access, { provider: "telegram", label: "Cross-company", ...pending.channel.config as { botId: string; chatId: string; senderId: string }, privacyAcknowledged: true }), /already has/);
  assert.equal(replaceChannelSecrets(access, pending.channel.id, { botToken: `${pending.channel.config.botId}:${"T".repeat(30)}` }).channel.status, "awaiting_verified_input");
  const notOwner = fixture();
  getDb().prepare("UPDATE organizations SET owner_id=? WHERE id=?").run(other.access.userId, notOwner.access.organizationId);
  assert.throws(() => telegram(notOwner.access), /owner must authorize/);
});

test("Telegram authenticates exact sender and chat, saves replay-safe event before bounded provider download", async () => {
  const { access } = fixture(), connection = telegram(access);
  assert.throws(() => receiveTelegram(connection.channel.id, "forged-secret", update()), /authentication/);
  const forged = update(); forged.message.from.id = 54321;
  assert.throws(() => receiveTelegram(connection.channel.id, connection.setup.webhookSecret!, forged), /not authorized/);
  const chat = update(); chat.message.chat.id = -777;
  assert.throws(() => receiveTelegram(connection.channel.id, connection.setup.webhookSecret!, chat), /not authorized/);
  const accepted = receiveTelegram(connection.channel.id, connection.setup.webhookSecret!, update());
  assert.equal(accepted.event!.status, "queued"); assert.equal(accepted.duplicate, false);
  assert.equal(receiveTelegram(connection.channel.id, connection.setup.webhookSecret!, update()).duplicate, true);
  const changed = update(); changed.message.document.file_id = "another-file-id";
  assert.throws(() => receiveTelegram(connection.channel.id, connection.setup.webhookSecret!, changed), /reused/);
  assert.equal(listDocuments(access).total, 0);
  assert.equal((await processPendingInvoiceEvents({ organizationId: access.organizationId, transport: telegramTransport })).processed, 1);
  const view = listInvoiceChannels(access), event = view.events[0];
  assert.equal(view.channels[0].status, "verified_input_received"); assert.ok(view.channels[0].verifiedAt);
  assert.equal(event.status, "received"); assert.equal(event.attempts, 1); assert.equal(event.source!.filename, "invoice.png");
  assert.deepEqual(documentOriginal(access, event.documentId!).bytes, png);
  const provenance = getDocument({ ...access, permissions: ["documents:manage"] }, event.documentId!).sources;
  assert.deepEqual(Object.keys(provenance[0]).sort(), ["channelName", "provider", "receivedAt"]);
  assert.equal(provenance[0].provider, "telegram"); assert.equal(provenance[0].channelName, "Company Telegram");
  assert.equal(row<{ count: number }>("SELECT COUNT(*) AS count FROM bills WHERE organization_id=?", access.organizationId)!.count, 0);
  assert.equal((await processPendingInvoiceEvents({ organizationId: access.organizationId, transport: async () => { throw new Error("Replay must not download"); } })).processed, 0);
});

test("provider failure, retry status, crash recovery and revocation keep one review source", async () => {
  const { access } = fixture(), connection = telegram(access);
  const accepted = receiveTelegram(connection.channel.id, connection.setup.webhookSecret!, update());
  await processPendingInvoiceEvents({ organizationId: access.organizationId, transport: async () => { throw new ApiError(503, "Mock provider failure", "CHANNEL_PROVIDER_UNAVAILABLE"); } });
  const failed = listInvoiceChannels(access).events[0];
  assert.equal(failed.status, "failed"); assert.equal(failed.errorCode, "CHANNEL_PROVIDER_UNAVAILABLE");
  assert.ok(failed.nextAttemptAt > new Date().toISOString());
  retryInvoiceEvent(access, accepted.event!.id);
  getDb().prepare("UPDATE invoice_channel_events SET status='processing',updated_at='2000-01-01T00:00:00Z' WHERE id=?").run(accepted.event!.id);
  await processPendingInvoiceEvents({ organizationId: access.organizationId, transport: telegramTransport });
  assert.equal(listInvoiceChannels(access).events[0].status, "received");
  receiveTelegram(connection.channel.id, connection.setup.webhookSecret!, update(101));
  revokeInvoiceChannel(access, connection.channel.id);
  assert.throws(() => receiveTelegram(connection.channel.id, connection.setup.webhookSecret!, update(102)), /revoked/);
  const revoked = row<{ secrets_ciphertext: string | null }>("SELECT secrets_ciphertext FROM invoice_channels WHERE id=?", connection.channel.id)!;
  assert.equal(revoked.secrets_ciphertext, null);
  assert.ok(listInvoiceChannels(access).events.some(event => event.status === "revoked" && event.source === null));
  assert.equal(listDocuments(access).total, 1);
});

test("WhatsApp verifies challenge and exact raw-body HMAC without treating setup as delivery", async () => {
  const { access } = fixture(), connection = whatsapp(access), missing = whatsapp(access, false);
  assert.equal(missing.channel.status, "setup_required");
  assert.throws(() => verifyWhatsAppChallenge(missing.channel.id, "subscribe", missing.setup.verifyToken!, "123"), /credentials/);
  assert.throws(() => verifyWhatsAppChallenge(connection.channel.id, "subscribe", "forged", "123"), /verification failed/);
  assert.equal(verifyWhatsAppChallenge(connection.channel.id, "subscribe", connection.setup.verifyToken!, "123456"), "123456");
  assert.equal(listInvoiceChannels(access).channels.find(channel => channel.id === connection.channel.id)!.status, "awaiting_verified_input");
  const raw = metaBody(connection.channel);
  assert.throws(() => receiveWhatsApp(connection.channel.id, signature(raw), Buffer.concat([raw, Buffer.from(" ")])), /signature/);
  const forged = Buffer.from(raw.toString().replace("919999999999", "918888888888"));
  assert.throws(() => receiveWhatsApp(connection.channel.id, signature(forged), forged), /sender/);
  const wrongAccount = Buffer.from(raw.toString().replace('"id":"987654"', '"id":"987655"'));
  assert.throws(() => receiveWhatsApp(connection.channel.id, signature(wrongAccount), wrongAccount), /account/);
  const saved = receiveWhatsApp(connection.channel.id, signature(raw), raw);
  assert.equal(saved.events.length, 1); assert.equal(receiveWhatsApp(connection.channel.id, signature(raw), raw).events[0].duplicate, true);
  let downloads = 0;
  await processPendingInvoiceEvents({ organizationId: access.organizationId, transport: async (url, headers, cap) => {
    assert.equal(headers.Authorization, "Bearer meta-fixture-access-token");
    if (url.hostname === "graph.facebook.com") { assert.equal(url.searchParams.get("phone_number_id"), connection.channel.config.phoneNumberId); return Buffer.from(JSON.stringify({ id: "12345678", url: "https://lookaside.fbsbx.com/whatsapp_business/attachments?mid=12345678", mime_type: "image/png", file_size: png.length, sha256: hash(png) })); }
    assert.equal(url.hostname, "lookaside.fbsbx.com"); assert.equal(cap, 3 * 1024 * 1024); downloads++; return png;
  } });
  assert.equal(downloads, 1); assert.equal(listInvoiceChannels(access).events[0].status, "received");
  assert.equal(listDocuments(access).total, 1);
});

test("provider metadata cannot select arbitrary hosts, traversal paths, redirects or nonpublic DNS", async () => {
  for (const url of ["http://api.telegram.org/file", "https://api.telegram.org.evil.invalid/file", "https://user:secret@graph.facebook.com/file", "https://127.0.0.1/file", "https://lookaside.fbsbx.com:444/file", "https://graph.facebook.com/#secret"]) assert.throws(() => safeProviderUrl(url), ApiError);
  for (const ip of ["127.0.0.1", "10.0.0.1", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "::ffff:127.0.0.1", "fd00::1", "2001:db8::1"]) assert.equal(publicProviderAddress(ip), false, ip);
  assert.equal(publicProviderAddress("149.154.167.220"), true); assert.equal(publicProviderAddress("2a03:2880:f10c:83:face:b00c:0:25de"), true);
  const { access } = fixture(), connection = telegram(access);
  receiveTelegram(connection.channel.id, connection.setup.webhookSecret!, update());
  let count = 0;
  await processPendingInvoiceEvents({ organizationId: access.organizationId, transport: async () => { count++; return Buffer.from(JSON.stringify({ ok: true, result: { file_id: "provider-file-id", file_path: "../../private", file_size: 1 } })); } });
  assert.equal(count, 1); assert.equal(listInvoiceChannels(access).events[0].errorCode, "CHANNEL_URL_REJECTED");
  const meta = whatsapp(access), raw = metaBody(meta.channel); receiveWhatsApp(meta.channel.id, signature(raw), raw);
  await processPendingInvoiceEvents({ organizationId: access.organizationId, transport: async () => Buffer.from(JSON.stringify({ id: "12345678", url: "https://attacker.invalid/invoice", mime_type: "image/png", file_size: png.length })) });
  assert.equal(listDocuments(access).total, 0);
  assert.ok(listInvoiceChannels(access).events.every(event => event.status === "failed"));
});

test("folder credentials are hashed, limited to one inbox, rotated and checked against current permissions", async () => {
  const { access } = fixture(), other = fixture(), connection = createInvoiceChannel(access, { provider: "folder", label: "Company folder", privacyAcknowledged: true });
  const bearer = `Bearer ${connection.setup.credential}`, id = connection.channel.id;
  assert.equal(row<{ credential_hash: string }>("SELECT credential_hash FROM invoice_channels WHERE id=?", id)!.credential_hash, hashToken(connection.setup.credential!));
  assert.throws(() => authenticateFolder(id, "Bearer invalid"), /credential/);
  assert.throws(() => authenticateFolder(id, `Bearer ${createInvoiceChannel(other.access, { provider: "folder", label: "Other company", privacyAcknowledged: true }).setup.credential}`), /credential/);
  const first = await receiveFolder(id, bearer, hash(png), { filename: "first.png", mediaType: "image/png", bytes: png });
  assert.equal(first.event.status, "received");
  const duplicate = await receiveFolder(id, bearer, hash(png), { filename: "renamed.png", mediaType: "image/png", bytes: png });
  assert.equal(duplicate.duplicate, true); assert.equal(listDocuments(access).total, 1);
  assert.equal(folderEventStatus(id, bearer, hash(png)).event.documentId, first.event.documentId);
  await assert.rejects(receiveFolder(id, bearer, "0".repeat(64), { filename: "invalid.png", mediaType: "image/png", bytes: png }), /SHA-256/);
  const next = rotateChannelCredential(access, id);
  assert.throws(() => authenticateFolder(id, bearer), /credential/);
  authenticateFolder(id, `Bearer ${next.credential}`);
  getDb().prepare("UPDATE organization_roles SET permissions_json=? WHERE id=?").run(JSON.stringify(["company:read"]), access.organizationId);
  assert.throws(() => authenticateFolder(id, `Bearer ${next.credential}`), error => error instanceof ApiError && error.status === 403);
  assert.equal(row<{ count: number }>("SELECT COUNT(*) AS count FROM payments WHERE organization_id=?", access.organizationId)!.count, 0);
});

test("ingress routes authorize before parsing, cap bodies, and deny key use on company routes", async () => {
  const owner = fixture(), connection = createInvoiceChannel(owner.access, { provider: "folder", label: "Route folder", privacyAcknowledged: true });
  const url = `http://localhost:3000/api/invoice-ingress/${connection.channel.id}/upload`;
  assert.equal((await app.request(url, { method: "POST", body: "x".repeat(2_000_000) })).status, 401);
  const headers = { Authorization: `Bearer ${connection.setup.credential}` };
  getDb().prepare("UPDATE organization_roles SET permissions_json=? WHERE id=?").run(JSON.stringify(["company:read"]), owner.access.organizationId);
  assert.equal((await app.request(url, { method: "POST", headers, body: "x".repeat(2_000_000) })).status, 403);
  getDb().prepare("UPDATE organization_roles SET permissions_json=? WHERE id=?").run(JSON.stringify(PERMISSIONS), owner.access.organizationId);
  const file = Buffer.concat([png, Buffer.alloc(1_100_000)]), form = new FormData(); form.set("file", new File([file], "large.png", { type: "image/png" }));
  const uploaded = await app.request(url, { method: "POST", headers: { ...headers, "X-Invoice-Event-Id": hash(file) }, body: form });
  assert.equal(uploaded.status, 200); assert.equal((await uploaded.json()).event.status, "received");
  assert.equal((await app.request(url, { method: "POST", headers, body: "x".repeat(3 * 1024 * 1024 + 65537) })).status, 413);
  assert.equal((await app.request(`http://localhost:3000/api/organizations/${owner.access.organizationId}/documents`, { headers })).status, 401);
  const tg = telegram(owner.access);
  assert.equal((await app.request(`http://localhost:3000/api/invoice-ingress/${tg.channel.id}/telegram`, { method: "POST", body: "x".repeat(200_000) })).status, 401);
  assert.equal((await app.request(`http://localhost:3000/api/invoice-ingress/${tg.channel.id}/telegram`, { method: "POST", headers: { "X-Telegram-Bot-Api-Secret-Token": tg.setup.webhookSecret! }, body: "x".repeat(128 * 1024 + 1) })).status, 413);
  revokeInvoiceChannel(owner.access, connection.channel.id);
  assert.equal((await app.request(url, { method: "POST", headers, body: "x".repeat(2_000_000) })).status, 401);
});

test("browser, channel and worker paths share a bounded ingress pool released after failure", async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const first = withDocumentIngress(async () => { await gate; throw new Error("Mock disconnected upload"); });
  const second = withDocumentIngress(async () => { await gate; });
  await assert.rejects(withDocumentIngress(async () => true), error => error instanceof ApiError && error.status === 429);
  release(); await assert.rejects(first, /disconnected/); await second;
  assert.equal(await withDocumentIngress(async () => "recovered"), "recovered");
});

test("retention deletes encrypted event metadata and blocks provider retries after expiry", async () => {
  const { access } = fixture(), connection = telegram(access), saved = receiveTelegram(connection.channel.id, connection.setup.webhookSecret!, update());
  getDb().prepare("UPDATE invoice_channel_events SET expires_at='2000-01-01T00:00:00Z' WHERE id=?").run(saved.event!.id);
  purgeInvoiceChannelRetention();
  const event = listInvoiceChannels(access).events[0]; assert.equal(event.status, "expired"); assert.equal(event.source, null);
  assert.throws(() => retryInvoiceEvent(access, event.id), /unavailable/);
  assert.equal((await processPendingInvoiceEvents({ organizationId: access.organizationId, transport: async () => { throw new Error("Expired source must not download"); } })).processed, 0);
});

test("folder scanner requires explicit access, excludes symlinks, recursion, oversized files and hard links", async () => {
  const root = await mkdtemp(join(tmpdir(), "razor-channel-test-")), folder = join(root, "invoices"); await mkdir(folder);
  try {
    await writeFile(join(folder, "invoice.png"), png); await writeFile(join(root, "outside.png"), png); await link(join(root, "outside.png"), join(folder, "hardlink.png"));
    await symlink(join(root, "outside.png"), join(folder, "escaped.png")); await mkdir(join(folder, "nested")); await writeFile(join(folder, "nested", "hidden.png"), png);
    await writeFile(join(folder, "oversized.png"), Buffer.alloc(3 * 1024 * 1024 + 1));
    await assert.rejects(readAllowedInvoiceFolder(folder, "", async () => {}), /Explicit permission/);
    await symlink(folder, join(root, "alias")); await assert.rejects(readAllowedInvoiceFolder(join(root, "alias"), join(root, "alias"), async () => {}), /symlinks/);
    const received: string[] = []; await readAllowedInvoiceFolder(folder, folder, async file => { received.push(file.filename); assert.deepEqual(file.bytes, png); assert.equal(file.hash, hash(png)); });
    assert.deepEqual(received, ["invoice.png"]); assert.deepEqual(await readFile(join(folder, "invoice.png")), png);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("company-operated folder CLI uses durable status, bounded multipart and authenticated revocation", async () => {
  const root = await mkdtemp(join(tmpdir(), "razor-cli-test-")), owner = fixture(), channel = createInvoiceChannel(owner.access, { provider: "folder", label: "CLI", privacyAcknowledged: true });
  const previous = process.env.RAZOR_INVOICE_FOLDER_TOKEN; process.env.RAZOR_INVOICE_FOLDER_TOKEN = channel.setup.credential!;
  const endpoint = `http://localhost:3000/api/invoice-ingress/${channel.channel.id}/upload`, args = [`--folder=${root}`, `--allow-read-folder=${root}`, `--endpoint=${endpoint}`, "--once"];
  let uploads = 0;
  const transport: typeof fetch = async (url, init) => { assert.equal(init?.redirect, "error"); if (init?.method === "POST") uploads++; return app.request(String(url), init); };
  try {
    await writeFile(join(root, "invoice.png"), png);
    await watchInvoiceFolder(args, transport); await watchInvoiceFolder(args, transport);
    assert.equal(uploads, 1); assert.equal(listDocuments(owner.access).total, 1);
    revokeInvoiceChannel(owner.access, channel.channel.id);
    await assert.rejects(watchInvoiceFolder(args, transport), /revoked/);
  } finally { if (previous === undefined) delete process.env.RAZOR_INVOICE_FOLDER_TOKEN; else process.env.RAZOR_INVOICE_FOLDER_TOKEN = previous; await rm(root, { recursive: true, force: true }); }
});


test("genuine provider housekeeping callbacks acknowledge without claiming invoice delivery", () => {
  const { access } = fixture(), tg = telegram(access), meta = whatsapp(access);
  assert.equal("ignored" in receiveTelegram(tg.channel.id, tg.setup.webhookSecret!, { update_id: 100, edited_message: { text: "Ignored update" } }), true);
  const raw = Buffer.from(JSON.stringify({ object: "whatsapp_business_account", entry: [{ id: "987654", changes: [{ field: "messages", value: { metadata: { phone_number_id: meta.channel.config.phoneNumberId }, statuses: [{ id: "status-only" }] } }] }] }));
  assert.deepEqual(receiveWhatsApp(meta.channel.id, signature(raw), raw), { events: [] });
  assert.equal(listInvoiceChannels(access).events.length, 0);
  assert.ok(listInvoiceChannels(access).channels.every(channel => channel.status === "awaiting_verified_input"));
});

test("actual request stream bytes override forged Content-Length and always cancel the reader", async () => {
  let canceled = false;
  const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(20)); }, cancel() { canceled = true; } });
  const request = new Request("https://razor.invalid/upload", { method: "POST", body, headers: { "Content-Length": "1" }, duplex: "half" } as RequestInit);
  await assert.rejects(boundedInvoiceRequest(request, 16), error => error instanceof ApiError && error.status === 413);
  assert.equal(canceled, true);
  const normal = await boundedInvoiceRequest(new Request("https://razor.invalid/upload", { method: "POST", body: "bounded" }), 16);
  assert.equal(await normal.text(), "bounded"); assert.equal(normal.headers.get("content-length"), "7");
});

test("timed-out upload readers cancel and release their slot for the next file", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let canceled = false;
  const body = new ReadableStream<Uint8Array>({ cancel() { canceled = true; } });
  const request = new Request("https://razor.invalid/upload", { method: "POST", body, duplex: "half" } as RequestInit);
  const pending = withDocumentIngress(() => boundedInvoiceRequest(request, 16));
  t.mock.timers.tick(25001);
  await assert.rejects(pending, error => error instanceof ApiError && error.status === 408);
  assert.equal(canceled, true);
  assert.equal(await withDocumentIngress(async () => "next"), "next");
});

test("folder scanning stops at the advertised entry cap", async () => {
  const root = await mkdtemp(join(tmpdir(), "razor-folder-cap-"));
  try {
    await Promise.all(Array.from({ length: 102 }, (_, index) => writeFile(join(root, `${index}.txt`), "ignored")));
    let files = 0; const scan = await readAllowedInvoiceFolder(root, root, async () => { files++; });
    assert.equal(scan.scanned, 100); assert.equal(scan.capped, true); assert.equal(files, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});
