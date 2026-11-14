import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { base58 } from "@scure/base";
import { prepareDeployment } from "../src/server/setup/deployment";
import { NATIVE_USDC } from "../src/lib/native-usdc";

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "razor-deploy-'"));
  const wasm = Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]);
  const entries = [["razor_treasury.wasm", "NEAR_TREASURY_CODE_HASH"], ["razor_clearing.wasm", "NEAR_CLEARING_CODE_HASH"], ["razor_billing.wasm", "RAZOR_BILLING_CODE_HASH"]];
  const artifacts = entries.map(([file, environmentKey], index) => {
    const bytes = index === 1 ? Buffer.concat([wasm, Buffer.from("embedded"), wasm, Buffer.from([0])]) : Buffer.concat([wasm, Buffer.from([index])]);
    writeFileSync(join(directory, file), bytes);
    const digest = createHash("sha256").update(bytes).digest();
    return { file, environmentKey, bytes: bytes.length, sha256: digest.toString("hex"), codeHash: base58.encode(digest) };
  });
  writeFileSync(join(directory, "manifest.json"), JSON.stringify({ architecture:"shared_v1", treasuryStateVersion: 2, artifacts }));
  return { directory, input: { network: "mainnet" as const, treasuryAccount: "treasury.near", clearingAccount: "clearing.near", ownerAccount: "owner.near", artifactDirectory: directory } };
}

test("deployment plan preserves canonical mainnet USDC, reviewed hashes and atomic initialization without execution", () => {
  const { directory, input } = fixture();
  try {
    const plan = prepareDeployment(input);
    assert.equal(plan.tokenContract, NATIVE_USDC.near);
    assert.equal(plan.deployed, false);
    assert.equal(plan.accountsVerified, false);
    assert.equal(plan.treasuryStateVersion, 2);
    assert.equal(plan.freshAccountsOnly, true);
    assert.equal(plan.populatedStateMigrationSupported, false);
    assert.equal(plan.steps.length, 2);
    for (const step of plan.steps) {
      assert.equal(step.atomicInitialization, true);
      assert.equal(step.signerAccountId, step.accountId);
      assert.deepEqual(step.argv.slice(4, 9), [step.artifact.path, "with-init-call", "new", "json-args", JSON.stringify(step.args)]);
      assert(step.shellCommand.includes("'\\''"));
      assert(!step.argv.includes("without-init-call"));
    }
    assert.equal(plan.steps[1].args.treasury_id, input.treasuryAccount);
    assert.equal(plan.environment.NEAR_TREASURY_CODE_HASH, plan.artifacts[0].codeHash);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("deployment plans reject unsafe identities and mixed mainnet/testnet tokens", () => {
  const { directory, input } = fixture();
  try {
    assert.throws(() => prepareDeployment({ ...input, ownerAccount: input.treasuryAccount }), /distinct/);
    assert.throws(() => prepareDeployment({ ...input, clearingAccount: "bad..near" }), /valid/);
    assert.throws(() => prepareDeployment({ ...input, treasuryAccount: "treasury.testnet" }), /mainnet/);
    assert.throws(() => prepareDeployment({ ...input, testnetToken: "token.testnet" }), /canonical/);
    assert.throws(() => prepareDeployment({ ...input, network: "testnet" }), /testnet token/);
    const plan = prepareDeployment({ ...input, network: "testnet", testnetToken: "usdc.testnet" });
    assert.equal(plan.settlementEnabled, false);
    assert.equal(plan.tokenContract, "usdc.testnet");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("deployment plans reject modified, invalid and duplicate artifact metadata", () => {
  const { directory, input } = fixture();
  try {
    const file = join(directory, "razor_clearing.wasm"), original = readFileSync(file);
    writeFileSync(file, "not wasm");
    assert.throws(() => prepareDeployment(input), /invalid WebAssembly/);
    writeFileSync(file, Buffer.concat([original, Buffer.from([1])]));
    assert.throws(() => prepareDeployment(input), /manifest/);
    writeFileSync(file, original);
    const manifestFile = join(directory, "manifest.json"), manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
    manifest.artifacts.push(manifest.artifacts[0]);
    writeFileSync(manifestFile, JSON.stringify(manifest));
    assert.throws(() => prepareDeployment(input), /manifest/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("shared deployment deploys treasury code once without factory artifacts", () => {
  const { directory, input } = fixture();
  try {
    const plan = prepareDeployment(input);
    assert.equal(plan.architecture, "shared_v1");
    assert.equal(plan.keyRetirement.length,2);
    assert(plan.keyRetirement.every(step=>step.required&&!step.verified&&step.verification.expected_keys.length===0));
    assert.deepEqual(plan.artifacts.map(item => item.file), ["razor_treasury.wasm", "razor_clearing.wasm"]);
    assert.deepEqual(plan.steps[0].args, { owner_id: input.ownerAccount, token_contract: NATIVE_USDC.near });
    assert.equal(plan.environment.NEAR_TREASURY_ID, input.treasuryAccount);
    assert(!JSON.stringify(plan).includes("NEAR_FACTORY"));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("optional billing deployment binds its dedicated account, public issuer key and reviewed artifact", () => {
  const { directory, input } = fixture();
  try {
    const issuerPublicKey = `ed25519:${base58.encode(new Uint8Array(32).fill(7))}`;
    const plan = prepareDeployment({ ...input, billingAccount: "billing.near", billingIssuerPublicKey: issuerPublicKey });
    assert.equal(plan.steps.length, 3);
    assert.equal(plan.steps[2].args.issuer_public_key, issuerPublicKey);
    assert.equal(plan.steps[2].args.network, "mainnet");
    assert.equal(plan.steps[2].args.token_contract, NATIVE_USDC.near);
    assert.equal(plan.environment.RAZOR_BILLING_CONTRACT_ID, "billing.near");
    assert.equal(plan.environment.RAZOR_BILLING_CODE_HASH, plan.artifacts[2].codeHash);
    assert.throws(() => prepareDeployment({ ...input, billingAccount: "billing.near" }), /both/);
    assert.throws(() => prepareDeployment({ ...input, billingAccount: input.ownerAccount, billingIssuerPublicKey: issuerPublicKey }), /distinct/);
    assert.throws(() => prepareDeployment({ ...input, billingAccount: "billing.near", billingIssuerPublicKey: `ed25519:${base58.encode(new Uint8Array(64).fill(7))}` }), /public key/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("shared deployment refuses legacy artifacts without an architecture manifest", () => {
  const {directory,input}=fixture();
  try {
    const path=join(directory,"manifest.json"),manifest=JSON.parse(readFileSync(path,"utf8"));
    delete manifest.architecture;writeFileSync(path,JSON.stringify(manifest));
    assert.throws(()=>prepareDeployment(input),/shared_v1/);
  }finally{rmSync(directory,{recursive:true,force:true});}
});

test("standing deployment refuses stale company-state manifests instead of planning an upgrade", () => {
  const { directory, input } = fixture();
  try {
    const path = join(directory, "manifest.json"), manifest = JSON.parse(readFileSync(path, "utf8"));
    for (const version of [undefined, 1, 3]) {
      manifest.treasuryStateVersion = version;
      writeFileSync(path, JSON.stringify(manifest));
      assert.throws(() => prepareDeployment(input), /fresh deployment accounts.*no populated-state migration/);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
