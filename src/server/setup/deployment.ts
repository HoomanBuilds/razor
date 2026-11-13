import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { base58 } from "@scure/base";
import { NATIVE_USDC } from "../../lib/native-usdc";
import { validNearAccount } from "../payments/near";

interface DeploymentInput {
  network: "mainnet" | "testnet";
  factoryAccount: string;
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
  const accounts = [input.factoryAccount, input.clearingAccount, input.ownerAccount, ...(input.billingAccount ? [input.billingAccount] : [])];
  if (accounts.some(account => !validNearAccount(account))) throw new Error("Use valid factory, clearing and owner NEAR accounts");
  if (new Set(accounts).size !== accounts.length) throw new Error("Factory, clearing and recoverable owner accounts must be distinct");
  if (input.network === "mainnet" && accounts.some(account => account.endsWith(".testnet"))) throw new Error("Testnet account names cannot be used for this mainnet plan");
  if (input.network === "mainnet" && input.testnetToken) throw new Error("Mainnet uses canonical native USDC; do not supply a test token");
  const token = input.network === "mainnet" ? NATIVE_USDC.near : input.testnetToken;
  if (!token || !validNearAccount(token) || accounts.includes(token)) throw new Error("Select a separate testnet token contract explicitly");
  const directory = resolve(input.artifactDirectory ?? ".tools/wasm");
  const manifest = JSON.parse(readFileSync(resolve(directory, "manifest.json"), "utf8")) as { artifacts?: Artifact[] };
  if (!Array.isArray(manifest.artifacts)) throw new Error("Rebuild contracts to generate their artifact manifest");
  const treasury = artifact(directory, "razor_treasury.wasm", "NEAR_TREASURY_CODE_HASH", manifest.artifacts);
  const factory = artifact(directory, "razor_factory.wasm", "NEAR_FACTORY_CODE_HASH", manifest.artifacts);
  const clearing = artifact(directory, "razor_clearing.wasm", "NEAR_CLEARING_CODE_HASH", manifest.artifacts);
  const billing = input.billingAccount ? artifact(directory, "razor_billing.wasm", "RAZOR_BILLING_CODE_HASH", manifest.artifacts) : null;
  if (!readFileSync(factory.path).includes(readFileSync(treasury.path))) throw new Error("Rebuild the factory with this exact treasury artifact");
  const deployments: {accountId:string;artifact:ReturnType<typeof artifact>;args:Record<string,string>}[] = [
    { accountId: input.factoryAccount, artifact: factory, args: { owner_id: input.ownerAccount, token_contract: token } },
    { accountId: input.clearingAccount, artifact: clearing, args: { owner_id: input.ownerAccount, factory_id: input.factoryAccount, token_contract: token } },
  ];
  if (billing && input.billingAccount && input.billingIssuerPublicKey) deployments.push({ accountId: input.billingAccount, artifact: billing, args: { owner_id: input.ownerAccount, token_contract: token, network: input.network, issuer_public_key: input.billingIssuerPublicKey } });
  const steps = deployments.map(step => {
    const argv = ["contract", "deploy", step.accountId, "use-file", step.artifact.path, "with-init-call", "new", "json-args", JSON.stringify(step.args), "prepaid-gas", "100 Tgas", "attached-deposit", "0 NEAR", "network-config", input.network, "sign-with-keychain", "send"];
    return { ...step, signerAccountId: step.accountId, atomicInitialization: true, command: "near", argv, shellCommand: ["near", ...argv.map(shellArgument)].join(" ") };
  });
  return {
    mode: "unsigned_deployment_plan" as const,
    network: input.network,
    settlementEnabled: input.network === "mainnet",
    tokenContract: token,
    deployed: false,
    accountsVerified: false,
    requirements: ["Create and fund fresh deployment accounts with owner-controlled signing access.", "Verify each target has no contract code or application state; this plan does not migrate existing contracts.", "Review storage stake and gas costs with the CLI before signing.", "Deploy and initialize each contract atomically, then run the remote setup check before creating company treasuries."],
    artifacts: [treasury, factory, clearing, ...(billing ? [billing] : [])],
    steps,
    environment: { NEAR_NETWORK: input.network, NEAR_FACTORY_ID: input.factoryAccount, NEAR_FACTORY_CODE_HASH: factory.codeHash, NEAR_TREASURY_CODE_HASH: treasury.codeHash, NEAR_CLEARING_ID: input.clearingAccount, NEAR_CLEARING_CODE_HASH: clearing.codeHash, ...(billing ? { RAZOR_BILLING_CONTRACT_ID: input.billingAccount!, RAZOR_BILLING_CODE_HASH: billing.codeHash } : {}) },
  };
}
