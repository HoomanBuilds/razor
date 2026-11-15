import assert from "node:assert/strict";
import { test } from "node:test";
import { appFetch, appHref, isPublicDemo, requireLiveWallet } from "../src/lib/demo-scope";

function browser(path: string) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { location: new URL(path, "https://localhost:3000") } });
  return () => { if (previous) Object.defineProperty(globalThis, "window", previous); else Reflect.deleteProperty(globalThis, "window"); };
}

test("live application URLs and wallet behavior are unchanged", () => {
  const restore = browser("/app?company=live");
  try { assert.equal(appHref("/api/auth/session"), "/api/auth/session"); assert.equal(appHref("/receive?token=live"), "/receive?token=live"); assert.doesNotThrow(requireLiveWallet); assert.equal(isPublicDemo("/demonstration"), false); } finally { restore(); }
});

test("demo API requests and exports stay in the isolated namespace", () => {
  const restore = browser("/demo?kind=company&profile=owner");
  try { assert.equal(appHref("/api/organizations/a/reports/export?download=1"), "/api/demo/workspace/api/organizations/a/reports/export?download=1"); assert.equal(appHref("/api/demo/workspace/state"), "/api/demo/workspace/state"); assert.throws(requireLiveWallet, /disabled in the demo/); } finally { restore(); }
});

test("company and account navigation preserve demo profile and record IDs", () => {
  const restore = browser("/demo?kind=receive&profile=leo");
  try { assert.equal(appHref("/app?company=acme&section=payments&payment=exact"), "/demo?company=acme&section=payments&payment=exact&kind=company&profile=owner"); assert.equal(appHref("/account?view=security"), "/demo?view=security&kind=account&profile=leo"); } finally { restore(); }
});

test("copied invite links never point at a live claim page", () => {
  const restore = browser("/demo?kind=company&profile=owner");
  try { assert.equal(appHref("https://razorfi.xyz/receive?token=invite%2Bexact"), "/demo?token=invite%2Bexact&kind=receive&profile=maya"); assert.equal(appHref("/receive?token=leo-token&profile=leo"), "/demo?token=leo-token&profile=leo&kind=receive"); assert.equal(appHref("https://example.com/receive?token=other"), "https://example.com/receive?token=other"); } finally { restore(); }
});

test("scoped fetch preserves upload bodies and request options", async () => {
  const restore = browser("/demo"), originalFetch = globalThis.fetch, body = new FormData(); body.set("sample", "value");
  let observed: { input: RequestInfo | URL; init?: RequestInit } | undefined;
  globalThis.fetch = async (input, init) => { observed = { input, init }; return new Response("{}"); };
  try { await appFetch("/api/documents/upload", { method: "POST", body, credentials: "same-origin" }); assert.equal(observed?.input, "/api/demo/workspace/api/documents/upload"); assert.equal(observed?.init?.body, body); assert.equal(observed?.init?.method, "POST"); } finally { globalThis.fetch = originalFetch; restore(); }
});
