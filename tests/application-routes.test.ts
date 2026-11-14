import assert from "node:assert/strict";
import { test } from "node:test";
import { legacyWorkspacePath } from "../src/lib/application-routes";

test("legacy dashboard links preserve scoped payment and billing context under the app route", () => {
  const value = legacyWorkspacePath({ company: "company one", section: "payments", payment: "payment&two", invoice: "bill#three", utm_source: "campaign" });
  assert(value);
  const url = new URL(value, "https://razor.example");
  assert.equal(url.pathname, "/app");
  assert.equal(url.searchParams.get("company"), "company one");
  assert.equal(url.searchParams.get("section"), "payments");
  assert.equal(url.searchParams.get("payment"), "payment&two");
  assert.equal(url.searchParams.get("invoice"), "bill#three");
  assert(!url.searchParams.has("utm_source"));
});

test("ordinary marketing visits and ambiguous or oversized legacy values do not redirect", () => {
  for (const query of [{}, { utm_source: "search" }, { company: ["one", "two"] }, { section: undefined }, { payment: "x".repeat(513) }]) assert.equal(legacyWorkspacePath(query), null);
  assert.equal(legacyWorkspacePath({ section: "treasury" }), "/app?section=treasury");
  assert.equal(legacyWorkspacePath({ company: "https://other.example" }), "/app?company=https%3A%2F%2Fother.example");
});
