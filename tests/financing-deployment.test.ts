import assert from "node:assert/strict";
import { test } from "node:test";
import { base58 } from "@scure/base";
import { finalizedContractView, finalizedDeployment } from "../src/server/financing/deployment";

const accountId = "credit.near";
const codeHash = base58.encode(new Uint8Array(32).fill(21));
const blockHash = base58.encode(new Uint8Array(32).fill(22));
const upgradeKey = `ed25519:${base58.encode(new Uint8Array(32).fill(23))}`;
const otherKey = `ed25519:${base58.encode(new Uint8Array(32).fill(24))}`;
const anchor = {block_hash:blockHash, block_height:1234};
const fullAccess = (publicKey: string) => ({public_key:publicKey, access_key:{permission:"FullAccess"}});

async function withDeployment(
  options: {keys?: unknown; codeHash?: string; globalContract?: string; keysBlockHash?: string; keysBlockHeight?: number; policy?: string; pins?: string},
  run: () => Promise<void>,
) {
  const originalFetch = globalThis.fetch;
  const names = ["NEAR_CONTRACT_UPGRADE_POLICY", "NEAR_CONTRACT_UPGRADE_KEYS", "NEAR_RPC_URL"] as const;
  const saved = Object.fromEntries(names.map(name => [name, process.env[name]]));
  process.env.NEAR_RPC_URL = "https://rpc.example";
  if (options.policy === undefined) delete process.env.NEAR_CONTRACT_UPGRADE_POLICY;
  else process.env.NEAR_CONTRACT_UPGRADE_POLICY = options.policy;
  if (options.pins === undefined) delete process.env.NEAR_CONTRACT_UPGRADE_KEYS;
  else process.env.NEAR_CONTRACT_UPGRADE_KEYS = options.pins;
  globalThis.fetch = async (_url, init) => {
    const request = JSON.parse(init!.body as string), params = request.params;
    if (request.method === "status") return Response.json({result:{chain_id:"mainnet"}});
    assert.equal(request.method, "query");
    assert.equal(params.account_id, accountId);
    if (params.request_type === "view_account") {
      assert.equal(params.finality, "final");
      return Response.json({result:{...anchor, code_hash:options.codeHash || codeHash, global_contract_account_id:options.globalContract}});
    }
    assert.equal(params.block_id, blockHash);
    assert.equal(Object.hasOwn(params, "finality"), false);
    if (params.request_type === "view_access_key_list") return Response.json({result:{...anchor, keys:options.keys ?? [], block_hash:options.keysBlockHash || blockHash, block_height:options.keysBlockHeight ?? anchor.block_height}});
    assert.equal(params.request_type, "call_function");
    return Response.json({result:{...anchor, result:[...Buffer.from(JSON.stringify({version:2}))]}});
  };
  try {
    await run();
  } finally {
    globalThis.fetch = originalFetch;
    for (const name of names) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  }
}

test("financing defaults to a keyless reviewed deployment with views pinned to the same finalized block", async () => {
  await withDeployment({}, async () => {
    const deployment = await finalizedDeployment("mainnet", accountId, codeHash);
    assert.deepEqual(deployment, {network:"mainnet", accountId, codeHash, blockHash, blockHeight:1234});
    assert.deepEqual(await finalizedContractView(deployment, "get_config"), {version:2});
  });
  await withDeployment({keys:[fullAccess(upgradeKey)]}, async () => {
    await assert.rejects(() => finalizedDeployment("mainnet", accountId, codeHash), {code:"FINANCING_UPGRADE_POLICY_UNVERIFIED"});
  });
});

test("financing accepts only the exact configured full-access upgrade key set", async () => {
  const configured = {policy:"owner_controlled", pins:JSON.stringify({[accountId]:[upgradeKey]})};
  await withDeployment({...configured, keys:[fullAccess(upgradeKey)]}, async () => {
    assert.equal((await finalizedDeployment("mainnet", accountId, codeHash)).codeHash, codeHash);
  });
  for (const keys of [
    [],
    [fullAccess(otherKey)],
    [fullAccess(upgradeKey), fullAccess(otherKey)],
    [{public_key:upgradeKey, access_key:{permission:{FunctionCall:{receiver_id:accountId, method_names:["set_paused"]}}}}],
  ]) {
    await withDeployment({...configured, keys}, async () => {
      await assert.rejects(() => finalizedDeployment("mainnet", accountId, codeHash), {code:"FINANCING_UPGRADE_POLICY_UNVERIFIED"});
    });
  }
  await withDeployment({...configured, keys:[fullAccess(upgradeKey)], pins:JSON.stringify({"other.near":[upgradeKey]})}, async () => {
    await assert.rejects(() => finalizedDeployment("mainnet", accountId, codeHash), {code:"FINANCING_UPGRADE_POLICY_UNVERIFIED"});
  });
});

test("upgrade control never bypasses financing code pins, global-code rejection or exact final block binding", async () => {
  const configured = {policy:"owner_controlled", pins:JSON.stringify({[accountId]:[upgradeKey]}), keys:[fullAccess(upgradeKey)]};
  for (const options of [{codeHash:otherKey.slice(8)}, {globalContract:"mutable.near"}]) {
    await withDeployment({...configured, ...options}, async () => {
      await assert.rejects(() => finalizedDeployment("mainnet", accountId, codeHash), {code:"FINANCING_DEPLOYMENT_REQUIRED"});
    });
  }
  for (const options of [{keysBlockHash:codeHash}, {keysBlockHeight:1235}]) {
    await withDeployment({...configured, ...options}, async () => {
      await assert.rejects(() => finalizedDeployment("mainnet", accountId, codeHash), {code:"FINANCING_DEPLOYMENT_BLOCK_MISMATCH"});
    });
  }
});
