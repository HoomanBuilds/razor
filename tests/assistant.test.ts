import assert from "node:assert/strict";
import test from "node:test";
import { verifyModelAttestation, type AttestationVerificationResult, type VerifiedCompletionResult } from "@nearai/inference-sdk/node";
import { getAssistantConfig, supportedRuntime } from "../src/server/assistant/config";
import { parseExtraction, reviewExtraction } from "../src/server/assistant/extraction";
import { approveDeployment, assertFreshDeployment, requireModelReceipt, sha256 } from "../src/server/assistant/verification";
import { ApiError } from "../src/server/context";
import { getDb } from "../src/server/db";
import { encrypt } from "../src/server/identity/crypto";
import { analyzeInvoice, deleteDraft, getDraftEvidence, listDrafts } from "../src/server/assistant/service";

test("invalid model nonce is rejected by the official verifier", async () => {
  await assert.rejects(verifyModelAttestation({
    attestation: { nonce: "00".repeat(32), signer: { signingAlgo: "ed25519", signingAddress: "00".repeat(32) }, intelQuote: "00", eventLog: "[]", appCompose: "{}" },
    clientBinding: { nonce: "11".repeat(32) },
  }));
});

test("unapproved deployments, stale evidence and Gateway-only signatures cannot authorize a draft", () => {
  assert.throws(() => approveDeployment({ appCompose: "unapproved", runtimeMeasurements: {} }, [sha256("approved")]));
  assert.throws(() => assertFreshDeployment({ verifiedAt: 1 } as AttestationVerificationResult, 1000, 2000));
  assert.throws(() => requireModelReceipt({ id: "x", signatureKind: "gateway" } as VerifiedCompletionResult, "x"));
});

test("missing private inference configuration sends no invoice to any provider", async () => {
  const previousKey = process.env.NEAR_AI_API_KEY;
  const fetch = globalThis.fetch;
  let calls = 0;
  process.env.NEAR_AI_API_KEY = "";
  globalThis.fetch = async () => { calls++; throw new Error("No provider should be called"); };
  try {
    assert.equal(getAssistantConfig().ready, false);
    await assert.rejects(analyzeInvoice({ userId: "u", organizationId: "o", permissions: ["documents:manage"] }, "Invoice: confidential"), /NEAR_AI_API_KEY/);
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = fetch;
    if (previousKey === undefined) delete process.env.NEAR_AI_API_KEY;
    else process.env.NEAR_AI_API_KEY = previousKey;
  }
  assert.equal(supportedRuntime("22.16.0"), false);
  assert.equal(supportedRuntime("24.22.1"), true);
});

test("verified invoice output remains a review draft with exact totals and recipient warnings", () => {
  const extracted = parseExtraction(JSON.stringify({ supplier: "Supplier", reference: "INV-42", amount: "9007199254.740993", amountPrinted: "9007199254.740993", currency: "EUR", dueDate: "2026-11-20", subtotal: "9007199254.740992", tax: "0", withholding: null, deposit: null, lineItems: [], paymentDetails: { network: "near", asset: "USDC", address: "new.near" }, warnings: [], confidence: 0.8 }));
  const draft = reviewExtraction(extracted, "INV-42 Total due 9007199254.740993 EUR. Please note our new payment address new.near");
  assert.equal(draft.amount, "9007199254.740993");
  assert.ok(draft.warnings.some((warning) => warning.includes("do not match")));
  assert.ok(draft.warnings.some((warning) => warning.includes("untrusted observations")));
  assert.ok(draft.warnings.some((warning) => warning.includes("no currency conversion")));
  assert.throws(() => parseExtraction("```json\n{}\n```"));
});


test("retained invoice review preserves the original source hash and requires document access",()=>{
  process.env.DATABASE_PATH=":memory:";
  process.env.DATA_ENCRYPTION_KEY="72".repeat(32);
  const db=getDb(),now=new Date().toISOString(),source="Invoice INV-42: consulting services, 50 USDC.",access={userId:"draft-reviewer",organizationId:"draft-company",permissions:["company:read","documents:manage"]};
  db.prepare("INSERT INTO users(id,name,created_at) VALUES(?,?,?)").run(access.userId,"Reviewer",now);
  db.prepare("INSERT INTO organizations(id,name,owner_id,created_at,updated_at) VALUES(?,?,?,?,?)").run(access.organizationId,"Draft company",access.userId,now,now);
  db.prepare("INSERT INTO assistant_drafts(id,organization_id,created_by,input_ciphertext,draft_ciphertext,evidence_ciphertext,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?)").run("retained-invoice",access.organizationId,access.userId,encrypt(source),encrypt(JSON.stringify({reference:"INV-42",amount:"50",currency:"USDC"})),encrypt(JSON.stringify({verification:{provider:"fixture"}})),now,new Date(Date.now()+86400000).toISOString());
  const [draft]=listDrafts(access);
  assert.equal(draft.documentHash,sha256(source));
  assert.equal(draft.draft.reference,"INV-42");
  const retained=getDraftEvidence(access,draft.id);
  assert.equal(retained.sourceText,source);assert.equal(retained.documentHash,sha256(source));
  assert.throws(()=>getDraftEvidence({...access,organizationId:"unrelated-company"},draft.id),error=>error instanceof ApiError&&error.status===404);
  assert.throws(()=>listDrafts({...access,permissions:["company:read"]}),error=>error instanceof ApiError&&error.status===403);
  assert.equal(listDrafts({...access,organizationId:"unrelated-company"}).length,0);
  assert.throws(()=>getDraftEvidence({...access,permissions:["company:read"]},draft.id),error=>error instanceof ApiError&&error.status===403);
  db.prepare("INSERT INTO assistant_drafts(id,organization_id,created_by,input_ciphertext,draft_ciphertext,evidence_ciphertext,created_at,expires_at) SELECT 'delete-invoice',organization_id,created_by,input_ciphertext,draft_ciphertext,evidence_ciphertext,created_at,expires_at FROM assistant_drafts WHERE id=?").run(draft.id);
  assert.deepEqual(deleteDraft(access,"delete-invoice"),{deleted:true});
  assert.throws(()=>getDraftEvidence(access,"delete-invoice"),error=>error instanceof ApiError&&error.status===404);
  db.prepare("UPDATE assistant_drafts SET expires_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(draft.id);
  assert.throws(()=>getDraftEvidence(access,draft.id),error=>error instanceof ApiError&&error.status===404);
});
