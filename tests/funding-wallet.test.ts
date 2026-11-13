import { test } from "node:test";
import assert from "node:assert/strict";
import { validateFundingQuote, type FundingWalletActionProps } from "../src/components/auth/funding-wallet";

function fixture():FundingWalletActionProps {
  const token={assetId:"nep141:test-token.near",blockchain:"near",symbol:"TEST",decimals:6,contractAddress:"test-token.near"};
  const quote={quoteRequest:{originAsset:token.assetId,refundTo:"sender.near",dry:false,deadline:new Date(Date.now()+60000).toISOString(),depositType:"ORIGIN_CHAIN"},quote:{amountIn:"1000000",depositAddress:"deposit.near"}};
  return {token,funding:{id:"funding-one",origin_asset:token.assetId,amount_in:"1000000",deposit_address:"deposit.near",deposit_memo:null,quote:JSON.stringify(quote),status:"pending_deposit"},onSubmitted:async()=>{}};
}

test("wallet funding binds the exact quoted asset, amount, deposit address and memo",()=>{
  const props=fixture();
  assert.equal(validateFundingQuote(props.funding,props.token).quote.amountIn,"1000000");
  assert.throws(()=>validateFundingQuote({...props.funding,amount_in:"999999"},props.token),/do not match/);
  assert.throws(()=>validateFundingQuote({...props.funding,deposit_address:"someone-else.near"},props.token),/do not match/);
  assert.throws(()=>validateFundingQuote({...props.funding,deposit_memo:"other-memo"},props.token),/do not match/);
  assert.throws(()=>validateFundingQuote(props.funding,{...props.token,assetId:"nep141:different.near"}),/do not match/);
});

test("wallet funding refuses expired, preview and previously funded requests",()=>{
  const props=fixture(),quote=JSON.parse(props.funding.quote as string);
  assert.throws(()=>validateFundingQuote({...props.funding,status:"processing"},props.token),/already moved past/);
  quote.quoteRequest.deadline=new Date(Date.now()-1000).toISOString();
  assert.throws(()=>validateFundingQuote({...props.funding,quote},props.token),/expired/);
  quote.quoteRequest.deadline=new Date(Date.now()+60000).toISOString();quote.quoteRequest.dry=true;
  assert.throws(()=>validateFundingQuote({...props.funding,quote},props.token),/do not match/);
});

test("funding uses the deliberately quoted account even when a wallet returns it after another account", async () => {
  const { selectFundingAccount } = await import("../src/components/auth/funding-wallet");
  assert.equal(selectFundingAccount(["first.near", "payroll.near"], "payroll.near"), "payroll.near");
  assert.equal(selectFundingAccount(["0xother", "0xAbC"], "0xabc", true), "0xAbC");
  assert.throws(() => selectFundingAccount(["first.near"], "payroll.near"), /refund address/);
});
