import { test } from "node:test";
import assert from "node:assert/strict";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { app } from "../src/server/app";

process.env.DATABASE_PATH = ":memory:";
process.env.DATA_ENCRYPTION_KEY = "ab".repeat(32);
process.env.APP_URL = "http://localhost:3000";

function privateResponse(response: Response) {
  assert.match(response.headers.get("Cache-Control") ?? "", /\bno-store\b/);
  assert.equal(response.headers.get("Referrer-Policy"), "no-referrer");
  assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
}

test("private API results, authentication failures and malformed requests forbid caching and referrer disclosure", async () => {
  const account = privateKeyToAccount(generatePrivateKey());
  const headers = { Origin: process.env.APP_URL!, "Content-Type": "application/json" };
  const challenge = await app.request("http://localhost:3000/api/auth/challenge", { method: "POST", headers, body: JSON.stringify({ family: "evm", address: account.address }) });
  assert.equal(challenge.status, 200);
  privateResponse(challenge);
  const value = await challenge.json();
  const signed = await app.request("http://localhost:3000/api/auth/wallet", { method: "POST", headers, body: JSON.stringify({ challengeId: value.challengeId, signature: await account.signMessage({ message: value.message }) }) });
  assert.equal(signed.status, 200);
  privateResponse(signed);
  const cookie = signed.headers.get("set-cookie")!.split(";")[0];
  const session = await app.request("http://localhost:3000/api/auth/session", { headers: { Cookie: cookie } });
  assert.equal(session.status, 200);
  privateResponse(session);
  for (const [path, options, status] of [
    ["/auth/session", {}, 401],
    ["/auth/challenge", { method: "POST", headers: { ...headers, Origin: "https://other.example" }, body: "{}" }, 403],
    ["/auth/challenge", { method: "POST", headers, body: "{" }, 400],
    ["/auth/challenge", { method: "POST", headers, body: "x".repeat(1_048_577) }, 413],
    ["/not-an-api", {}, 404],
  ] as const) {
    const response = await app.request(`http://localhost:3000/api${path}`, options);
    assert.equal(response.status, status);
    privateResponse(response);
  }
});
