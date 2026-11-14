import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { base58 } from "@scure/base";
import { NATIVE_USDC } from "../../lib/native-usdc";
import { validNearAccount } from "../payments/near";

interface DeploymentInput {
  network: "mainnet" | "testnet";
  treasuryAccount: string;
  clearingAccount: string;
  ownerAccount: string;
  testnetToken?: string;
  artifactDirectory?: string;
  billingAccount?: string;
  billingIssuerPublicKey?: string;
}

interface Artifact {
  file: string;
  bytes: number;
  sha256: string;
  codeHash: string;
  environmentKey: string;
}

function artifact(directory: string, file: string, environmentKey: string, manifest: Artifact[]) {
  const bytes = readFileSync(resolve(directory, file));
  if (!bytes.subarray(0, 8).equals(Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]))) throw new Error(`Rebuild ${file}: invalid WebAssembly artifact`);
  const digest = createHash("sha256").update(bytes).digest();
  const value = { file, bytes: bytes.length, sha256: digest.toString("hex"), codeHash: base58.encode(digest), environmentKey };
  const recorded = manifest.filter(item => item.file === file);
  if (recorded.length !== 1 || Object.keys(value).some(key => value[key as keyof Artifact] !== recorded[0][key as keyof Artifact])) throw new Error(`Rebuild ${file}: artifact does not match its build manifest`);
  return { ...value, path: resolve(directory, file) };
}

function shellArgument(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function prepareDeployment(input: DeploymentInput) {
  if (!["mainnet", "testnet"].includes(input.network)) throw new Error("Select mainnet or testnet explicitly");
  if (Boolean(input.billingAccount) !== Boolean(input.billingIssuerPublicKey)) throw new Error("Supply both the billing account and its invoice issuer public key");
  if (input.billingIssuerPublicKey) {
    try {
      if (!input.billingIssuerPublicKey.startsWith("ed25519:") || base58.decode(input.billingIssuerPublicKey.slice(8)).length !== 32) throw new Error();
    } catch { throw new Error("Use an ed25519 public key for the billing invoice issuer"); }
  }
  const accounts = [input.treasuryAccount, input.clearingAccount, input.ownerAccount, ...(input.billingAccount ? [input.billingAccount] : [])];
  if (accounts.some(account => !validNearAccount(account))) throw new Error("Use valid treasury, clearing and owner NEAR accounts");
  if (new Set(accounts).size !== accounts.length) throw new Error("Treasury, clearing and recoverable owner accounts must be distinct");
  if (input.network === "mainnet" && accounts.some(account => account.endsWith(".testnet"))) throw new Error("Testnet account names cannot be used for this mainnet plan");
  if (input.network === "mainnet" && input.testnetToken) throw new Error("Mainnet uses canonical native USDC; do not supply a test token");
  const token = input.network === "mainnet" ? NATIVE_USDC.near : input.testnetToken;
  if (!token || !validNearAccount(token) || accounts.includes(token)) throw new Error("Select a separate testnet token contract explicitly");
  const directory = resolve(input.artifactDirectory ?? ".tools/wasm");
  const manifest = JSON.parse(readFileSync(resolve(directory, "manifest.json"), "utf8")) as { architecture?: string; treasuryStateVersion?: number; clearingStateVersion?: number; artifacts?: Artifact[] };
  if (manifest.architecture !== "shared_v1" || !Array.isArray(manifest.artifacts)) throw new Error("Rebuild shared treasury contracts to generate their shared_v1 artifact manifest");
  if (manifest.treasuryStateVersion !== 3) throw new Error("Rebuild the treasury state-version-3 artifact manifest. Claimable pools and standing mandates require fresh deployment accounts; no populated-state migration is supported");
  if (manifest.clearingStateVersion !== 2) throw new Error("Rebuild the clearing state-version-2 artifact manifest. Funded clearing requires a fresh empty clearing account; no populated-state migration is supported");
  const treasury = artifact(directory, "razor_treasury.wasm", "NEAR_TREASURY_CODE_HASH", manifest.artifacts);
  const clearing = artifact(directory, "razor_clearing.wasm", "NEAR_CLEARING_CODE_HASH", manifest.artifacts);
  const billing = input.billingAccount ? artifact(directory, "razor_billing.wasm", "RAZOR_BILLING_CODE_HASH", manifest.artifacts) : null;
  const deployments: {accountId:string;artifact:ReturnType<typeof artifact>;args:Record<string,string>}[] = [
    { accountId: input.treasuryAccount, artifact: treasury, args: { owner_id: input.ownerAccount, token_contract: token } },
    { accountId: input.clearingAccount, artifact: clearing, args: { owner_id: input.ownerAccount, treasury_id: input.treasuryAccount, token_contract: token } },
  ];
  if (billing && input.billingAccount && input.billingIssuerPublicKey) deployments.push({ accountId: input.billingAccount, artifact: billing, args: { owner_id: input.ownerAccount, token_contract: token, network: input.network, issuer_public_key: input.billingIssuerPublicKey } });
  const steps = deployments.map(step => {
    const argv = ["contract", "deploy", step.accountId, "use-file", step.artifact.path, "with-init-call", "new", "json-args", JSON.stringify(step.args), "prepaid-gas", "100 Tgas", "attached-deposit", "0 NEAR", "network-config", input.network, "sign-with-keychain", "send"];
    return { ...step, signerAccountId: step.accountId, atomicInitialization: true, command: "near", argv, shellCommand: ["near", ...argv.map(shellArgument)].join(" ") };
  });
  return {
    mode: "unsigned_deployment_plan" as const,
    architecture: "shared_v1" as const,
    treasuryStateVersion: 3,
    clearingStateVersion: 2,
    freshAccountsOnly: true,
    populatedStateMigrationSupported: false,
    network: input.network,
    settlementEnabled: input.network === "mainnet",
    tokenContract: token,
    deployed: false,
    accountsVerified: false,
    requirements: ["Create and fund fresh deployment accounts with owner-controlled signing access.", "Verify each target has no contract code or application state. Treasury state version 3 adds distribution and cancellation collections and is incompatible with populated version-1 or version-2 company state. This plan does not migrate existing contracts.", "Review storage stake and gas costs with the CLI before signing. Code is deployed once; each company later funds only its shared-state allowance and transaction gas.", "Deploy and initialize each contract atomically, then run the remote setup check before registering companies."],
    artifacts: [treasury, clearing, ...(billing ? [billing] : [])],
    steps,
    optionalCashClearingSetup: {
      enabledByDeployment: false,
      completed: false,
      signerAccountId: input.ownerAccount,
      storageRegistration: { receiverId: token, methodName: "storage_deposit", args: { account_id: input.clearingAccount, registration_only: true }, gas: "30000000000000", requiresLiveStorageQuote: true, depositQuote: { methodName: "storage_balance_bounds", args: {}, field: "min" }, note: "Inspect storage_balance_of first. Register the clearing contract only if needed, using the token's live minimum storage deposit; this unsigned plan does not quote or spend it." },
      enableCash: { receiverId: input.clearingAccount, methodName: "enable_cash", args: { network: input.network, testnet_token_contract: input.network === "testnet" ? token : null }, gas: "30000000000000", deposit: "1", note: "Optional one-time owner call after verified atomic deployment and token registration. Native USDC deposits, company storage, withdrawals and gas remain separate actions." },
      freshStateRequired: true,
      missingCallbackPolicy: "Keep the original withdrawal pending. No timeout or owner assertion restores it.",
    },
    keyRetirement: deployments.map(step => ({accountId:step.accountId, required:true, verified:false, action:"remove_all_access_keys_after_verification", prerequisites:["Verify deployed code and atomic initialization against this plan.", "Register token storage and configure required recoverable owner roles.", "Back up the reviewed artifacts and ownership details."], verification:{request_type:"view_access_key_list",account_id:step.accountId,finality:"final",expected_keys:[]}, consequence:"Removing every access key makes this deployed code immutable. Contract owner roles remain available through their separate owner accounts; code upgrades and account deletion are unavailable."})),
    environment: { NEAR_NETWORK: input.network, NEAR_TREASURY_ID: input.treasuryAccount, NEAR_TREASURY_CODE_HASH: treasury.codeHash, NEAR_CLEARING_ID: input.clearingAccount, NEAR_CLEARING_CODE_HASH: clearing.codeHash, ...(billing ? { RAZOR_BILLING_CONTRACT_ID: input.billingAccount!, RAZOR_BILLING_CODE_HASH: billing.codeHash } : {}) },
  };
}
