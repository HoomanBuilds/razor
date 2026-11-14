import { base58 } from "@scure/base";
import { ApiError } from "./context";
import { validNearAccount } from "./payments/near";

export function describeContractUpgradePolicy(accountId: string, env: Partial<NodeJS.ProcessEnv> = process.env) {
  const mode = env.NEAR_CONTRACT_UPGRADE_POLICY || "immutable";
  if (mode === "immutable") {
    return {
      mode: "immutable" as const,
      upgradable: false,
      publicKeys: [] as string[],
      disclosure: "The configured policy requires a keyless contract with separately reviewed code. Configuration alone is not deployment verification.",
    };
  }
  if (mode !== "owner_controlled") throw new ApiError(503, "Choose immutable or owner_controlled for NEAR_CONTRACT_UPGRADE_POLICY", "UPGRADE_POLICY_INVALID");
  let pins: Record<string, string[]>;
  try {
    const raw = env.NEAR_CONTRACT_UPGRADE_KEYS || "";
    if (raw.length > 8192) throw new Error();
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    const entries = Object.entries(parsed);
    if (entries.length < 1 || entries.length > 16) throw new Error();
    for (const [account, keys] of entries) {
      if (!validNearAccount(account) || !Array.isArray(keys) || keys.length < 1 || keys.length > 4 || new Set(keys).size !== keys.length) throw new Error();
      for (const key of keys) {
        if (typeof key !== "string" || !key.startsWith("ed25519:") || base58.decode(key.slice(8)).length !== 32) throw new Error();
      }
    }
    pins = parsed as Record<string, string[]>;
  } catch {
    throw new ApiError(503, "Configure reviewed per-account public upgrade keys in NEAR_CONTRACT_UPGRADE_KEYS", "UPGRADE_POLICY_INVALID");
  }
  if (!Object.hasOwn(pins, accountId)) throw new ApiError(503, "This contract has no approved upgrade-key pin", "UPGRADE_KEY_PIN_REQUIRED");
  return {
    mode: "owner_controlled" as const,
    upgradable: true,
    publicKeys: [...pins[accountId]],
    disclosure: "Razor's operator can replace contract code and affect funds. Company signing keys and spending limits are separate and cannot prevent a malicious contract upgrade. Code and upgrade keys must match the reviewed pins.",
  };
}

export function assertContractUpgradeKeys(accountId: string, keys: unknown, env: Partial<NodeJS.ProcessEnv> = process.env): void {
  const policy = describeContractUpgradePolicy(accountId, env);
  if (!Array.isArray(keys)) throw new ApiError(409, "Contract access keys could not be verified", "UPGRADE_KEYS_UNVERIFIED");
  if (keys.length !== policy.publicKeys.length) throw new ApiError(409, "Contract access keys differ from the approved upgrade policy", "UPGRADE_KEYS_MISMATCH");
  const seen = new Set<string>();
  for (const key of keys) {
    if (!key || typeof key !== "object" || typeof key.public_key !== "string" || seen.has(key.public_key) || !policy.publicKeys.includes(key.public_key) || key.access_key?.permission !== "FullAccess") {
      throw new ApiError(409, "Contract access keys differ from the approved upgrade policy", "UPGRADE_KEYS_MISMATCH");
    }
    seen.add(key.public_key);
  }
}
