import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { base58 } from "@scure/base";
import { importSPKI } from "jose";
import { privateAiConfig, supportedRuntime } from "../assistant/config";
import { decodeDataEncryptionKey } from "../identity/crypto";
import { reviewedArtifactHash } from "../near-artifacts";
import { validNearAccount } from "../payments/near";
import { NATIVE_USDC } from "../../lib/native-usdc";

type Status = "pass" | "blocked" | "warning" | "not_checked" | "disabled";
interface Check { id: string; stage: "configuration" | "remote" | "workflow"; status: Status; message: string }
interface Options { env?: NodeJS.ProcessEnv; nodeVersion?: string; artifactDirectory?: string; remote?: boolean; fetch?: typeof fetch }
const artifacts = [
  ["treasury", "NEAR_TREASURY_CODE_HASH", "razor_treasury.wasm"],
  ["factory", "NEAR_FACTORY_CODE_HASH", "razor_factory.wasm"],
  ["clearing", "NEAR_CLEARING_CODE_HASH", "razor_clearing.wasm"],
] as const;

function httpUrl(value: string, allowLocal = false) {
  try {
    const url = new URL(value);
    return !url.username && !url.password && (url.protocol === "https:" || allowLocal && url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname));
  } catch { return false; }
}

export async function setupPreflight(options: Options = {}) {
  const env = options.env ?? process.env, nodeVersion = options.nodeVersion ?? process.versions.node;
  const artifactDirectory = options.artifactDirectory ?? ".tools/wasm", network = env.NEAR_NETWORK || "testnet";
  const checks: Check[] = [], pins = new Map<string, string>();
  const add = (id: string, status: Status, message: string, stage: Check["stage"] = "configuration") => checks.push({ id, stage, status, message });
  const failed = (id: string) => checks.some(check => check.id === id && check.status === "blocked");
  add("runtime", supportedRuntime(nodeVersion) ? "pass" : "blocked", "Node.js 24.22.1 or later is required for verified private inference.");
  add("origin", env.APP_URL && httpUrl(env.APP_URL, true) ? "pass" : "blocked", "Set APP_URL to the exact HTTPS browser origin; HTTP is accepted only for localhost development.");
  if (env.APP_URL && httpUrl(env.APP_URL, true) && new URL(env.APP_URL).protocol === "http:") add("production-origin", "warning", "Local HTTP configuration does not establish HTTPS deployment or secure production cookies.");
  try {
    decodeDataEncryptionKey(env.DATA_ENCRYPTION_KEY || "");
    add("encryption", "pass", "The configured data key decodes to 32 bytes. Back up this key with the persistent database.");
  } catch { add("encryption", "blocked", "Configure DATA_ENCRYPTION_KEY as exactly 32 bytes of hex or base64. Existing encrypted records require their original key."); }
  add("database", env.DATABASE_PATH === ":memory:" ? "blocked" : "pass", "The configured SQLite path must be persistent rather than in-memory. Storage durability, backups and access controls are not verified by this check.");

  const appId = env.PRIVY_APP_ID || env.NEXT_PUBLIC_PRIVY_APP_ID;
  if (!appId || env.PRIVY_APP_ID && env.NEXT_PUBLIC_PRIVY_APP_ID && env.PRIVY_APP_ID !== env.NEXT_PUBLIC_PRIVY_APP_ID) {
    add("social-login", "blocked", "Configure matching server/client Privy app IDs for the same application.");
  } else {
    let verifier = false;
    if (env.PRIVY_VERIFICATION_KEY) {
      try { await importSPKI(env.PRIVY_VERIFICATION_KEY.replace(/\\n/g, "\n"), "ES256"); verifier = true; } catch {}
    } else if (env.PRIVY_JWKS_URL) verifier = httpUrl(env.PRIVY_JWKS_URL);
    add("social-login", verifier ? "pass" : "blocked", "Social login requires an ES256 public verification key or HTTPS JWKS URL. Configure allowed login methods and origins in Privy.");
  }
  add("social-profile", env.PRIVY_APP_SECRET ? "pass" : "blocked", "PRIVY_APP_SECRET is required for verified profile/email lookup and email-bound invitations; subject-only JWT authentication does not establish those capabilities.");

  add("near-network", ["mainnet", "testnet"].includes(network) ? "pass" : "blocked", "NEAR_NETWORK must be mainnet or testnet.");
  add("intents-network", network === "mainnet" ? "pass" : "blocked", "Cross-chain NEAR Intents funding and settlement require a mainnet treasury. Testnet checks do not establish cross-chain support.");
  const rpcUrl = env.NEAR_RPC_URL || `https://rpc.${network}.near.org`;
  add("near-rpc", httpUrl(rpcUrl, true) ? "pass" : "blocked", "Use an HTTPS NEAR RPC for the selected network; local HTTP endpoints are accepted for development only.");
  for (const [id, key, file] of artifacts) {
    try {
      const pin = reviewedArtifactHash(key, file, env, artifactDirectory);
      const path = resolve(artifactDirectory, file);
      if (existsSync(path) && base58.encode(createHash("sha256").update(readFileSync(path)).digest()) !== pin) throw new Error();
      pins.set(id, pin);
      add(`${id}-artifact`, "pass", env[key] ? `${key} is a valid pin and matches the local artifact when present.` : `The local reviewed artifact supplies ${key}; include this exact artifact or configure its hash in production.`);
    } catch { add(`${id}-artifact`, "blocked", `Build the reviewed contract or configure ${key}; a configured pin must match any local artifact.`); }
  }
  for (const [id, key] of [["factory", "NEAR_FACTORY_ID"], ["clearing", "NEAR_CLEARING_ID"]] as const) {
    add(`${id}-account`, env[key] && validNearAccount(env[key]) ? "pass" : "blocked", `Configure a deployed, initialized ${key} on the selected network.`);
  }
  if (env.NEAR_FACTORY_ID && env.NEAR_FACTORY_ID === env.NEAR_CLEARING_ID) add("contract-accounts", "blocked", "Factory and clearing require distinct deployment accounts.");
  try {
    const ai = privateAiConfig(env, nodeVersion);
    add("private-ai", ai.missing.length ? "blocked" : "pass", ai.missing.length ? `Configure valid private inference settings: ${ai.missing.join(", ")}.` : "Private inference configuration is present. Required model/gateway verification must still succeed on a real request.");
  } catch { add("private-ai", "blocked", "Private inference retention must be 0-30 days and attestation age 10000-300000 ms, using integer settings."); }

  const executorFields = ["RAZOR_EXECUTOR_ACCOUNT_ID", "RAZOR_EXECUTOR_TREASURY_ACCOUNT_ID", "RAZOR_EXECUTOR_NETWORK", "RAZOR_EXECUTOR_PRIVATE_KEY"];
  let workerReady = executorFields.every(key => Boolean(env[key]));
  if (workerReady) {
    try {
      const key = env.RAZOR_EXECUTOR_PRIVATE_KEY!;
      workerReady = validNearAccount(env.RAZOR_EXECUTOR_ACCOUNT_ID!) && validNearAccount(env.RAZOR_EXECUTOR_TREASURY_ACCOUNT_ID!) && env.RAZOR_EXECUTOR_ACCOUNT_ID !== env.RAZOR_EXECUTOR_TREASURY_ACCOUNT_ID && env.RAZOR_EXECUTOR_NETWORK === network && key.startsWith("ed25519:") && base58.decode(key.slice(8)).length === 64;
    } catch { workerReady = false; }
  }
  add("executor", workerReady ? "pass" : "blocked", "Automatic execution requires a dedicated executor account, its exact treasury account, matching network and an ed25519 key. Only an execute_payment function-call key is accepted remotely.");
  if (!env.RESEND_API_KEY && !env.NOTIFICATION_FROM_EMAIL) add("email", "disabled", "Optional email transport is disabled; in-app notifications remain available.");
  else add("email", env.RESEND_API_KEY && env.NOTIFICATION_FROM_EMAIL ? "pass" : "blocked", "Optional email requires both RESEND_API_KEY and NOTIFICATION_FROM_EMAIL. Domain verification and actual delivery remain separate.");

  if (options.remote && !failed("near-network") && !failed("near-rpc")) {
    const transport = options.fetch ?? fetch;
    const rpc = async <T>(method: string, params: unknown): Promise<T> => {
      const response = await transport(rpcUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: "razor-setup", method, params }), signal: AbortSignal.timeout(15000), cache: "no-store" });
      if (!response.ok) throw new Error();
      const payload = await response.json() as { error?: unknown; result?: T };
      if (payload.error || payload.result === undefined) throw new Error();
      return payload.result;
    };
    const view = async <T>(account: string, method: string): Promise<T> => {
      const value = await rpc<{result:number[]}>("query", { request_type: "call_function", finality: "final", account_id: account, method_name: method, args_base64: "e30=" });
      return JSON.parse(Buffer.from(value.result).toString()) as T;
    };
    let networkMatches = false;
    try {
      networkMatches = (await rpc<{chain_id:string}>("status", [])).chain_id === network;
      add("remote-network", networkMatches ? "pass" : "blocked", networkMatches ? "The RPC reports the selected NEAR network." : "The RPC reports another NEAR network. Contract checks were skipped.", "remote");
    } catch { add("remote-network", "blocked", "The NEAR RPC network could not be verified. No signing or transfers were attempted.", "remote"); }
    if (networkMatches) {
      let factoryToken: string | undefined;
      if (!failed("factory-account") && pins.has("factory") && pins.has("treasury")) {
        try {
          const account = env.NEAR_FACTORY_ID!;
          const code = await rpc<{code_hash:string}>("query", {request_type:"view_account", finality:"final", account_id:account});
          const factory = await view<{owner_id:string; token_contract:string; treasury_wasm_hash:string; paused:boolean; minimum_deposit:string; treasury_funding:string; factory_storage_fee:string}>(account, "get_config");
          if (code.code_hash !== pins.get("factory") || factory.treasury_wasm_hash !== pins.get("treasury") || !validNearAccount(factory.owner_id) || !validNearAccount(factory.token_contract) || typeof factory.paused !== "boolean" || network === "mainnet" && factory.token_contract !== NATIVE_USDC.near || !/^[1-9]\d*$/.test(factory.minimum_deposit) || !/^\d+$/.test(factory.treasury_funding) || !/^\d+$/.test(factory.factory_storage_fee) || BigInt(factory.minimum_deposit) !== BigInt(factory.treasury_funding) + BigInt(factory.factory_storage_fee)) throw new Error();
          factoryToken = factory.token_contract;
          add("remote-factory", factory.paused ? "blocked" : "pass", factory.paused ? "The reviewed factory is initialized but paused." : "Factory code, initialized configuration, embedded treasury hash, token and creation deposit match the reviewed deployment.", "remote");
        } catch { add("remote-factory", "blocked", "Factory code or initialized settings could not be matched to the reviewed artifact, token and deposit. Inspect deployment and initialization.", "remote"); }
      } else add("remote-factory", "not_checked", "Valid factory and artifact configuration is required before deployment verification.", "remote");
      if (!failed("clearing-account") && pins.has("clearing") && factoryToken) {
        try {
          const account = env.NEAR_CLEARING_ID!;
          const code = await rpc<{code_hash:string}>("query", {request_type:"view_account", finality:"final", account_id:account});
          const clearing = await view<{factory_id:string; token_contract:string; paused:boolean}>(account, "get_config");
          if (code.code_hash !== pins.get("clearing") || clearing.factory_id !== env.NEAR_FACTORY_ID || clearing.token_contract !== factoryToken || typeof clearing.paused !== "boolean") throw new Error();
          add("remote-clearing", clearing.paused ? "blocked" : "pass", clearing.paused ? "The reviewed clearing contract is initialized but paused." : "Clearing code, factory binding and settlement token match the reviewed deployment.", "remote");
        } catch { add("remote-clearing", "blocked", "Clearing code or initialized settings could not be matched to the factory and settlement token.", "remote"); }
      } else add("remote-clearing", "not_checked", "Verified factory and clearing configuration is required before clearing deployment verification.", "remote");
      if (workerReady && pins.has("treasury")) {
        try {
          const treasury = env.RAZOR_EXECUTOR_TREASURY_ACCOUNT_ID!, executor = env.RAZOR_EXECUTOR_ACCOUNT_ID!;
          const code = await rpc<{code_hash:string}>("query", {request_type:"view_account", finality:"final", account_id:treasury});
          const config = await view<{owner_id:string; token_contract:string; executors:string[]; approvers:string[]; paused:boolean}>(treasury, "get_config");
          if (code.code_hash !== pins.get("treasury") || config.owner_id === executor || !config.executors.includes(executor) || config.approvers.includes(executor) || config.paused || !validNearAccount(config.token_contract) || network === "mainnet" && config.token_contract !== NATIVE_USDC.near) throw new Error();
          const { KeyPairSigner } = await import("near-api-js");
          const publicKey = await KeyPairSigner.fromSecretKey(env.RAZOR_EXECUTOR_PRIVATE_KEY as `ed25519:${string}`).getPublicKey();
          const key = await rpc<{permission:unknown}>("query", {request_type:"view_access_key", finality:"final", account_id:executor, public_key:publicKey.toString()});
          const permission = key.permission && typeof key.permission === "object" && "FunctionCall" in key.permission ? key.permission.FunctionCall as {receiver_id:string; method_names:string[]} : null;
          if (!permission || permission.receiver_id !== treasury || permission.method_names.length !== 1 || permission.method_names[0] !== "execute_payment") throw new Error();
          add("remote-executor", "pass", "The reviewed treasury grants a dedicated executor role and the configured key is restricted to its execute_payment method. Company mandate and actual route approvals are still required.", "remote");
        } catch { add("remote-executor", "blocked", "The executor role, reviewed treasury, token or restricted access key could not be verified. No transaction was signed or broadcast.", "remote"); }
      } else add("remote-executor", "not_checked", "Complete worker configuration and a reviewed treasury hash are required before key-permission verification.", "remote");
    }
  } else add("remote-verification", "not_checked", "Run with --remote to read public NEAR network, deployed contracts and restricted executor permissions. No live workflows are performed.", "remote");
  for (const [id, message] of [
    ["social-journey", "Demonstrate real Google/email signup, linked NEAR owner setup, return access and provider recovery."],
    ["settlement-journey", "Demonstrate actual source funding, canonical credit, payout, backup, timeout, refund and partial recovery with final receipts."],
    ["executor-journey", "Demonstrate scheduled exact-route execution and interruption recovery under a real bounded mandate."],
    ["private-ai-journey", "Demonstrate required model/gateway verification, fictional document review and retention/deletion on a real configured request."],
    ["email-journey", "If email is enabled, verify delivery to an authorized recipient. Provider acceptance alone is insufficient."],
  ]) add(id, "not_checked", message, "workflow");
  return { configurationReady: !checks.some(check => check.stage === "configuration" && check.status === "blocked"), remoteChecksRequested: Boolean(options.remote), liveWorkflowsVerified: false, checks };
}
