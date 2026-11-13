import test from "node:test";
import assert from "node:assert/strict";
import { matchesAssetSearch, networkIdentity } from "../src/lib/asset-identity";

const assets=[{assetId:"nep141:usdc-base.omft.near",symbol:"USDC",blockchain:"base",contractAddress:"0x1111111111111111111111111111111111111111"},{assetId:"nep141:usdc-arb.omft.near",symbol:"USDC",blockchain:"arb",contractAddress:"0x2222222222222222222222222222222222222222"}];

test("network presentation resolves Intents aliases and preserves unknown network names",()=>{
  assert.deepEqual(networkIdentity("arb"),{key:"arbitrum",name:"Arbitrum"});
  assert.deepEqual(networkIdentity(" SOLANA "),{key:"solana",name:"Solana"});
  assert.deepEqual(networkIdentity("new-chain"),{key:"new-chain",name:"new-chain"});
  assert.equal(networkIdentity("testnet").name,"testnet");
});

test("asset search distinguishes same-symbol networks and searches exact catalog identities",()=>{
  assert.equal(assets.filter(asset=>matchesAssetSearch(asset,"  usdc   arbitrum ")).length,1);
  assert.equal(matchesAssetSearch(assets[1],"USDC Base"),false);
  assert.equal(matchesAssetSearch(assets[0],assets[0].assetId),true);
  assert.equal(matchesAssetSearch(assets[1],assets[1].contractAddress),true);
  assert.equal(matchesAssetSearch(assets[0],""),true);
  assert.equal(matchesAssetSearch(assets[0],"unknown-token"),false);
});
