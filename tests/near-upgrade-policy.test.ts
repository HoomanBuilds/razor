import { test } from "node:test";
import assert from "node:assert/strict";
import { base58 } from "@scure/base";
import { assertContractUpgradeKeys, describeContractUpgradePolicy } from "../src/server/near-upgrade-policy";

const account = "treasury.near";
const key = `ed25519:${base58.encode(new Uint8Array(32).fill(7))}`;
const other = `ed25519:${base58.encode(new Uint8Array(32).fill(8))}`;
const entry = (publicKey: string) => ({ public_key: publicKey, access_key: { permission: "FullAccess" } });
const env = (keys = [key]): Partial<NodeJS.ProcessEnv> => ({ NEAR_CONTRACT_UPGRADE_POLICY: "owner_controlled", NEAR_CONTRACT_UPGRADE_KEYS: JSON.stringify({ [account]: keys }) });

test("immutable deployment policy remains keyless and never accepts a populated account", () => {
  assert.equal(describeContractUpgradePolicy(account, {}).upgradable, false);
  assert.doesNotThrow(() => assertContractUpgradeKeys(account, [], {}));
  assert.throws(() => assertContractUpgradeKeys(account, [entry(key)], {}), /approved upgrade policy/);
  assert.throws(() => assertContractUpgradeKeys(account, null, {}), /could not be verified/);
});

test("owner controlled code requires the exact independently approved full-access key set", () => {
  assert.equal(describeContractUpgradePolicy(account, env()).upgradable, true);
  assert.doesNotThrow(() => assertContractUpgradeKeys(account, [entry(key)], env()));
  assert.doesNotThrow(() => assertContractUpgradeKeys(account, [entry(other), entry(key)], env([key, other])));
  for (const keys of [[], [entry(other)], [entry(key), entry(other)], [entry(key), entry(key)], [{ public_key: key, access_key: { permission: { FunctionCall: {} } } }]]) {
    assert.throws(() => assertContractUpgradeKeys(account, keys, env()), /approved upgrade policy/);
  }
});

test("missing malformed duplicate oversized and unrelated upgrade pins fail closed", () => {
  for (const settings of [
    { NEAR_CONTRACT_UPGRADE_POLICY: "anything" },
    { NEAR_CONTRACT_UPGRADE_POLICY: "owner_controlled" },
    { ...env(), NEAR_CONTRACT_UPGRADE_KEYS: "[]" },
    { ...env(), NEAR_CONTRACT_UPGRADE_KEYS: "{}" },
    { ...env(), NEAR_CONTRACT_UPGRADE_KEYS: JSON.stringify({ [account]: ["ed25519:bad"] }) },
    env([key, key]),
    { ...env(), NEAR_CONTRACT_UPGRADE_KEYS: JSON.stringify({ "bad..near": [key] }) },
    { ...env(), NEAR_CONTRACT_UPGRADE_KEYS: " ".repeat(8193) },
  ]) assert.throws(() => describeContractUpgradePolicy(account, settings));
  assert.throws(() => describeContractUpgradePolicy("billing.near", env()), /no approved upgrade-key pin/);
});
