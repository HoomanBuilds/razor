import { base58 } from "@scure/base";
export interface PublicDemoBuildIdentity {
  sourceRevision?: string;
  sourceUrl?: string;
  publisher?: string;
  builtAt?: string;
  contractStateVersions?: Partial<
    Record<"treasury" | "clearing" | "billing" | "credit", number>
  >;
}
const account = (value?: string) =>
  value &&
  value.length >= 2 &&
  value.length <= 64 &&
  /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/.test(value)
    ? value
    : null;
const codeHash = (value?: string) => {
  try {
    return value && base58.decode(value).length === 32 ? value : null;
  } catch {
    return null;
  }
};
function publicUrl(value?: string) {
  try {
    if (!value || value.length > 2048) return null;
    const url = new URL(value);
    return url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.search
      ? url.href
      : null;
  } catch {
    return null;
  }
}
export function publicDemoIdentity(
  published: PublicDemoBuildIdentity = {},
  env: NodeJS.ProcessEnv = process.env,
) {
  const revision =
    published.sourceRevision &&
    /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(published.sourceRevision)
      ? published.sourceRevision
      : null;
  const publisher =
    published.publisher &&
    published.publisher.length <= 120 &&
    !/[\u0000-\u001f]/.test(published.publisher)
      ? published.publisher
      : null;
  const builtAt =
    published.builtAt && Number.isFinite(Date.parse(published.builtAt))
      ? new Date(published.builtAt).toISOString()
      : null;
  const contracts = (
    [
      ["treasury", "NEAR_TREASURY_ID", "NEAR_TREASURY_CODE_HASH"],
      ["clearing", "NEAR_CLEARING_ID", "NEAR_CLEARING_CODE_HASH"],
      ["billing", "RAZOR_BILLING_CONTRACT_ID", "RAZOR_BILLING_CODE_HASH"],
      ["credit", "NEAR_CREDIT_ID", "NEAR_CREDIT_CODE_HASH"],
    ] as const
  ).map(([kind, idField, hashField]) => {
    const state = published.contractStateVersions?.[kind];
    return {
      kind,
      accountId: account(env[idField]),
      expectedCodeHash: codeHash(env[hashField]),
      stateVersion:
        state && Number.isSafeInteger(state) && state > 0 && state < 100
          ? state
          : null,
      verification: "unavailable" as const,
    };
  });
  return {
    sourceRevision: revision,
    sourceUrl: publicUrl(published.sourceUrl),
    publisher,
    builtAt,
    network:
      env.NEAR_NETWORK === "mainnet" || env.NEAR_NETWORK === "testnet"
        ? env.NEAR_NETWORK
        : null,
    contracts,
    verification: "unavailable" as const,
    limitation:
      "Published source/build metadata and configured pins are declarations. This preview performs no independent release-signature, deployed-code, access-key, hardware or network verification.",
  };
}
export type PublicDemoIdentity = ReturnType<typeof publicDemoIdentity>;
