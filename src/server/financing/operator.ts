import { z } from "zod";
import { randomUUID } from "node:crypto";
import { ApiError } from "../context";
import { getDb, row, transaction } from "../db";
import { audit } from "../identity/session";
import { validNearAccount } from "../payments/near";
import { NATIVE_USDC } from "../../lib/native-usdc";
const account = z.string().refine(validNearAccount);
const input = z
  .object({
    id: z.string().uuid().optional(),
    expectedVersion: z.number().int().min(0),
    label: z.string().trim().min(3).max(120),
    eligibility: z.string().trim().min(20).max(1000),
    network: z.enum(["mainnet", "testnet"]),
    contractId: account,
    tokenContract: account,
    treasuryId: account,
    codeHash: z.string().min(32).max(64),
    organizationIds: z.array(z.string().uuid()).min(1).max(1000),
    lenderUserIds: z.array(z.string().uuid()).min(1).max(1000),
    active: z.boolean(),
  })
  .strict();
export function publishFinancingScope(operatorUserId: string, data: unknown) {
  if (
    !(process.env.RAZOR_FINANCING_OPERATOR_USER_IDS ?? "")
      .split(",")
      .map((value) => value.trim())
      .includes(operatorUserId) ||
    !row("SELECT id FROM users WHERE id=?", operatorUserId)
  )
    throw new ApiError(
      403,
      "An explicitly configured existing operating-scope publisher is required",
      "FINANCING_OPERATOR_REQUIRED",
    );
  const value = input.parse(data);
  return transaction(() => {
    const id = value.id ?? randomUUID(),
      previous = row<{ version: number }>(
        "SELECT version FROM financing_scopes WHERE id=?",
        id,
      );
    if ((previous?.version ?? 0) !== value.expectedVersion)
      throw new ApiError(
        409,
        "The published operating scope changed",
        "FINANCING_SCOPE_CHANGED",
      );
    if (value.network === "mainnet" && value.tokenContract !== NATIVE_USDC.near)
      throw new ApiError(
        422,
        "Native NEAR USDC is required",
        "FINANCING_NATIVE_ONLY",
      );
    for (const org of value.organizationIds)
      if (!row("SELECT id FROM organizations WHERE id=?", org))
        throw new ApiError(
          422,
          "Every scoped company must already exist",
          "FINANCING_SCOPE_INVALID",
        );
    for (const user of value.lenderUserIds)
      if (!row("SELECT id FROM users WHERE id=?", user))
        throw new ApiError(
          422,
          "Every invited lender must already exist",
          "FINANCING_SCOPE_INVALID",
        );
    getDb()
      .prepare(
        "INSERT INTO financing_scopes(id,version,label,eligibility,network,contract_id,token_contract,treasury_id,code_hash,allowed_organizations_json,allowed_lenders_json,active,published_by,published_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET version=excluded.version,label=excluded.label,eligibility=excluded.eligibility,network=excluded.network,contract_id=excluded.contract_id,token_contract=excluded.token_contract,treasury_id=excluded.treasury_id,code_hash=excluded.code_hash,allowed_organizations_json=excluded.allowed_organizations_json,allowed_lenders_json=excluded.allowed_lenders_json,active=excluded.active,published_by=excluded.published_by,published_at=excluded.published_at",
      )
      .run(
        id,
        value.expectedVersion + 1,
        value.label,
        value.eligibility,
        value.network,
        value.contractId,
        value.tokenContract,
        value.treasuryId,
        value.codeHash,
        JSON.stringify([...new Set(value.organizationIds)]),
        JSON.stringify([...new Set(value.lenderUserIds)]),
        Number(value.active),
        operatorUserId,
        new Date().toISOString(),
      );
    audit(operatorUserId, null, "financing.scope_published", id, {
      version: value.expectedVersion + 1,
      active: value.active,
    });
    return { id, version: value.expectedVersion + 1 };
  });
}
