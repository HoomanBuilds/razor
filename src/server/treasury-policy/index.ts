import { Hono } from "hono";
import { z } from "zod";
import { ApiError, requirePermission, type AccessContext, type AppEnv } from "../context";
import { getDb, row } from "../db";
import { getTreasury, setNetwork, syncTreasury } from "../payments";
import { nativeUsdc, getSupportedTokens } from "../payments/intents";
import { view, validNearAccount } from "../payments/near";
import { BACKUP_NETWORKS } from "../payments/policy";
import type { TreasuryConfig, WalletTransaction } from "../payments/types";
import { atomic } from "../../lib/money";
import { activity } from "../business/service";

interface Policy { owner_id: string; token_contract: string; paused: boolean; per_payment_limit: string; daily_limit: string; policy_version: string; settlement_reporter: string | null; approvers: string[]; executors: string[] }
const account = z.string().refine(validNearAccount, "Enter a valid NEAR account");
const amount = z.string().refine((value) => { try { atomic(value); return true; } catch { return false; } });
const changeInput = z.discriminatedUnion("action", [
  z.object({ action: z.literal("pause"), paused: z.boolean() }),
  z.object({ action: z.literal("limits"), perPaymentLimit: amount, dailyLimit: amount }),
  z.object({ action: z.literal("role"), accountId: account, role: z.enum(["approver", "executor"]), enabled: z.boolean() }),
  z.object({ action: z.literal("reporter"), accountId: account.nullable() }),
  z.object({ action: z.literal("backup"), network: z.enum(BACKUP_NETWORKS), enabled: z.boolean() }),
  z.object({ action: z.literal("withdraw"), receiverId: account, amount }),
]);

async function policy(access: AccessContext) {
  requirePermission(access, "company:read");
  const config = row<TreasuryConfig>("SELECT * FROM treasury_config WHERE organization_id=?", access.organizationId);
  const localPaused = !!row<{ paused: number }>("SELECT paused FROM organizations WHERE id=?", access.organizationId)?.paused;
  if (!config) return { configured: false as const, localPaused };
  const treasury = await syncTreasury(access);
  const current = await view<Policy>(config, "get_config");
  return { configured: true as const, config, current, treasury, localPaused };
}

export async function preparePolicyChange(access: AccessContext, input: z.infer<typeof changeInput>, expectedPolicyVersion: string) {
  requirePermission(access, "company:manage");
  const state = await policy(access);
  if (!state.configured) throw new ApiError(409, "Connect the company treasury first", "TREASURY_SETUP_REQUIRED");
  const { config, current } = state;
  if (current.policy_version !== expectedPolicyVersion) throw new ApiError(409, "The treasury policy changed. Refresh and review it again", "POLICY_CHANGED");
  if (!row("SELECT id FROM linked_wallets WHERE user_id=? AND family='near' AND address=? AND network=?", access.userId, current.owner_id, config.network)) throw new ApiError(403, "Verify the NEAR owner wallet before changing financial authority", "OWNER_WALLET_REQUIRED");
  const actions: WalletTransaction[] = [];
  const action = (receiverId: string, methodName: string, args: object, deposit = "1", gas = "50000000000000") => ({ receiverId, actions: [{ type: "FunctionCall" as const, params: { methodName, args, deposit, gas } }] });
  switch (input.action) {
    case "pause": actions.push(action(config.near_account_id, "set_paused", { paused: input.paused })); break;
    case "limits":
      if (atomic(input.dailyLimit) < atomic(input.perPaymentLimit)) throw new ApiError(400, "Daily limit must cover the per-payment limit", "INVALID_LIMITS");
      actions.push(action(config.near_account_id, "set_policy", { per_payment_limit: input.perPaymentLimit, daily_limit: input.dailyLimit })); break;
    case "role": actions.push(action(config.near_account_id, "set_role", { account_id: input.accountId, role: input.role, enabled: input.enabled })); break;
    case "reporter": actions.push(action(config.near_account_id, "set_settlement_reporter", { account_id: input.accountId })); break;
    case "backup": {
      const token = input.enabled ? nativeUsdc(await getSupportedTokens(), input.network) : null;
      if (!input.enabled) setNetwork(access, input.network, false);
      actions.push(action(config.near_account_id, "set_backup_asset", { network: input.network, asset_id: token?.assetId ?? null })); break;
    }
    case "withdraw": {
      requirePermission(access, "payments:approve");
      if (atomic(input.amount) > atomic(getTreasury(access).available, true)) throw new ApiError(409, "Withdrawal would use reserved company funds", "WITHDRAWAL_EXCEEDS_AVAILABLE");
      if (!row("SELECT id FROM linked_wallets WHERE user_id=? AND family='near' AND address=? AND network=?", access.userId, input.receiverId, config.network)) throw new ApiError(403, "Withdraw to a verified NEAR wallet you control", "WITHDRAWAL_WALLET_UNVERIFIED");
      const token = { ...config, near_account_id: config.token_contract };
      const storage = await view<unknown>(token, "storage_balance_of", { account_id: input.receiverId });
      if (!storage) {
        const bounds = await view<{ min: string }>(token, "storage_balance_bounds");
        actions.push(action(config.token_contract, "storage_deposit", { account_id: input.receiverId, registration_only: true }, atomic(bounds.min).toString(), "30000000000000"));
      }
      actions.push(action(config.near_account_id, "withdraw_available", { receiver_id: input.receiverId, amount: input.amount }, "1", "100000000000000")); break;
    }
  }
  activity(access, `treasury.${input.action}_prepared`, config.near_account_id);
  return { network: config.network, ownerAccount: current.owner_id, currentPolicyVersion: current.policy_version, change: input, walletActions: actions };
}

export const treasuryPolicyRoutes = new Hono<AppEnv>();
treasuryPolicyRoutes.get("/", async (c) => c.json(await policy(c.get("access"))));
treasuryPolicyRoutes.post("/prepare", async (c) => {
  const value = z.object({ change: changeInput, expectedPolicyVersion: z.string().regex(/^\d+$/) }).parse(await c.req.json());
  return c.json(await preparePolicyChange(c.get("access"), value.change, value.expectedPolicyVersion));
});
treasuryPolicyRoutes.post("/confirm", async (c) => {
  const access = c.get("access"), change = changeInput.parse(await c.req.json());
  requirePermission(access, "company:manage");
  const state = await policy(access);
  if (!state.configured) throw new ApiError(409, "Connect the company treasury first", "TREASURY_SETUP_REQUIRED");
  const current = state.current;
  let matches = true;
  if (change.action === "pause") matches = current.paused === change.paused;
  if (change.action === "limits") matches = current.per_payment_limit === change.perPaymentLimit && current.daily_limit === change.dailyLimit;
  if (change.action === "reporter") matches = current.settlement_reporter === change.accountId;
  if (change.action === "role") matches = (change.role === "approver" ? current.approvers : current.executors).includes(change.accountId) === change.enabled;
  if (change.action === "backup") {
    const registered = await view<string | null>(state.config, "get_backup_asset", { network: change.network });
    const expected = change.enabled ? nativeUsdc(await getSupportedTokens(), change.network).assetId : null;
    matches = registered === expected;
    if (matches) setNetwork(access, change.network, change.enabled);
  }
  if (!matches) throw new ApiError(409, "The treasury has not confirmed this policy change. Refresh its state before retrying", "POLICY_CHANGE_UNCONFIRMED");
  activity(access, `treasury.${change.action}_observed`, state.config.near_account_id);
  return c.json(state);
});
treasuryPolicyRoutes.post("/local-pause", async (c) => {
  const access = c.get("access"), { paused } = z.object({ paused: z.boolean() }).parse(await c.req.json());
  requirePermission(access, "company:manage");
  if (!paused) {
    const current = await policy(access);
    if (current.configured && current.current.paused) throw new ApiError(409, "Unpause the NEAR treasury in its owner wallet before resuming application execution", "ONCHAIN_PAUSED");
  }
  getDb().prepare("UPDATE organizations SET paused=?,updated_at=? WHERE id=?").run(Number(paused), new Date().toISOString(), access.organizationId);
  activity(access, paused ? "company.paused" : "company.resumed", access.organizationId);
  return c.json({ paused });
});
