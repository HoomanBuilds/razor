import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { link, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { Hono } from "hono";
import { COMPANY_REVIEW_MAX_BYTES, parseCompanyReview } from "../src/lib/company-private/schema";
import { readCompanyInvoice } from "../src/server/company-private/processor";
import { writePrivateJson } from "../src/server/company-private/command";
import { importCompanyInvoice, reviewedCompanyInvoiceInput } from "../src/server/company-private/service";
import { companyPrivateRoutes } from "../src/server/company-private";
import { ApiError, type AppEnv } from "../src/server/context";
import { getDb, row } from "../src/server/db";
import { encrypt } from "../src/server/identity/crypto";
import { getAccess } from "../src/server/identity/session";
import { verifyPacket } from "../src/lib/verification/verify";

process.env.DATABASE_PATH = ":memory:";
process.env.DATA_ENCRYPTION_KEY = "b9".repeat(32);
const permissions = ["company:read", "payments:read", "payments:prepare", "documents:manage"];
const hasCode = (code: string) => (error: unknown) => error instanceof ApiError && error.code === code;

function fixture() {
  const id = randomUUID(), role = randomUUID(), recipientId = randomUUID(), at = new Date().toISOString(), db = getDb();
  db.prepare("INSERT INTO users(id,name,created_at) VALUES(?,?,?)").run(id, "Company private reviewer", at);
  db.prepare("INSERT INTO organizations(id,name,owner_id,created_at,updated_at) VALUES(?,?,?,?,?)").run(id, "Company-operated finance", id, at, at);
  db.prepare("INSERT INTO organization_roles(id,organization_id,name,permissions_json,is_owner,created_at) VALUES(?,?,?,?,1,?)").run(role, id, "Owner", JSON.stringify(permissions), at);
  db.prepare("INSERT INTO memberships(organization_id,user_id,role_id,status,created_at) VALUES(?,?,?,'active',?)").run(id, id, role, at);
  db.prepare("INSERT INTO recipients(id,organization_id,user_id,name,kind,primary_asset,primary_network,primary_address,preference_status,confirmed_at,created_at,updated_at) VALUES(?,?,?,?,'business','USDC','near','supplier.near','confirmed',?,?,?)").run(recipientId, id, id, encrypt("Confirmed supplier"), at, at, at);
  return { access: getAccess(id, id), role, recipientId };
}
function input(f: ReturnType<typeof fixture>, source = "ab".repeat(32)) {
  return { sourceSha256: source, sourceKind: "text" as const, recipientId: f.recipientId, reference: `INV-${randomUUID()}`, title: "Human-reviewed company invoice", agreedUSDC: "27.125001", maxFeeUSDC: "0.25", dueDate: "2027-01-15", reviewConfirmed: true as const };
}

test("company review files are strict bounded local artifacts, not a credential or raw-source transport", () => {
  const value = { schema: "razor.company-private.invoice", version: 1, processedAt: new Date().toISOString(), source: { sha256: "ab".repeat(32), kind: "text", bytes: 200 }, draft: { supplier: "Supplier", reference: "INV-1", amount: "30", amountPrinted: "30 EUR", currency: "EUR", dueDate: null, subtotal: null, tax: null, withholding: null, deposit: null, lineItems: [], paymentDetails: null, warnings: ["Agree USDC explicitly"], confidence: 0.8 }, processing: { mode: "company_operated", provider: "NEAR AI Cloud", model: "fixture-model", reportedVerifiedAt: new Date().toISOString(), reportedGatewayComposeSha256: "11".repeat(32), reportedModelComposeSha256: ["22".repeat(32)], reportedRequestWireHash: "33".repeat(32), reportedResponseWireHash: "44".repeat(32) } };
  assert.equal(parseCompanyReview(JSON.stringify(value)).draft.currency, "EUR");
  for (const extra of [{ apiKey: "never-import-this" }, { rawText: "private document" }, { signed: true }, { packet: {} }]) assert.throws(() => parseCompanyReview(JSON.stringify({ ...value, ...extra })));
  assert.throws(() => parseCompanyReview(JSON.stringify({ ...value, version: 2 })));
  assert.throws(() => parseCompanyReview(" ".repeat(COMPANY_REVIEW_MAX_BYTES + 1)));
  assert.throws(() => parseCompanyReview(JSON.stringify({ ...value, draft: { ...value.draft, amount: "1e3" } })));
});

test("local invoice reads are bounded, descriptor-based and refuse links, binary text and unsupported media", async () => {
  const directory = await mkdtemp(join(tmpdir(), "razor-company-input-"));
  try {
    const path = join(directory, "invoice.txt"); await writeFile(path, "Private invoice INV-1 total 20 EUR");
    const file = await readCompanyInvoice(path);
    assert.equal(file.source.kind, "text"); assert.equal(file.text, "Private invoice INV-1 total 20 EUR"); assert.equal(file.source.sha256.length, 64);
    await symlink(path, join(directory, "linked.txt")); await assert.rejects(readCompanyInvoice(join(directory, "linked.txt")), hasCode("COMPANY_INPUT_INVALID"));
    await link(path, join(directory, "hard.txt")); await assert.rejects(readCompanyInvoice(path), hasCode("COMPANY_INPUT_INVALID"));
    await writeFile(join(directory, "binary.txt"), Buffer.from([0, 255, 254])); await assert.rejects(readCompanyInvoice(join(directory, "binary.txt")));
    await writeFile(join(directory, "large.txt"), "x".repeat(20_001)); await assert.rejects(readCompanyInvoice(join(directory, "large.txt")), hasCode("COMPANY_TEXT_INVALID"));
    await writeFile(join(directory, "oversized.pdf"), Buffer.alloc(3 * 1024 * 1024 + 1)); await assert.rejects(readCompanyInvoice(join(directory, "oversized.pdf")), hasCode("COMPANY_INPUT_INVALID"));
    await writeFile(join(directory, "fake.pdf"), "not a PDF"); await assert.rejects(readCompanyInvoice(join(directory, "fake.pdf")), hasCode("DOCUMENT_TYPE_UNSUPPORTED"));
    await assert.rejects(readCompanyInvoice("https://not-a-local-file.example/invoice"), hasCode("COMPANY_INPUT_PATH_INVALID"));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("private JSON output is atomic, mode0600, bounded and never clobbers an existing file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "razor-company-output-"));
  try {
    const path = join(directory, "review.json");
    await writePrivateJson(path, { reviewed: true }, 1024);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    await assert.rejects(writePrivateJson(path, { overwritten: true }, 1024));
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { reviewed: true });
    await assert.rejects(writePrivateJson(join(directory, "too-large.json"), { text: "x".repeat(100) }, 10), hasCode("COMPANY_OUTPUT_TOO_LARGE"));
    assert.deepEqual(await readdir(directory), ["review.json"]);
    const blocked = spawnSync(process.execPath, ["--max-old-space-size=512", "--import", "tsx", "scripts/process-invoice-private.ts", "--input", join(directory, "invoice.txt"), "--output", path], { cwd: process.cwd(), env: { ...process.env, NODE_OPTIONS: "", NEAR_AI_API_KEY: "", NEAR_AI_MODEL: "" }, encoding: "utf8", timeout: 30_000 });
    assert.equal(blocked.status, 1);
    assert.match(blocked.stderr, /existing files are never overwritten/);
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { reviewed: true });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("only reviewed fields create an exact unapproved company bill; retries and document identities stay bound", () => {
  const f = fixture(), terms = input(f);
  const created = importCompanyInvoice(f.access, terms);
  assert.equal(created.created, true); assert.equal(importCompanyInvoice(f.access, terms).billId, created.billId);
  const bill = row<{ amount: string; max_fee: string; status: string; document_hash: string; due_date: string; payment_id: string }>("SELECT * FROM bills WHERE id=?", created.billId)!;
  assert.equal(bill.amount, "27125001"); assert.equal(bill.max_fee, "250000"); assert.equal(bill.status, "draft"); assert.equal(bill.document_hash, terms.sourceSha256); assert.equal(bill.due_date, "2027-01-15T00:00:00.000Z");
  assert.equal(row<{ status: string }>("SELECT status FROM payments WHERE id=?", bill.payment_id)!.status, "draft");
  assert.throws(() => importCompanyInvoice(f.access, { ...terms, agreedUSDC: "28" }), hasCode("DUPLICATE_INVOICE"));
  assert.throws(() => importCompanyInvoice(f.access, { ...terms, reference: "ANOTHER-REF" }), hasCode("DUPLICATE_DOCUMENT"));
  assert.equal(row<{ count: number }>("SELECT COUNT(*) count FROM assistant_drafts WHERE organization_id=?", f.access.organizationId)!.count, 0);
  assert.equal(row<{ count: number }>("SELECT COUNT(*) count FROM billing_usage WHERE organization_id=?", f.access.organizationId)!.count, 0);
  for (const extra of [{ apiKey: "private-key" }, { rawText: "do not send" }, { draft: {} }, { paymentDetails: { address: "attacker.near" } }, { verification: { ok: true } }, { amount: "999999999" }]) assert.equal(reviewedCompanyInvoiceInput.safeParse({ ...terms, ...extra }).success, false);
  for (const value of ["1e3", "1.0000001", "-1", "NaN", "", "9".repeat(1000)]) assert.equal(reviewedCompanyInvoiceInput.safeParse({ ...terms, agreedUSDC: value }).success, false);
  assert.equal(reviewedCompanyInvoiceInput.safeParse({ ...terms, reviewConfirmed: false }).success, false);
  assert.equal(row<{ count: number }>("SELECT COUNT(*) count FROM bills WHERE organization_id=?", f.access.organizationId)!.count, 1);
});

test("imports use current company permissions and confirmed recipient ownership without sending another provider request", async () => {
  const f = fixture(), other = fixture(), original = globalThis.fetch; let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error("No hosted inference or payment call may run"); };
  try {
    assert.throws(() => importCompanyInvoice(f.access, { ...input(f), recipientId: other.recipientId }), hasCode("RECIPIENT_NOT_FOUND"));
    getDb().prepare("UPDATE recipients SET preference_status='pending_confirmation' WHERE id=?").run(f.recipientId);
    assert.throws(() => importCompanyInvoice(f.access, input(f)), hasCode("RECIPIENT_CONFIRMATION_REQUIRED"));
    getDb().prepare("UPDATE recipients SET preference_status='confirmed' WHERE id=?").run(f.recipientId);
    const app = new Hono<AppEnv>(); app.use("*", async (c, next) => { c.set("access", f.access); await next(); }); app.route("/", companyPrivateRoutes);
    assert.equal((await app.request("http://localhost/reviewed-invoices", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input(f)) })).status, 201);
    getDb().prepare("UPDATE organization_roles SET permissions_json=? WHERE id=?").run(JSON.stringify(permissions.filter(value => value !== "documents:manage")), f.role);
    assert.throws(() => importCompanyInvoice(f.access, input(f)), hasCode("FORBIDDEN"));
    assert.equal(calls, 0);
  } finally { globalThis.fetch = original; }
});

const sdkFixture = (auditPath: string) => `
import { appendFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { InferenceClient, prepareE2eeChatRequest } from ${JSON.stringify(pathToFileURL(resolve("node_modules/@nearai/inference-sdk/dist/node.js")).href)};
import { ed25519 } from ${JSON.stringify(pathToFileURL(resolve("node_modules/@noble/curves/ed25519.js")).href)};
const hash=value=>createHash('sha256').update(value).digest('hex'), secret=new Uint8Array(32).fill(7);
const signer={signingAlgo:'ed25519',signingAddress:Buffer.from(ed25519.getPublicKey(secret)).toString('hex')};
const compose='fixture-reviewed-compose', report={nonce:'11'.repeat(32),signer,intelQuote:'fixture-not-hardware-evidence',eventLog:'[]',appCompose:compose};
const attestation={gpuEvidence:'verified',signingPublicKey:signer.signingAddress,report,signer,deployment:{appCompose:compose},tcbStatus:'UpToDate'};
const draft={supplier:'Fixture supplier',reference:'LOCAL-INV-1',amount:'30',amountPrinted:'30 EUR',currency:'EUR',dueDate:null,subtotal:null,tax:null,withholding:null,deposit:null,lineItems:[],paymentDetails:{network:'near',asset:'USDC',address:'untrusted.near'},warnings:[],confidence:0.8};
const responseBody=new TextEncoder().encode(JSON.stringify({id:'fixture-completion',choices:[{message:{content:'encrypted:fixture-output'}}]}));
globalThis.fetch=async(value,init)=>{const request=value instanceof Request?value:new Request(value,init),body=await request.clone().text();appendFileSync(${JSON.stringify(auditPath)},JSON.stringify({url:request.url,rawIncluded:body.includes('TOP_SECRET_COMPANY_INVOICE'),keyIncluded:body.includes(process.env.NEAR_AI_API_KEY)})+'\\n');if(new URL(request.url).origin!=='https://cloud-api.near.ai')throw new Error('Unexpected transport');return new Response(responseBody,{headers:{'content-type':'application/json'}})};
InferenceClient.prototype.verify=async function(){
  if(process.env.COMPANY_FIXTURE_FAIL)throw new Error(process.env.NEAR_AI_API_KEY);
  this.chat={completions:{create:async request=>{
    const prepared=await prepareE2eeChatRequest({request:new Request('https://cloud-api.near.ai/v1/chat/completions',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+process.env.NEAR_AI_API_KEY},body:JSON.stringify(request)}),modelKey:{signingAlgo:'ed25519',publicKey:signer.signingAddress}});
    const requestBody=new Uint8Array(await prepared.request.clone().arrayBuffer());await fetch(prepared.request);
    const signedText=request.model+':'+hash(requestBody)+':'+hash(responseBody);
    const signature={kind:'provider_tee',signer,signedText,signature:Buffer.from(ed25519.sign(new TextEncoder().encode(signedText),secret)).toString('hex')};
    this.fixtureReceipt={id:'fixture-completion',signatureKind:'provider_tee',signature,attestations:[attestation]};
    this.registerResponse({id:'fixture-completion',requestBody,responseBody:Promise.resolve(responseBody),session:{attestationResult:undefined,transport:{fetch,fetchCompletionSignature:async()=>signature},verifyResponse:async()=>this.fixtureReceipt}},this.responseCacheGeneration);
    return{id:'fixture-completion',choices:[{message:{content:JSON.stringify(draft)},finish_reason:'stop'}]};
  }}};
  return{verifiedAt:Date.now(),gateway:{tlsBinding:{kind:'attested'},deployment:{appCompose:compose},tcbStatus:'UpToDate',report},models:[attestation]};
};
InferenceClient.prototype.verifyResponse=async function(){return this.fixtureReceipt};
`;

test("actual company CLI with an SDK fixture sends encrypted data only to NEAR AI and produces private local files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "razor-company-cli-")), key = "fixture-secret-never-exported";
  try {
    const inputPath = join(directory, "invoice.txt"), output = join(directory, "review.json"), packet = join(directory, "packet.json"), audit = join(directory, "transport.log"), preload = join(directory, "sdk-fixture.mjs");
    await writeFile(inputPath, "TOP_SECRET_COMPANY_INVOICE LOCAL-INV-1 total 30 EUR"); await writeFile(preload, sdkFixture(audit));
    const composeHash = await import("node:crypto").then(module => module.createHash("sha256").update("fixture-reviewed-compose").digest("hex"));
    const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: "production", DATA_ENCRYPTION_KEY: "", NEAR_AI_API_KEY: key, NEAR_AI_MODEL: "fixture/private-model", NEAR_AI_MODEL_COMPOSE_SHA256: composeHash, NEAR_AI_GATEWAY_COMPOSE_SHA256: composeHash, NEAR_AI_RETENTION_DAYS: "30" };
    const result = spawnSync(process.execPath, ["--max-old-space-size=512", "--import", pathToFileURL(preload).href, "--import", "tsx", "scripts/process-invoice-private.ts", "--input", inputPath, "--output", output, "--packet", packet], { cwd: process.cwd(), env, encoding: "utf8", timeout: 30_000 });
    assert.equal(result.status, 0, result.stderr); assert.ok(result.stdout.includes("No source, key or draft was sent to Razor"));
    const local = parseCompanyReview(await readFile(output, "utf8")), packetText = await readFile(packet, "utf8");
    assert.equal(local.draft.currency, "EUR"); assert.equal(local.draft.amount, "30");
    assert.equal((await stat(output)).mode & 0o777, 0o600); assert.equal((await stat(packet)).mode & 0o777, 0o600);
    for (const outputText of [await readFile(output, "utf8"), packetText, result.stdout, result.stderr]) { assert.ok(!outputText.includes(key)); assert.ok(!outputText.includes("TOP_SECRET_COMPANY_INVOICE")); }
    const calls = (await readFile(audit, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    assert.equal(calls.length, 1); assert.equal(calls[0].url, "https://cloud-api.near.ai/v1/chat/completions"); assert.equal(calls[0].rawIncluded, false); assert.equal(calls[0].keyIncluded, false);
    const claims = await verifyPacket(JSON.parse(packetText));
    assert.equal(claims.find(value => value.claim === "model_signature_and_wire_binding")!.status, "passed");
    assert.equal(claims.find(value => value.claim === "hardware_attestation")!.status, "not_checked");
    const failedOutput = join(directory, "failed.json");
    const failure = spawnSync(process.execPath, ["--max-old-space-size=512", "--import", pathToFileURL(preload).href, "--import", "tsx", "scripts/process-invoice-private.ts", "--input", inputPath, "--output", failedOutput], { cwd: process.cwd(), env: { ...env, COMPANY_FIXTURE_FAIL: "1" }, encoding: "utf8", timeout: 30_000 });
    assert.equal(failure.status, 1); assert.ok(!failure.stderr.includes(key)); await assert.rejects(stat(failedOutput));
    assert.equal((await readFile(audit, "utf8")).trim().split("\n").length, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("the real CLI fails closed with missing verification settings without hosted fallback or exported credentials", async () => {
  const directory = await mkdtemp(join(tmpdir(), "razor-company-unavailable-"));
  try {
    const inputPath = join(directory, "invoice.txt"), output = join(directory, "review.json"); await writeFile(inputPath, "Private invoice 40 USDC");
    const result = spawnSync(process.execPath, ["--max-old-space-size=512", "--import", "tsx", "scripts/process-invoice-private.ts", "--input", inputPath, "--output", output], { cwd: process.cwd(), env: { ...process.env, NEAR_AI_API_KEY: "", NEAR_AI_MODEL: "", DATA_ENCRYPTION_KEY: "", NODE_ENV: "production" }, encoding: "utf8", timeout: 30_000 });
    assert.equal(result.status, 1); assert.ok(result.stderr.includes("NEAR_AI_API_KEY")); assert.ok(!result.stderr.includes("DATA_ENCRYPTION_KEY")); await assert.rejects(stat(output));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
