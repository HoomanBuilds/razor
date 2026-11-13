import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context";
import { validNearAccount } from "../payments/near";
import { prepareRetainedDeposit, prepareRetainedPolicy, prepareRetainedRecovery, prepareRetainedRefresh, prepareRetainedWithdrawal, retainedOverview, verifyRetainedDeposit } from "./service";

const account = z.string().refine(validNearAccount, "Choose a valid NEAR account");
const amount = z.string().regex(/^[1-9]\d*$/).max(39);
const hash = z.string().min(20).max(128);
const deposit = z.object({ tokenContract: account, senderAccountId: account, amount });
export const retainedAssetRoutes = new Hono<AppEnv>();
retainedAssetRoutes.get("/", async c => c.json(await retainedOverview(c.get("access"))));
retainedAssetRoutes.post("/policy/prepare", async c => c.json(await prepareRetainedPolicy(c.get("access"), z.object({ tokenContract: account, enabled: z.boolean() }).parse(await c.req.json()))));
retainedAssetRoutes.post("/deposits/prepare", async c => c.json(await prepareRetainedDeposit(c.get("access"), deposit.parse(await c.req.json()))));
retainedAssetRoutes.post("/deposits/verify", async c => c.json(await verifyRetainedDeposit(c.get("access"), deposit.extend({ transactionHash: hash }).parse(await c.req.json()))));
retainedAssetRoutes.post("/withdrawals/prepare", async c => c.json(await prepareRetainedWithdrawal(c.get("access"), z.object({ tokenContract: account, receiverId: account, amount }).parse(await c.req.json()))));
retainedAssetRoutes.post("/withdrawals/recovery", async c => c.json(await prepareRetainedRecovery(c.get("access"), z.object({ tokenContract: account, transactionHash: hash, senderAccountId: account }).parse(await c.req.json()))));
retainedAssetRoutes.post("/refresh/prepare", async c => c.json(await prepareRetainedRefresh(c.get("access"), z.object({ tokenContract: account }).parse(await c.req.json()).tokenContract)));
