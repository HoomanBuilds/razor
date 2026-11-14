import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QuotedPayoutIdentity } from "../src/components/procurement-commercial";

test("commercial quote identity uses the matching catalog token and preserves unavailable asset identity", () => {
  const asset = "nep141:review-token.omft.near";
  const assets = [{ assetId: asset, symbol: "USDC", blockchain: "base" }];
  const matched = renderToStaticMarkup(createElement(QuotedPayoutIdentity, { asset, network: "base", assets }));
  assert.ok(matched.includes("USDC ")); assert.ok(matched.includes("Base")); assert.ok(matched.includes(`title="${asset}"`));
  const wrongNetwork = renderToStaticMarkup(createElement(QuotedPayoutIdentity, { asset, network: "near", assets }));
  assert.ok(wrongNetwork.includes("Selected receiving asset")); assert.ok(wrongNetwork.includes(asset)); assert.ok(!wrongNetwork.includes("USDC "));
});
