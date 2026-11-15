import assert from "node:assert/strict";
import { test } from "node:test";
import { appFetch, appHref, demoRequestHeaders, isPublicDemo, requireLiveWallet } from "../src/lib/demo-scope";

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


test("each demo tab sends only its own allowlisted persona and keeps request headers", async () => {
  const restore = browser("/demo?kind=receive&profile=maya"), originalFetch = globalThis.fetch;
  const seen: { input: RequestInfo | URL; init?: RequestInit }[] = [];
  globalThis.fetch = async (input, init) => { seen.push({ input, init }); return new Response("{}"); };
  try {
    await appFetch("/api/auth/session", { headers: { "x-custom": "kept", "x-razor-demo-profile": "owner" } });
    assert.equal(new Headers(seen[0].init?.headers).get("x-razor-demo-profile"), "maya");
    assert.equal(new Headers(seen[0].init?.headers).get("x-custom"), "kept");
    await appFetch(new Request("https://localhost:3000/api/recipient-workspace/invoices", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }));
    assert.equal(new Headers(seen[1].init?.headers).get("x-razor-demo-profile"), "maya");
    assert.equal(new Headers(seen[1].init?.headers).get("content-type"), "application/json");
    assert.equal(await (seen[1].input as Request).text(), "{}");
    await appFetch("https://external.example/resource");
    assert.equal(new Headers(seen[2].init?.headers).has("x-razor-demo-profile"), false);
    assert.equal(demoRequestHeaders(undefined, "owner").get("x-razor-demo-profile"), "owner");
    assert.equal(demoRequestHeaders({ "x-razor-demo-profile": "owner" }, "invalid").has("x-razor-demo-profile"), false);
  } finally { globalThis.fetch = originalFetch; restore(); }
});

test("demo proxy forwards the persona without forwarding live credentials", async () => {
  const { GET } = await import("../src/app/api/demo/workspace/[...path]/route");
  const originalFetch = globalThis.fetch;
  let forwarded: RequestInit | undefined;
  globalThis.fetch = async (_input, init) => { forwarded = init; return Response.json({ ok: true }); };
  try {
    const context = { params: Promise.resolve({ path: ["api", "auth", "session"] }) };
    const response = await GET(new Request("https://localhost:3000/api/demo/workspace/api/auth/session", { headers: { "x-razor-demo-profile": "maya", authorization: "Bearer live", cookie: `razor_session=live; razor_demo_session=${"a".repeat(43)}` } }), context);
    assert.equal(response.status, 200);
    const headers = new Headers(forwarded?.headers);
    assert.equal(headers.get("x-razor-demo-profile"), "maya");
    assert.equal(headers.get("authorization"), null);
    assert.equal(headers.get("cookie"), `razor_demo_session=${"a".repeat(43)}`);
    assert.equal((await GET(new Request("https://localhost:3000/api/demo/workspace/state", { headers: { "x-razor-demo-profile": "other" } }), { params: Promise.resolve({ path: ["state"] }) })).status, 400);
  } finally { globalThis.fetch = originalFetch; }
});
