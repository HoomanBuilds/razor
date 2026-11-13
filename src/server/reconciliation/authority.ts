import { ApiError } from "../context";
import { rows } from "../db";
import { validNearAccount, view } from "../payments/near";
import type { TreasuryConfig } from "../payments/types";

export async function recoveryAuthority(config: TreasuryConfig, userId: string) {
  if (config.architecture !== "shared_v1") return { shared: false, refundReporter: null, refundAccounts: [] as string[] };
  const platform = await view<{ architecture: string; token_contract: string; refund_reporter: string | null }>(config, "get_platform_config");
  if (platform.architecture !== "shared_v1" || platform.token_contract !== config.token_contract || platform.refund_reporter !== null && !validNearAccount(platform.refund_reporter)) throw new ApiError(409, "The shared treasury recovery authority could not be verified", "REFUND_AUTHORITY_UNVERIFIED");
  const wallets = rows<{ address: string }>("SELECT address FROM linked_wallets WHERE user_id=? AND family='near' AND network=?", userId, config.network);
  return { shared: true, refundReporter: platform.refund_reporter, refundAccounts: wallets.filter(wallet => wallet.address === platform.refund_reporter).map(wallet => wallet.address) };
}
