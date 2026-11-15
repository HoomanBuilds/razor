import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Token } from "../../src/server/payments/intents";

export const demoPrices: Record<string, number> = { USDC: 1, USDT: 1, ETH: 2000, NEAR: 5, SOL: 100 };
export function configurePublicDemoEnvironment() {
  const publicOrigin = new URL(process.env.PUBLIC_DEMO_ORIGIN || "http://localhost:3000").origin;
  const port = Number(process.env.PUBLIC_DEMO_PORT || 8831);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Invalid demo port");
  for (const key of Object.keys(process.env)) if (!["PATH", "TZ", "LANG", "LC_ALL", "NODE_ENV", "TMPDIR"].includes(key)) delete process.env[key];
  Object.assign(process.env, { DATABASE_PATH: ":memory:", RAZOR_DATABASE_SCOPE_REQUIRED: "1", DATA_ENCRYPTION_KEY: randomBytes(32).toString("hex"), APP_URL: publicOrigin, NEAR_NETWORK: "mainnet", RAZOR_BILLING_MODE: "pilot", NEAR_TREASURY_ID: "treasury.demo.near", NEAR_CLEARING_ID: "clearing.demo.near", NEAR_TREASURY_CODE_HASH: "11111111111111111111111111111111", NEAR_CLEARING_CODE_HASH: "11111111111111111111111111111111", NEAR_CONTRACT_UPGRADE_POLICY: "owner_controlled", NEAR_CONTRACT_UPGRADE_KEYS: JSON.stringify({ "treasury.demo.near": ["ed25519:11111111111111111111111111111111"], "clearing.demo.near": ["ed25519:11111111111111111111111111111111"] }) });
  const tokens = (JSON.parse(readFileSync(new URL("../demo/assets.json", import.meta.url), "utf8")) as Token[]).map(token => ({ ...token, price: demoPrices[token.symbol], priceUpdatedAt: new Date().toISOString() }));
  globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? input : null, url = new URL(request?.url ?? String(input));
    if (url.protocol === "https:" && url.hostname === "1click.chaindefuser.com" && url.pathname === "/v0/tokens" && (init?.method ?? request?.method ?? "GET") === "GET") return Response.json(tokens);
    throw new Error("Public demo blocks external requests");
  };
  return { publicOrigin, port, tokens };
}
