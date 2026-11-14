import assert from "node:assert/strict";
import { test } from "node:test";
import { accountReturnPath, accountView } from "../src/lib/account-navigation";

test("account views default to the everyday profile and validate deep links", () => {
  for (const view of ["profile", "wallets", "security", "recovery"]) assert.equal(accountView(view), view);
  for (const value of [undefined, "", "logout", ["security"], null]) assert.equal(accountView(value), "profile");
});

test("account return paths preserve accessible company or recipient context", () => {
  assert.equal(accountReturnPath(["company-one"], "company-one"), "/app?company=company-one&section=overview");
  assert.equal(accountReturnPath([], null), "/app");
  assert.equal(accountReturnPath(["company-one"], "company-one", "/app?company=company-one&section=payments&payment=receipt"), "/app?company=company-one&section=payments&payment=receipt");
  assert.equal(accountReturnPath([], null, "/receive?recipientId=profile&personal=payments"), "/receive?recipientId=profile&personal=payments");
});

test("account return paths reject external, inaccessible and recursive destinations", () => {
  const fallback="/app?company=company-one&section=overview";
  for(const value of ["https://other.example", "//other.example", "/account", "/account?view=security", "/app?company=foreign", "/\\other.example", "/app\n", null]) assert.equal(accountReturnPath(["company-one"],"company-one",value),fallback);
  assert.equal(accountReturnPath(["company-one"],"removed-company"),"/app");
});
