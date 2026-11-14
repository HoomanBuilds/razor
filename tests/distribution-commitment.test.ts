import assert from "node:assert/strict";
import { test } from "node:test";
import { distributionTermsHash, hash, type FrozenPlan } from "../src/server/distributions/model";

const wasmPlan: FrozenPlan = {
  network: "mainnet",
  treasury: "treasury.near",
  companyId: "11111111-1111-4111-8111-111111111111:2dd5dda540767b3a",
  token: "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
  owner: "alice.near",
  policyVersion: "3",
  requiredApprovals: 2,
  deadlineMs: "1800259200000",
  id: "wasm-claims",
  reference: "wasm-claims",
  total: "200",
  allocations: [{ claim_id: "fixed-claim", recipient_id: "standing-vendor", recipient_version: "1", amount: "200", destination: "vendor.near" }],
};
const wasmTermsHash = "a01b6e551fa4df930d73f96577905e86160b6ad22731b7839728a4f0e6494d98";

test("native distribution commitment matches the actual NEAR WASM vector", () => {
  assert.equal(distributionTermsHash(wasmPlan), wasmTermsHash);
});

test("native distribution commitment ignores caller property insertion order", () => {
  const shuffled = Object.fromEntries(Object.entries(wasmPlan).reverse()) as unknown as FrozenPlan;
  shuffled.allocations = wasmPlan.allocations.map(item => Object.fromEntries(Object.entries(item).reverse()) as FrozenPlan["allocations"][number]);
  assert.equal(distributionTermsHash(shuffled), wasmTermsHash);
  assert.deepEqual(wasmPlan.allocations[0], { claim_id: "fixed-claim", recipient_id: "standing-vendor", recipient_version: "1", amount: "200", destination: "vendor.near" });
});

test("native distribution commitment binds the exact financial terms", () => {
  for (const change of [
    { network: "testnet" }, { treasury: "other.near" }, { companyId: "other-company" }, { token: "other-token.near" },
    { id: "other-pool" }, { reference: "other-reference" }, { total: "201" }, { deadlineMs: "1800259200001" },
    { policyVersion: "4" }, { requiredApprovals: 1 },
    ...Object.entries({ claim_id: "other-claim", recipient_id: "other-recipient", recipient_version: "2", amount: "201", destination: "other.near" })
      .map(([field, value]) => ({ allocations: [{ ...wasmPlan.allocations[0], [field]: value }] })),
  ]) assert.notEqual(distributionTermsHash({ ...wasmPlan, ...change }), wasmTermsHash);
});

test("application canonical hashes retain their property-order independence", () => {
  assert.equal(hash({ b: { z: 1, a: 2 }, a: 3 }), hash({ a: 3, b: { a: 2, z: 1 } }));
});
