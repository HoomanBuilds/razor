import assert from "node:assert/strict";
import test from "node:test";
import { ed25519 } from "@noble/curves/ed25519.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { privateKeyToAccount } from "viem/accounts";
import { createAnalysisPacket } from "../src/server/assistant/packet";
import { encodeBase64, hashBytes, hashText, verifyPacket } from "../src/lib/verification/verify";
import { parsePacket, portablePacketSchema, type ChainReference, type PortablePacket, type VerifierTrust } from "../src/lib/verification/packet";
import { historicalNearLookup } from "../src/lib/verification/near-history";
import { EvidenceInferenceClient } from "../src/server/assistant/capture";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const secret = new Uint8Array(32).fill(7), signer = { signingAlgo: "ed25519" as const, signingAddress: bytesToHex(ed25519.getPublicKey(secret)) };
const requestBody = new TextEncoder().encode(JSON.stringify({ model: "fixture/private-model", messages: [{ role: "user", content: "encrypted:fixture-ciphertext" }] }));
const responseBody = new TextEncoder().encode(JSON.stringify({ id: "fixture-completion", choices: [{ message: { content: "encrypted:fixture-output" } }] }));
const signedText = `fixture/private-model:${hashBytes(requestBody)}:${hashBytes(responseBody)}`;
const signature = { kind: "provider_tee" as const, signer, signedText, signature: bytesToHex(ed25519.sign(new TextEncoder().encode(signedText), secret)) };
const report = { nonce: "11".repeat(32), signer, intelQuote: "fixture-not-hardware-evidence", eventLog: "[]", appCompose: "fixture-reviewed-compose" };
function evidence() {
  return { verification: { model: "fixture/private-model", ok: true, gpuEvidenceVerified: true }, deployment: { verifiedAt: Date.parse("2026-11-01T00:00:00.000Z"), gateway: { report } }, receipt: { id: "fixture-completion", signature, attestations: [{ report, gpuEvidence: "verified" }] }, wire: { request: { sha256: hashBytes(requestBody), base64: encodeBase64(requestBody) }, response: { sha256: hashBytes(responseBody), base64: encodeBase64(responseBody) } }, inputSha256: hashText("private plaintext"), responseSha256: hashText("private output"), decryptionKey: "never-export-this", input: "private payroll" };
}
const packet = () => createAnalysisPacket({ id: "fixture-analysis", kind: "invoice_analysis", evidence: evidence() }, "encrypted_wire");
const claim = async (value: PortablePacket, name: string, trust?: VerifierTrust) => (await verifyPacket(value, { trust })).find(item => item.claim === name)!;
const trust = (): VerifierTrust => ({ schema: "razor.verifier-trust", version: 1, expectedSigner: signer, expectedModel: "fixture/private-model", approvedGatewayComposeSha256: [hashText(report.appCompose)], approvedModelComposeSha256: [hashText(report.appCompose)] });

test("valid real fixture signatures verify encrypted wire bytes without trusting hardware booleans", async () => {
  const result = await verifyPacket(parsePacket(JSON.stringify(packet())), { trust: trust() });
  for (const name of ["request_bytes", "response_bytes", "model_signature_and_wire_binding", "expected_signer", "expected_model", "gateway_reported_deployment", "model_reported_deployment"]) assert.equal(result.find(item => item.claim === name)?.status, "passed", name);
  for (const name of ["hardware_attestation", "attestation_freshness_at_execution", "decrypted_plaintext_binding", "settlement"]) assert.equal(result.find(item => item.claim === name)?.status, "not_checked", name);
  for (const name of ["provider_reported_delivery", "operator_attestation"]) assert.equal(result.find(item => item.claim === name)?.status, "unavailable", name);
  assert.equal(result.find(item => item.claim === "historical_chain_context")?.status, "unavailable");
});

test("tampered request, response, signature, signer, model and completion ID fail verification", async () => {
  for (const mutate of [
    (value: PortablePacket) => { value.inference!.request!.base64 = encodeBase64(new TextEncoder().encode('{"model":"other"}')); },
    (value: PortablePacket) => { value.inference!.response!.base64 = encodeBase64(new TextEncoder().encode('{"id":"other-completion"}')); },
    (value: PortablePacket) => { value.inference!.signature!.signature = "00".repeat(64); },
    (value: PortablePacket) => { value.inference!.signature!.signer.signingAddress = "00".repeat(32); },
    (value: PortablePacket) => { value.inference!.model = "other-model"; },
    (value: PortablePacket) => { value.inference!.completionId = "other-completion"; },
  ]) {
    const value = packet(); mutate(value);
    assert.equal((await claim(value, "model_signature_and_wire_binding")).status, "failed");
  }
});

test("reviewed external signer and compose inputs reject substitution; packet allowlists cannot establish trust", async () => {
  assert.equal((await claim(packet(), "expected_signer", { ...trust(), expectedSigner: { signingAlgo: "ed25519", signingAddress: "00".repeat(32) } })).status, "failed");
  assert.equal((await claim(packet(), "model_reported_deployment", { ...trust(), approvedModelComposeSha256: ["00".repeat(32)] })).status, "failed");
  assert.equal((await claim(packet(), "model_reported_deployment")).status, "not_checked");
  assert.throws(() => portablePacketSchema.parse({ ...packet(), approvedModelComposeSha256: [hashText(report.appCompose)] }));
});

test("metadata redaction and missing historical wire bytes are unavailable, never reconstructed from plaintext hashes", async () => {
  const redacted = createAnalysisPacket({ id: "fixture", kind: "invoice_analysis", evidence: evidence() }, "metadata");
  assert.equal(redacted.inference!.request!.base64, null);
  assert.equal((await claim(redacted, "model_signature_and_wire_binding")).status, "unavailable");
  const legacy = evidence() as Record<string, unknown>; delete legacy.wire;
  const historical = createAnalysisPacket({ id: "legacy", kind: "invoice_analysis", evidence: legacy }, "encrypted_wire");
  assert.equal(historical.inference!.request, null);
  assert.equal((await claim(historical, "request_bytes")).status, "unavailable");
  const exported = JSON.stringify(redacted);
  for (const privateValue of ["private plaintext", "private output", "private payroll", "never-export-this", '"decryptionKey"', "gpuEvidenceVerified"]) assert.equal(exported.includes(privateValue), false, privateValue);
});

test("unsupported packet versions and malformed wire bytes fail closed", () => {
  assert.throws(() => parsePacket(JSON.stringify({ ...packet(), version: 2 })));
  const value = packet(); value.inference!.request!.base64 = "***";
  assert.throws(() => parsePacket(JSON.stringify(value)));
});

test("ECDSA fixture signatures use the official SDK signature verification semantics", async () => {
  const account = privateKeyToAccount(`0x${"08".repeat(32)}`), value = packet();
  value.inference!.signature!.signer = { signingAlgo: "ecdsa", signingAddress: account.address };
  value.inference!.signature!.signature = await account.signMessage({ message: signedText });
  value.inference!.modelReports[0].signer = value.inference!.signature!.signer;
  assert.equal((await claim(value, "model_signature_and_wire_binding")).status, "passed");
});

test("protected SDK capture hook copies actual wire bytes and clears retained capture with the response cache", async () => {
  class FixtureClient extends EvidenceInferenceClient {
    registerFixture(request: Uint8Array, response: Uint8Array) {
      super.registerResponse({ id: "captured", requestBody: request, responseBody: Promise.resolve(response), session: { attestationResult: undefined, transport: { fetch, fetchCompletionSignature: async () => signature }, verifyResponse: async () => { throw new Error("Not used in capture fixture"); } } }, this.responseCacheGeneration);
    }
  }
  const client = new FixtureClient({ apiKey: "fixture-key-not-sent", e2ee: true }), request = requestBody.slice(), response = responseBody.slice();
  client.registerFixture(request, response); request.fill(0);
  const captured = await client.capturedWire("captured"); response.fill(0);
  assert.deepEqual(captured.requestBody, requestBody); assert.deepEqual(captured.responseBody, responseBody);
  client.clearResponseCache();
  await assert.rejects(client.capturedWire("captured"));
});

const chain = (): ChainReference => ({ network: "testnet", architecture: "shared_v1", companyId: "fixture-company", contractId: "treasury.testnet", blockHash: "1".repeat(44), blockHeight: 42, codeHash: "2".repeat(44), transactionHash: "3".repeat(44), signerId: "owner.testnet", paymentId: "fixture-payment", amount: "5000000", recipientId: "fixture-recipient", recipientVersion: "3", policyVersion: "2" });
function rpcFixture(ref: ChainReference, edits: { network?: string; paymentId?: string; codeHash?: string; amount?: string; recipientVersion?: string; unavailable?: boolean } = {}) {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const transport: typeof fetch = async (_url, options) => {
    const body = JSON.parse(options!.body as string); calls.push(body);
    if (edits.unavailable && body.method === "query") return Response.json({ error: { message: "Historical data pruned" } });
    let result: unknown;
    if (body.method === "status") result = { chain_id: edits.network || ref.network };
    else if (body.method === "block") result = { header: { hash: ref.blockHash, height: ref.blockHeight } };
    else if (body.method === "query" && body.params.request_type === "view_account") result = { code_hash: edits.codeHash || ref.codeHash, block_hash: ref.blockHash, block_height: ref.blockHeight };
    else if (body.method === "query") result = { result: [...new TextEncoder().encode(JSON.stringify({ id: edits.paymentId || ref.paymentId, amount: edits.amount || ref.amount, recipient_id: ref.recipientId, recipient_version: edits.recipientVersion || ref.recipientVersion, policy_version: ref.policyVersion }))], block_hash: ref.blockHash, block_height: ref.blockHeight };
    else result = { final_execution_status: "FINAL", status: { SuccessValue: "" }, transaction: { hash: ref.transactionHash, signer_id: ref.signerId, receiver_id: ref.contractId, actions: [{ FunctionCall: { method_name: "execute_payment", args: encodeBase64(new TextEncoder().encode(JSON.stringify({ payment_id: edits.paymentId || ref.paymentId, company_id: ref.companyId }))) } }] }, receipts_outcome: [{ block_hash: ref.blockHash, outcome: { executor_id: ref.contractId, status: { SuccessValue: "" } } }] };
    return Response.json({ result });
  };
  return { calls, lookup: historicalNearLookup("https://fixture.invalid", transport) };
}

test("historical execution checks code and frozen terms at the execution block, with no current-state queries", async () => {
  const value = packet(), ref = chain(); value.chain = ref; value.network = ref.network;
  const { calls, lookup } = rpcFixture(ref), claims = await verifyPacket(value, { lookupHistory: lookup });
  assert.equal(claims.find(item => item.claim === "historical_chain_context")?.status, "passed");
  assert.equal(claims.find(item => item.claim === "final_transaction_binding")?.status, "passed");
  for (const call of calls.filter(item => ["query", "block"].includes(item.method))) { assert.equal(call.params.block_id, ref.blockHash); assert.equal(call.params.finality, undefined); }
});

test("wrong chain, deployment, payment, recipient version and amount are rejected against historical observations", async () => {
  for (const edits of [{ network: "mainnet" }, { codeHash: "9".repeat(44) }, { paymentId: "another-payment" }, { amount: "9000000" }, { recipientVersion: "4" }]) {
    const value = packet(), ref = chain(); value.chain = ref; value.network = ref.network;
    const claims = await verifyPacket(value, { lookupHistory: rpcFixture(ref, edits).lookup });
    assert.equal(claims.find(item => item.claim === "historical_chain_context")?.status, "failed");
  }
});

test("missing history stays unavailable; offline history stays not checked; expected financial terms fail substitution", async () => {
  const value = packet(), ref = chain(); value.chain = ref; value.network = ref.network;
  assert.equal((await verifyPacket(value, { lookupHistory: rpcFixture(ref, { unavailable: true }).lookup })).find(item => item.claim === "historical_chain_context")?.status, "unavailable");
  assert.equal((await claim(value, "historical_chain_context")).status, "not_checked");
  const { blockHash, blockHeight, transactionHash, signerId, ...expectedChain } = ref;
  assert.equal((await claim(value, "expected_financial_context", { ...trust(), expectedChain: { ...expectedChain, amount: "1" } })).status, "failed");
  assert.equal((await claim(value, "expected_financial_context", { ...trust(), expectedChain: { ...expectedChain, companyId: "another-company" } })).status, "failed");
  value.subject = { kind: "payment_evidence", id: "another-payment" };
  assert.equal((await claim(value, "payment_subject_binding")).status, "failed");
});

test("standalone local CLI needs no company or AI credentials and distinguishes failure from incomplete proof", async () => {
  const directory = await mkdtemp(join(tmpdir(), "razor-verifier-fixture-")), file = join(directory, "packet.json");
  const run = () => spawnSync(process.execPath, ["--max-old-space-size=512", "--import", "tsx", "scripts/verify-evidence.ts", file], { cwd: process.cwd(), encoding: "utf8", env: { ...process.env, NEAR_AI_API_KEY: "", DATA_ENCRYPTION_KEY: "", DATABASE_PATH: "/nonexistent/no-database-needed" }, timeout: 30_000 });
  try {
    await writeFile(file, JSON.stringify(packet()));
    const valid = run(); assert.equal(valid.status, 2, valid.stderr);
    const result = JSON.parse(valid.stdout); assert.equal(result.mode, "offline");
    assert.equal(result.claims.find((item: { claim: string }) => item.claim === "model_signature_and_wire_binding").status, "passed");
    const changed = packet(); changed.inference!.signature!.signature = "00".repeat(64);
    await writeFile(file, JSON.stringify(changed));
    assert.equal(run().status, 1);
    await writeFile(file, '{"schema":"unsupported"}');
    assert.equal(run().status, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
