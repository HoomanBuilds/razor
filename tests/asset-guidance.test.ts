import { test } from "node:test";
import assert from "node:assert/strict";
import { NATIVE_USDC, nativeUsdcSuggestions } from "../src/lib/native-usdc";

test("suggestions use exact live native USDC identities without limiting the catalog", () => {
  const base = { assetId: "catalog-base-usdc", symbol: "USDC", blockchain: "base", decimals: 6, contractAddress: NATIVE_USDC.base.toUpperCase() };
  const near = { assetId: "catalog-near-usdc", symbol: "USDC", blockchain: "near", decimals: 6, contractAddress: NATIVE_USDC.near };
  const tokens = [base, { ...base, assetId: "wrong-chain-usdc", blockchain: "arb" }, { ...base, assetId: "bridged-usdc", contractAddress: "another-contract" }, { ...base, assetId: "wrong-decimals", decimals: 18 }, { ...base, assetId: "eth", symbol: "ETH" }, near];
  assert.deepEqual(nativeUsdcSuggestions(tokens), [near, base]);
  assert.equal(tokens.length, 6);
  assert.deepEqual(nativeUsdcSuggestions([]), []);
  const sol = { assetId: "catalog-sol-usdc", symbol: "USDC", blockchain: "sol", decimals: 6, contractAddress: NATIVE_USDC.sol };
  assert.deepEqual(nativeUsdcSuggestions([{ ...sol, contractAddress: NATIVE_USDC.sol.toLowerCase() }]), []);
  assert.deepEqual(nativeUsdcSuggestions([sol]), [sol]);
});
