import { test } from "node:test";
import assert from "node:assert/strict";
import { walletFailureMessage } from "../src/lib/client-errors";
import { canOpenSection, hasPermissions, workspacePath } from "../src/lib/workspace-access";
import { api, errorMessage, RequestError, SESSION_EXPIRED_EVENT, ACCESS_CHANGED_EVENT } from "../src/lib/api";

test("wallet errors distinguish rejection, contract authority and unresolved execution", () => {
  assert.match(walletFailureMessage({ cause: { code: 4001 } }), /cancelled/);
  assert.match(walletFailureMessage({ message: "Execution rejected: ONLY_OWNER" }), /wallet that owns/);
  assert.doesNotMatch(walletFailureMessage({ message: "Execution rejected: ONLY_OWNER" }), /cancelled/);
  assert.match(walletFailureMessage({ shortMessage: "smart contract panicked: SOURCE_MAY_STILL_DELIVER" }), /may still complete/);
  assert.match(walletFailureMessage({ message: "nonce too low" }), /already be pending/);
  assert.match(walletFailureMessage({ message: "insufficient funds" }), /transfer and its network fee/);
  assert.match(walletFailureMessage({ message: "insufficient native gas balance" }), /native tokens/);
  assert.match(walletFailureMessage({ message: "chain mismatch" }), /another network/);
  assert.match(walletFailureMessage({ cause: { message: "fetch failed" } }), /saved transfer status/);
  assert.equal(errorMessage(new RequestError("Explicit review needed", 409, "REVIEW_REQUIRED")), "Explicit review needed");
});

test("wallet errors bound nested causes and avoid dumping raw transaction payloads", () => {
  const cycle: { cause?: unknown; message: string } = { message: JSON.stringify({ private: "raw transaction payload" }) };
  cycle.cause = cycle;
  assert.equal(walletFailureMessage(cycle, "Review saved status"), "Review saved status");
  assert.equal(walletFailureMessage(null, "No wallet response"), "No wallet response");
  assert.equal(walletFailureMessage({ message: "Select your NEAR wallet first." }), "Select your NEAR wallet first.");
});

test("workspace navigation matches readable permissions and encodes company and payment context", () => {
  const viewer = ["company:read", "payments:read", "reports:read"];
  assert(canOpenSection("overview", viewer));
  assert(canOpenSection("payments", viewer));
  assert(canOpenSection("activity", viewer));
  assert(!canOpenSection("recipients", viewer));
  assert(!canOpenSection("payments", ["company:read"]));
  assert(canOpenSection("procurement", viewer));
  assert(!canOpenSection("expenses", viewer));
  assert(canOpenSection("expenses", [...viewer, "documents:manage"]));
  assert(canOpenSection("distributions", viewer));
  assert(!canOpenSection("accounting", viewer));
  assert(canOpenSection("accounting", [...viewer, "company:manage"]));
  assert(canOpenSection("support", ["company:read"]));
  assert(!canOpenSection("support", []));
  assert(canOpenSection("settings", ["company:read"]));
  assert(canOpenSection("billing", ["company:read"]));
  assert(!canOpenSection("billing", []));
  assert(!hasPermissions(undefined, ["company:read"]));
  assert(!canOpenSection("unknown" as "overview", viewer));
  const url = new URL(workspacePath("company one", "payments", "payment&two"), "http://localhost");
  assert.equal(url.pathname, "/app");
  assert.equal(url.searchParams.get("company"), "company one");
  assert.equal(url.searchParams.get("payment"), "payment&two");
  assert(!workspacePath("company", "settings", "hidden").includes("payment="));
  const invoice = new URL(workspacePath("company one", "billing", undefined, "invoice&two"), "http://localhost");
  assert.equal(invoice.searchParams.get("invoice"), "invoice&two");
  assert(!workspacePath("company", "settings", undefined, "hidden").includes("invoice="));
});

test("API only expires sessions for authentication loss, refreshes changed access and forwards abort signals", async () => {
  const originalFetch = globalThis.fetch, originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const events = new EventTarget();
  let expired = 0, access = 0;
  events.addEventListener(SESSION_EXPIRED_EVENT, () => expired++);
  events.addEventListener(ACCESS_CHANGED_EVENT, () => access++);
  Object.defineProperty(globalThis, "window", { configurable: true, value: events });
  try {
    const failure = (code: string, status: number) => { globalThis.fetch = async () => new Response(JSON.stringify({ error: "Readable failure", code }), { status }); };
    failure("SIGNATURE_REJECTED", 401);
    await assert.rejects(api("/proof"), RequestError);
    assert.equal(expired, 0);
    failure("UNAUTHENTICATED", 401);
    await assert.rejects(api("/payments"), RequestError);
    assert.equal(expired, 1);
    failure("FORBIDDEN", 403);
    await assert.rejects(api("/payments"), RequestError);
    assert.equal(access, 1);
    failure("INVITATION_WALLET_MISMATCH", 403);
    await assert.rejects(api("/invitation"), RequestError);
    assert.equal(access, 1);
    const controller = new AbortController();
    globalThis.fetch = async (url, init) => {
      assert.equal(url, "/api/company");
      assert.equal(init?.signal, controller.signal);
      assert.equal(init?.credentials, "same-origin");
      return Response.json({ ok: true });
    };
    assert.deepEqual(await api("/company", undefined, undefined, { signal: controller.signal }), { ok: true });
    globalThis.fetch = async () => new Response("Temporary upstream failure", { status: 502 });
    await assert.rejects(api("/company"), (cause: unknown) => cause instanceof RequestError && cause.code === "INVALID_RESPONSE" && cause.status === 502);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow); else Reflect.deleteProperty(globalThis, "window");
  }
});
