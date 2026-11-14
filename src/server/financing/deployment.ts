import { base58 } from "@scure/base";
import { ApiError } from "../context";
import { nearRpc } from "../account-recovery/near";
import type { Scope } from "./model";

export interface DeploymentAnchor {
  network: "mainnet" | "testnet";
  accountId: string;
  codeHash: string;
  blockHash: string;
  blockHeight: number;
}
interface BlockResult {
  block_hash: string;
  block_height: number;
}
function hash32(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    return base58.decode(value).length === 32;
  } catch {
    return false;
  }
}
function requireBlock(value: BlockResult, anchor?: DeploymentAnchor) {
  if (
    !value ||
    typeof value !== "object" ||
    !hash32(value.block_hash) ||
    !Number.isSafeInteger(value.block_height) ||
    value.block_height <= 0 ||
    (anchor &&
      (value.block_hash !== anchor.blockHash ||
        value.block_height !== anchor.blockHeight))
  ) {
    throw new ApiError(
      409,
      "The NEAR response does not match the exact finalized deployment block",
      "FINANCING_DEPLOYMENT_BLOCK_MISMATCH",
    );
  }
}
export async function finalizedDeployment(
  network: Scope["network"],
  accountId: string,
  expectedHash: string,
): Promise<DeploymentAnchor> {
  const account = await nearRpc<
    BlockResult & {
      code_hash: string;
      global_contract_account_id?: string | null;
    }
  >(network, "query", {
    request_type: "view_account",
    finality: "final",
    account_id: accountId,
  });
  requireBlock(account);
  if (
    account.code_hash !== expectedHash ||
    account.global_contract_account_id != null
  )
    throw new ApiError(
      409,
      "The finalized account does not contain the reviewed immutable deployment",
      "FINANCING_DEPLOYMENT_REQUIRED",
    );
  const anchor: DeploymentAnchor = {
    network,
    accountId,
    codeHash: expectedHash,
    blockHash: account.block_hash,
    blockHeight: account.block_height,
  };
  const keys = await nearRpc<BlockResult & { keys: unknown[] }>(
    network,
    "query",
    {
      request_type: "view_access_key_list",
      block_id: anchor.blockHash,
      account_id: accountId,
    },
  );
  requireBlock(keys, anchor);
  if (!Array.isArray(keys.keys) || keys.keys.length !== 0)
    throw new ApiError(
      409,
      "Retire every access key from the exact reviewed contract account before using financing. An operator assertion is not proof of immutability",
      "FINANCING_IMMUTABLE_DEPLOYMENT_REQUIRED",
    );
  return anchor;
}
export async function finalizedContractView<T>(
  anchor: DeploymentAnchor,
  method: string,
  args: unknown = {},
): Promise<T> {
  const result = await nearRpc<BlockResult & { result: number[] }>(
    anchor.network,
    "query",
    {
      request_type: "call_function",
      block_id: anchor.blockHash,
      account_id: anchor.accountId,
      method_name: method,
      args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
    },
  );
  requireBlock(result, anchor);
  if (
    !Array.isArray(result.result) ||
    result.result.length > 32768 ||
    result.result.some(
      (byte) => !Number.isInteger(byte) || byte < 0 || byte > 255,
    )
  )
    throw new ApiError(
      502,
      "The reviewed contract returned invalid bounded data",
      "FINANCING_DEPLOYMENT_RESPONSE_INVALID",
    );
  try {
    return JSON.parse(Buffer.from(result.result).toString("utf8")) as T;
  } catch {
    throw new ApiError(
      502,
      "The reviewed contract returned invalid JSON",
      "FINANCING_DEPLOYMENT_RESPONSE_INVALID",
    );
  }
}
