import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Connection, PublicKey } from "@solana/web3.js";

const root = new URL("../", import.meta.url);
const packages = (JSON.parse(readFileSync(new URL("package-lock.json", root), "utf8")) as {
  packages: Record<string, { dependencies?: Record<string, string> }>;
}).packages;

test("Solana's browser JSON-RPC client preserves request IDs and result/error callbacks", async () => {
  let fail = false;
  const connection = new Connection("http://127.0.0.1:8899", {
    fetch: async (_input, options) => {
      const request = JSON.parse(String(options?.body));
      assert.equal(request.method, "getBalance");
      assert.equal(request.params[0], "11111111111111111111111111111111");
      assert.equal(typeof request.id, "string");
      return new Response(JSON.stringify({
        jsonrpc: "2.0",
        id: request.id,
        ...(fail ? { error: { code: -32602, message: "Rejected fixture account" } } : { result: { context: { slot: 1 }, value: 123 } }),
      }));
    },
  });
  const account = new PublicKey("11111111111111111111111111111111");
  assert.equal(await connection.getBalance(account), 123);
  fail = true;
  await assert.rejects(connection.getBalance(account), /Rejected fixture account/);
});

test("WalletConnect URI APIs and the unused declared query module remain compatible", () => {
  const owners = Object.entries(packages).filter(([path, value]) => path.endsWith("/@walletconnect/utils") && value.dependencies?.["query-string"]);
  assert(owners.length > 0);
  for (const [path] of owners) {
    const require = createRequire(resolve(fileURLToPath(root), path, "package.json"));
    const { parseUri, formatUri } = require("@walletconnect/utils");
    const uri = `wc:fixture-topic@2?relay-protocol=irn&symKey=${"a".repeat(64)}`;
    const parsed = parseUri(uri);
    assert.equal(parsed.topic, "fixture-topic");
    assert.equal(parsed.version, 2);
    assert.equal(parsed.symKey, "a".repeat(64));
    assert.equal(parsed.relay.protocol, "irn");
    const roundTrip = parseUri(formatUri(parsed));
    assert.equal(roundTrip.topic, parsed.topic);
    assert.equal(roundTrip.symKey, parsed.symKey);
    const queryModule = require("query-string");
    const query = queryModule.default ?? queryModule;
    const encoded = query.stringify({ title: "Razor pay run", network: "base" });
    assert.equal(query.parse(encoded).title, "Razor pay run");
    assert.doesNotThrow(() => query.parse(`value=${"%C0".repeat(5000)}`));
  }
});

test("MetaMask's named UUID v4 and validation APIs remain compatible in CommonJS callers", () => {
  const owners = Object.entries(packages).filter(([path, value]) => /\/@metamask\/(?:utils|sdk|sdk-communication-layer)$/.test(path) && value.dependencies?.uuid);
  assert(owners.length > 0);
  for (const [path] of owners) {
    const require = createRequire(resolve(fileURLToPath(root), path, "package.json"));
    const uuid = require("uuid");
    const first = uuid.v4(), second = uuid.v4();
    assert.equal(uuid.validate(first), true);
    assert.equal(uuid.validate(second), true);
    assert.notEqual(first, second);
    assert.equal(uuid.version(first), 4);
    assert.equal(uuid.validate("not-a-session-id"), false);
  }
});
