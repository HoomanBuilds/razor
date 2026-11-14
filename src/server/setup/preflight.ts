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
import { billingIssuer, billingSettings } from "../billing/chain";
import { assertContractUpgradeKeys, describeContractUpgradePolicy } from "../near-upgrade-policy";

type Status = "pass" | "blocked" | "warning" | "not_checked" | "disabled";
interface Check { id: string; stage: "configuration" | "remote" | "workflow"; status: Status; message: string }
interface Options { env?: NodeJS.ProcessEnv; nodeVersion?: string; artifactDirectory?: string; remote?: boolean; fetch?: typeof fetch }
const artifacts = [
  ["treasury", "NEAR_TREASURY_CODE_HASH", "razor_treasury.wasm"],
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
    if (id === "clearing" && !env.NEAR_CLEARING_ID) {
      add("clearing-artifact", "disabled", "Business clearing is not configured. Basic treasury funding, payments and recovery do not require its artifact.");
      continue;
    }
    try {
      const pin = reviewedArtifactHash(key, file, env, artifactDirectory);
      const path = resolve(artifactDirectory, file);
      if (existsSync(path) && base58.encode(createHash("sha256").update(readFileSync(path)).digest()) !== pin) throw new Error();
      pins.set(id, pin);
      add(`${id}-artifact`, "pass", env[key] ? `${key} is a valid pin and matches the local artifact when present.` : `The local reviewed artifact supplies ${key}; include this exact artifact or configure its hash in production.`);
    } catch { add(`${id}-artifact`, "blocked", `Build the reviewed contract or configure ${key}; a configured pin must match any local artifact.`); }
  }
  for (const [id, key] of [["treasury", "NEAR_TREASURY_ID"], ["clearing", "NEAR_CLEARING_ID"]] as const) {
    if (id === "clearing" && !env[key]) {
      add("clearing-account", "disabled", "Business clearing is not configured; basic company payments remain available after treasury setup.");
      continue;
    }
    add(`${id}-account`, env[key] && validNearAccount(env[key]) ? "pass" : "blocked", `Configure a deployed, initialized ${key} on the selected network.`);
  }
  if (env.NEAR_TREASURY_ID && env.NEAR_TREASURY_ID === env.NEAR_CLEARING_ID) add("contract-accounts", "blocked", "Shared treasury and clearing require distinct deployment accounts.");
  const privateAiConfigured = ["NEAR_AI_API_KEY", "NEAR_AI_MODEL", "NEAR_AI_MODEL_COMPOSE_SHA256", "NEAR_AI_GATEWAY_COMPOSE_SHA256"].some(key => Boolean(env[key]));
  if (!privateAiConfigured) add("private-ai", "disabled", "Optional private AI is not configured. Manual invoices, payroll, payments and recovery remain available without AI credits.");
  else try {
    const ai = privateAiConfig(env, nodeVersion);
    add("private-ai", ai.missing.length ? "blocked" : "pass", ai.missing.length ? `Configure valid private inference settings: ${ai.missing.join(", ")}.` : "Private inference configuration is present. Required model/gateway verification must still succeed on a real request.");
  } catch { add("private-ai", "blocked", "Private inference retention must be 0-30 days and attestation age 10000-300000 ms, using integer settings."); }

  const executorFields = ["RAZOR_EXECUTOR_ACCOUNT_ID", "RAZOR_EXECUTOR_TREASURY_ACCOUNT_ID", "RAZOR_EXECUTOR_NETWORK", "RAZOR_EXECUTOR_PRIVATE_KEY", "RAZOR_EXECUTOR_COMPANY_ID"];
  const executorConfigured = executorFields.some(key => Boolean(env[key]));
  let workerReady = executorFields.every(key => Boolean(env[key]));
  if (workerReady) {
    try {
      const key = env.RAZOR_EXECUTOR_PRIVATE_KEY!;
      workerReady = validNearAccount(env.RAZOR_EXECUTOR_ACCOUNT_ID!) && validNearAccount(env.RAZOR_EXECUTOR_TREASURY_ACCOUNT_ID!) && env.RAZOR_EXECUTOR_ACCOUNT_ID !== env.RAZOR_EXECUTOR_TREASURY_ACCOUNT_ID && env.RAZOR_EXECUTOR_NETWORK === network && env.RAZOR_EXECUTOR_TREASURY_ACCOUNT_ID === env.NEAR_TREASURY_ID && /^[a-zA-Z0-9_-]{8,100}:[a-f0-9]{16}$/.test(env.RAZOR_EXECUTOR_COMPANY_ID!) && key.startsWith("ed25519:") && base58.decode(key.slice(8)).length === 64;
    } catch { workerReady = false; }
  }
  add("executor", !executorConfigured ? "disabled" : workerReady ? "pass" : "blocked", !executorConfigured ? "Optional automatic execution is disabled until a real company has a dedicated restricted executor and owner-approved grant. Manual wallet-authorized payments remain available." : "Automatic execution requires a dedicated executor account, the shared treasury account, exact company ID, matching network and an ed25519 key. Only an execute_payment function-call key is accepted remotely.");
  if (!env.RESEND_API_KEY && !env.NOTIFICATION_FROM_EMAIL) add("email", "disabled", "Optional email transport is disabled; in-app notifications remain available.");
  else add("email", env.RESEND_API_KEY && env.NOTIFICATION_FROM_EMAIL ? "pass" : "blocked", "Optional email requires both RESEND_API_KEY and NOTIFICATION_FROM_EMAIL. Domain verification and actual delivery remain separate.");

  const billingMode=env.RAZOR_BILLING_MODE || "pilot";
  add("billing-mode",billingMode==="pilot"?"warning":billingMode==="enforced"?"pass":"blocked","Pilot mode grants bounded complimentary Pro access. Enforced mode requires a paid period for new commercial operations; neither mode charges wallets automatically.");
  let billingExpected: (ReturnType<typeof billingSettings> & {issuerPublicKey:string}) | null=null;
  if(billingMode==="enforced" || ["RAZOR_BILLING_CONTRACT_ID","RAZOR_BILLING_CODE_HASH","RAZOR_BILLING_ISSUER_PRIVATE_KEY","RAZOR_BILLING_TESTNET_TOKEN_CONTRACT"].some(key=>Boolean(env[key]))) {
    try {
      const settings=billingSettings(env,artifactDirectory),{publicKey}=billingIssuer(env);
      if([env.NEAR_TREASURY_ID,env.NEAR_CLEARING_ID].includes(settings.billingContract))throw new Error();
      const path=resolve(artifactDirectory,"razor_billing.wasm");
      if(existsSync(path) && base58.encode(createHash("sha256").update(readFileSync(path)).digest())!==settings.codeHash)throw new Error();
      billingExpected={...settings,issuerPublicKey:publicKey};
      add("billing-checkout","pass","Billing contract, token, reviewed code and dedicated quote issuer are configured. The issuer key only signs subscription offers; it cannot debit customer wallets.");
    }catch{add("billing-checkout","blocked","Configure the dedicated billing contract, reviewed code hash and matching ed25519 invoice issuer key; testnet also requires its explicit billing token. Existing money recovery remains available.");}
  }else add("billing-checkout","disabled","Paid checkout is not configured. Complimentary pilot access is not paid revenue.");

  try {
    const accounts = [env.NEAR_TREASURY_ID, env.NEAR_CLEARING_ID, env.RAZOR_BILLING_CONTRACT_ID].filter((account): account is string => Boolean(account));
    const policy = describeContractUpgradePolicy(accounts[0] || "unconfigured.near", env);
    for (const account of accounts.slice(1)) describeContractUpgradePolicy(account, env);
    add("contract-upgrade-policy", policy.upgradable ? "warning" : "pass", policy.disclosure);
  } catch {
    add("contract-upgrade-policy", "blocked", "Configure an explicit supported contract upgrade policy and exact approved public keys for each configured upgradable contract. No private keys belong in upgrade-policy settings.");
  }

  if (options.remote && appId && !failed("social-login")) {
    try {
      const response = await (options.fetch ?? fetch)(`https://auth.privy.io/api/v1/apps/${encodeURIComponent(appId)}`, {
        headers: { "privy-app-id": appId }, cache: "no-store", redirect: "error", signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) throw new Error();
      const app = await response.json() as { id?: unknown; google_oauth?: unknown; email_auth?: unknown; allowed_domains?: unknown };
      if (app.id !== appId || typeof app.google_oauth !== "boolean" || typeof app.email_auth !== "boolean" || !Array.isArray(app.allowed_domains) || app.allowed_domains.some(domain => typeof domain !== "string")) throw new Error();
      add("remote-google-login", app.google_oauth ? "pass" : "blocked", app.google_oauth ? "Google login is enabled in the configured Privy app. User authorization and Razor session creation still require a real sign-in." : "Google login is disabled in the configured Privy app. Enable Google in the app's Login Methods / Authentication dashboard and save changes. A visible Google button or local credentials do not enable this provider.", "remote");
      add("remote-email-login", app.email_auth ? "pass" : "blocked", app.email_auth ? "Email login is enabled in the configured Privy app. Actual OTP delivery and sign-in remain unverified." : "Email login is disabled in the configured Privy app. Enable email in the app's Login Methods / Authentication dashboard and save changes.", "remote");
      const originAllowed = Boolean(env.APP_URL && app.allowed_domains.includes(new URL(env.APP_URL).origin));
      add("remote-login-origin", originAllowed ? "pass" : "blocked", originAllowed ? "The configured browser origin is explicitly allowed by the Privy app." : "Add the exact APP_URL origin to the configured Privy app's allowed domains and save changes.", "remote");
    } catch {
      add("remote-social-login", "blocked", "The configured Privy app's public login methods and allowed origins could not be verified. No credentials or OAuth authorization were sent.", "remote");
    }
  } else add("remote-social-login", "not_checked", "Run with --remote and valid social login configuration to read Privy's saved provider settings and allowed origins. This does not sign in a user.", "remote");

  if (options.remote && !failed("near-network") && !failed("near-rpc")) {
    const transport = options.fetch ?? fetch;
    const rpc = async <T>(method: string, params: unknown): Promise<T> => {
      const response = await transport(rpcUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: "razor-setup", method, params }), signal: AbortSignal.timeout(15000), cache: "no-store" });
      if (!response.ok) throw new Error();
      const payload = await response.json() as { error?: unknown; result?: T };
      if (payload.error || payload.result === undefined) throw new Error();
      return payload.result;
    };
    let snapshot: Promise<{hash: string; height: number}> | undefined;
    const finalizedQuery = async <T>(params: Record<string, unknown>): Promise<T> => {
      snapshot ??= rpc<{header:{hash:string; height:number}}>("block", {finality:"final"}).then(({header}) => {
        if (!header || !Number.isSafeInteger(header.height) || header.height <= 0 || base58.decode(header.hash).length !== 32) throw new Error();
        return {hash:header.hash, height:header.height};
      });
      const block = await snapshot;
      const {finality, block_id, ...query} = params;
      const value = await rpc<T & {block_hash:string; block_height:number}>("query", {...query, block_id:block.hash});
      if (value.block_hash !== block.hash || value.block_height !== block.height) throw new Error();
      return value;
    };
    const view = async <T>(account: string, method: string, args: object = {}): Promise<T> => {
      const value = await finalizedQuery<{result:number[]}>({ request_type: "call_function", account_id: account, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString("base64") });
      return JSON.parse(Buffer.from(value.result).toString()) as T;
    };
    let networkMatches = false;
    try {
      networkMatches = (await rpc<{chain_id:string}>("status", [])).chain_id === network;
      add("remote-network", networkMatches ? "pass" : "blocked", networkMatches ? "The RPC reports the selected NEAR network." : "The RPC reports another NEAR network. Contract checks were skipped.", "remote");
    } catch { add("remote-network", "blocked", "The NEAR RPC network could not be verified. No signing or transfers were attempted.", "remote"); }
    if (networkMatches) {
      if(billingExpected) {
        try {
          const account = billingExpected.billingContract;
          const code = await finalizedQuery<{code_hash:string; global_contract_account_id?:string|null}>({request_type:"view_account", account_id:account});
          const keys = await finalizedQuery<{keys:unknown[]}>({request_type:"view_access_key_list", account_id:account});
          assertContractUpgradeKeys(account, keys.keys, env);
          const config=await view<{version:number;owner_id:string;network:string;token_contract:string;issuer_public_key:string;paused:boolean}>(account,"get_config"),storage=await view<{total:string}|null>(billingExpected.tokenContract,"storage_balance_of",{account_id:account});
          if(code.code_hash!==billingExpected.codeHash || code.global_contract_account_id != null || config.version!==1 || config.network!==network || config.token_contract!==billingExpected.tokenContract || config.issuer_public_key!==billingExpected.issuerPublicKey || !validNearAccount(config.owner_id) || config.owner_id===billingExpected.billingContract || config.paused!==false || !storage || !/^[1-9]\d*$/.test(storage.total))throw new Error();
          add("remote-billing","pass","At one final NEAR block, billing code, configured upgrade-key policy, network, token, quote issuer and token-storage registration match. No checkout or subscription payment was sent.","remote");
        }catch{add("remote-billing","blocked","The billing deployment, upgrade-key policy, invoice issuer, pause state or token storage could not be verified. Do not enable paid checkout until these match.","remote");}
      }else add("remote-billing","not_checked","Complete billing checkout configuration before reading its deployment.","remote");
      let treasuryToken: string | undefined;
      if (!failed("treasury-account") && pins.has("treasury")) {
        try {
          const account = env.NEAR_TREASURY_ID!;
          const code = await finalizedQuery<{code_hash:string; global_contract_account_id?:string|null}>({request_type:"view_account", account_id:account});
          const keys = await finalizedQuery<{keys:unknown[]}>({request_type:"view_access_key_list", account_id:account});
          assertContractUpgradeKeys(account, keys.keys, env);
          const platform = await view<{architecture:string;version:number;owner_id:string; token_contract:string; paused:boolean; minimum_registration_deposit:string}>(account, "get_platform_config");
          if (code.code_hash !== pins.get("treasury") || code.global_contract_account_id != null || platform.architecture !== "shared_v1" || platform.version !== 1 || !validNearAccount(platform.owner_id) || platform.owner_id === account || !validNearAccount(platform.token_contract) || typeof platform.paused !== "boolean" || network === "mainnet" && platform.token_contract !== NATIVE_USDC.near || !/^[1-9]\d*$/.test(platform.minimum_registration_deposit)) throw new Error();
          const storage = await view<{total:string}|null>(platform.token_contract, "storage_balance_of", {account_id:account});
          if (!storage || !/^[1-9]\d*$/.test(storage.total)) throw new Error();
          treasuryToken = platform.token_contract;
          add("remote-treasury", platform.paused ? "blocked" : "pass", platform.paused ? "The reviewed shared treasury is initialized but paused." : "At one final NEAR block, shared treasury code, configured upgrade-key policy, architecture, settlement token, registration allowance and token-storage registration match. No per-company code deployment is required.", "remote");
        } catch { add("remote-treasury", "blocked", "Shared treasury code, configured upgrade-key policy, initialized platform configuration or token-storage registration could not be verified at one final block.", "remote"); }
      } else add("remote-treasury", "not_checked", "Valid shared treasury account and artifact configuration are required before deployment verification.", "remote");
      if (env.NEAR_CLEARING_ID && !failed("clearing-account") && pins.has("clearing") && treasuryToken) {
        try {
          const account = env.NEAR_CLEARING_ID!;
          const code = await finalizedQuery<{code_hash:string; global_contract_account_id?:string|null}>({request_type:"view_account", account_id:account});
          const keys = await finalizedQuery<{keys:unknown[]}>({request_type:"view_access_key_list", account_id:account});
          assertContractUpgradeKeys(account, keys.keys, env);
          const clearing = await view<{treasury_id:string; token_contract:string; paused:boolean}>(account, "get_config");
          if (code.code_hash !== pins.get("clearing") || code.global_contract_account_id != null || clearing.treasury_id !== env.NEAR_TREASURY_ID || clearing.token_contract !== treasuryToken || typeof clearing.paused !== "boolean") throw new Error();
          add("remote-clearing", clearing.paused ? "blocked" : "pass", clearing.paused ? "The reviewed clearing contract is initialized but paused." : "At one final NEAR block, clearing code, configured upgrade-key policy, shared treasury binding and settlement token match the reviewed deployment.", "remote");
        } catch { add("remote-clearing", "blocked", "Clearing code, configured upgrade-key policy or initialized settings could not be matched to the shared treasury and settlement token at one final block.", "remote"); }
      } else add("remote-clearing", env.NEAR_CLEARING_ID ? "not_checked" : "disabled", "Clearing deployment checks apply only when business clearing is configured; they do not gate basic treasury payments.", "remote");
      if (workerReady && pins.has("treasury")) {
        try {
          const treasury = env.RAZOR_EXECUTOR_TREASURY_ACCOUNT_ID!, executor = env.RAZOR_EXECUTOR_ACCOUNT_ID!;
          const code = await finalizedQuery<{code_hash:string; global_contract_account_id?:string|null}>({request_type:"view_account", account_id:treasury});
          const keys = await finalizedQuery<{keys:unknown[]}>({request_type:"view_access_key_list", account_id:treasury});
          assertContractUpgradeKeys(treasury, keys.keys, env);
          const config = await view<{architecture:string;company_id:string;owner_id:string; token_contract:string; executors:string[]; approvers:string[]; paused:boolean}>(treasury, "get_config", {company_id:env.RAZOR_EXECUTOR_COMPANY_ID});
          if (code.code_hash !== pins.get("treasury") || code.global_contract_account_id != null || config.architecture !== "shared_v1" || config.company_id !== env.RAZOR_EXECUTOR_COMPANY_ID || config.owner_id === executor || !config.executors.includes(executor) || config.approvers.includes(executor) || config.paused || !validNearAccount(config.token_contract) || network === "mainnet" && config.token_contract !== NATIVE_USDC.near) throw new Error();
          const { KeyPairSigner } = await import("near-api-js");
          const publicKey = await KeyPairSigner.fromSecretKey(env.RAZOR_EXECUTOR_PRIVATE_KEY as `ed25519:${string}`).getPublicKey();
          const key = await finalizedQuery<{permission:unknown}>({request_type:"view_access_key", account_id:executor, public_key:publicKey.toString()});
          const permission = key.permission && typeof key.permission === "object" && "FunctionCall" in key.permission ? key.permission.FunctionCall as {receiver_id:string; method_names:string[]} : null;
          if (!permission || permission.receiver_id !== treasury || permission.method_names.length !== 1 || permission.method_names[0] !== "execute_payment") throw new Error();
          add("remote-executor", "pass", "The reviewed treasury grants a dedicated executor role and the configured key is restricted to its execute_payment method. Company mandate and actual route approvals are still required.", "remote");
        } catch { add("remote-executor", "blocked", "The executor role, reviewed treasury, token or restricted access key could not be verified. No transaction was signed or broadcast.", "remote"); }
      } else add("remote-executor", executorConfigured ? "not_checked" : "disabled", "Complete worker configuration and a reviewed treasury hash are required before key-permission verification.", "remote");
    }
  } else add("remote-verification", "not_checked", "Run with --remote to read public NEAR network, deployed contracts and restricted executor permissions. No live workflows are performed.", "remote");
  for (const [id, message] of [
    ["social-journey", "Demonstrate real Google/email signup, linked NEAR owner setup, return access and provider recovery."],
    ["settlement-journey", "Demonstrate actual source funding, canonical credit, payout, backup, timeout, refund and partial recovery with final receipts."],
    ["executor-journey", "Demonstrate scheduled exact-route execution and interruption recovery under a real bounded mandate."],
    ["private-ai-journey", "Demonstrate required model/gateway verification, fictional document review and retention/deletion on a real configured request."],
    ["email-journey", "If email is enabled, verify delivery to an authorized recipient. Provider acceptance alone is insufficient."],
    ["subscription-journey", "Demonstrate a real subscription checkout, duplicate return, renewal, cancellation, refund and preserved financial recovery with final billing receipts."],
  ]) add(id, "not_checked", message, "workflow");
  return { configurationReady: !checks.some(check => check.stage === "configuration" && check.status === "blocked"), remoteChecksRequested: Boolean(options.remote), liveWorkflowsVerified: false, checks };
}
