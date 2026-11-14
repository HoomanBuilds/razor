import assert from "node:assert/strict";
import { test } from "node:test";
import { base58 } from "@scure/base";
import { contractCodeHash } from "../src/server/payments/near";
import { verifyBillingContract } from "../src/server/billing/chain";
import { finalContext } from "../src/server/clearing/chain";
import { NATIVE_USDC } from "../src/lib/native-usdc";

const accounts = {treasury:"treasury.near", clearing:"clearing.near", billing:"billing.near"};
const hashes = {treasury:base58.encode(new Uint8Array(32).fill(31)), clearing:base58.encode(new Uint8Array(32).fill(32)), billing:base58.encode(new Uint8Array(32).fill(33))};
const block = {hash:base58.encode(new Uint8Array(32).fill(34)), height:1234, timestamp_nanosec:"1800000000000000000"};
const publicKey = `ed25519:${base58.encode(new Uint8Array(32).fill(35))}`;
const unexpectedKey = `ed25519:${base58.encode(new Uint8Array(32).fill(36))}`;
const billingTarget = {network:"mainnet" as const, billingContract:accounts.billing, tokenContract:NATIVE_USDC.near, codeHash:hashes.billing};
const readers = [
  {account:accounts.treasury, read:() => contractCodeHash({near_account_id:accounts.treasury, network:"mainnet"})},
  {account:accounts.billing, read:() => verifyBillingContract(billingTarget)},
  {account:accounts.clearing, read:() => finalContext()},
];

async function withRuntime(
  options: {policy?:string; changedKeyAccount?:string; changedBlockAccount?:string; globalCodeAccount?:string; missingPinAccount?:string},
  run: (keyReads: () => number) => Promise<void>,
) {
  const values: Record<string, string | undefined> = {
    NEAR_NETWORK:"mainnet", NEAR_TREASURY_ID:accounts.treasury, NEAR_CLEARING_ID:accounts.clearing,
    NEAR_TREASURY_CODE_HASH:hashes.treasury, NEAR_CLEARING_CODE_HASH:hashes.clearing,
    NEAR_CONTRACT_UPGRADE_POLICY:options.policy,
    NEAR_CONTRACT_UPGRADE_KEYS:JSON.stringify(Object.fromEntries(Object.values(accounts).filter(account => account !== options.missingPinAccount).map(account => [account,[publicKey]]))),
  };
  const saved = Object.fromEntries(Object.keys(values).map(name => [name,process.env[name]]));
  const originalFetch = globalThis.fetch;
  for (const [name,value] of Object.entries(values)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  let keyReads = 0;
  globalThis.fetch = async (_url, init) => {
    const request = JSON.parse(init!.body as string), params = request.params;
    if (request.method === "status") return Response.json({result:{chain_id:"mainnet"}});
    if (request.method === "block") return Response.json({result:{header:block}});
    assert.equal(request.method, "query");
    let result: Record<string, unknown>;
    const kind = Object.keys(accounts).find(key => accounts[key as keyof typeof accounts] === params.account_id) as keyof typeof accounts;
    assert(kind);
    if (params.request_type === "view_account") result = {code_hash:hashes[kind], global_contract_account_id:options.globalCodeAccount === params.account_id ? "mutable.near" : null};
    else if (params.request_type === "view_access_key_list") {
      keyReads++;
      assert.equal(params.block_id, block.hash);
      assert.equal(Object.hasOwn(params,"finality"), false);
      result = {keys:[{public_key:options.changedKeyAccount === params.account_id ? unexpectedKey : publicKey, access_key:{permission:"FullAccess"}}]};
    } else {
      assert.equal(params.block_id, block.hash);
      const config = params.account_id === accounts.billing ? {version:1, owner_id:"owner.near", network:"mainnet", token_contract:NATIVE_USDC.near, paused:false, available:"0"}
        : params.account_id === accounts.clearing ? {treasury_id:accounts.treasury, token_contract:NATIVE_USDC.near, paused:false}
        : {architecture:"shared_v1", token_contract:NATIVE_USDC.near};
      result = {result:[...Buffer.from(JSON.stringify(config))]};
    }
    return Response.json({result:{...result, block_hash:params.request_type === "view_access_key_list" && options.changedBlockAccount === params.account_id ? hashes.billing : block.hash, block_height:block.height}});
  };
  try {
    await run(() => keyReads);
  } finally {
    globalThis.fetch = originalFetch;
    for (const [name,value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

test("explicit upgrade control verifies pinned keys for payment, billing and clearing preparation", async () => {
  await withRuntime({policy:"owner_controlled"}, async keyReads => {
    for (const {read} of readers) await read();
    assert.equal(keyReads(), 4);
  });
  for (const {account,read} of readers) {
    await withRuntime({policy:"owner_controlled", changedKeyAccount:account}, async () => {
      await assert.rejects(read, {code:"UPGRADE_KEYS_MISMATCH"});
    });
    await withRuntime({policy:"owner_controlled", missingPinAccount:account}, async () => {
      await assert.rejects(read, {code:"UPGRADE_KEY_PIN_REQUIRED"});
    });
    await withRuntime({policy:"owner_controlled", changedBlockAccount:account}, async () => {
      await assert.rejects(read, /finalized block/);
    });
  }
});

test("legacy default avoids new key reads while unknown explicit policies and indirect global code fail closed", async () => {
  await withRuntime({}, async keyReads => {
    for (const {read} of readers) await read();
    assert.equal(keyReads(), 0);
  });
  for (const {account,read} of readers) {
    await withRuntime({policy:"unexpected"}, async () => {
      await assert.rejects(read, {code:"UPGRADE_POLICY_INVALID"});
    });
    await withRuntime({globalCodeAccount:account}, async () => {
      await assert.rejects(read, /code/i);
    });
  }
});
