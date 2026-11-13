import { createPublicClient, decodeEventLog, http, isAddress, parseAbi, type Chain, type Hex } from "viem";
import { mainnet, base, arbitrum, polygon, optimism, bsc, avalanche, gnosis, aurora, berachain, monad, plasma, scroll, linea, mantle, blast, celo, zkSync, abstract } from "viem/chains";
import { atomic } from "../../lib/money";
import { ApiError } from "../context";
import { verifyTokenReceipt } from "../payments/near";
import type { RefundProof, RefundTerms } from "./types";

const EVM_CHAINS: Record<string, Chain> = { eth: mainnet, base, arb: arbitrum, pol: polygon, op: optimism, bsc, avax: avalanche, gnosis, aurora, bera: berachain, monad, plasma, scroll, linea, mantle, blast, celo, zksync: zkSync, abs: abstract };
const transferAbi = parseAbi(["event Transfer(address indexed from,address indexed to,uint256 value)"]);
function mismatch(message: string): never { throw new ApiError(409, message, "FUNDING_REFUND_RECEIPT_UNPROVEN"); }
const baseProof = (terms: RefundTerms) => ({ network: terms.source.blockchain, transactionHash: terms.transactionHash, amount: terms.refundedAmount, receiver: terms.refundTo });

export function sourceWalletFamily(network: string): "evm" | "near" | "solana" | null { return EVM_CHAINS[network] ? "evm" : network === "near" ? "near" : network === "sol" ? "solana" : null; }

function attestation(terms: RefundTerms, reason: string, detail: Record<string, unknown> = {}): RefundProof {
  if (!terms.sourceTransactionHash) throw new ApiError(409, "Record the original source transaction before reviewing an unverified-chain refund", "FUNDING_REFUND_SOURCE_REQUIRED");
  return { ...baseProof(terms), provenance: "funder_or_reporter_attestation", eventKeys: [`${terms.source.blockchain}:${terms.source.assetId}:${terms.transactionHash}:${terms.refundTo}`], detail, reason };
}

export interface EvmRefundReceipt { status: string; transactionHash: string; blockNumber: bigint; blockHash: string; logs: readonly { address: string; topics: readonly string[]; data: string; logIndex: number | null; removed?: boolean }[] }
export function inspectEvmRefund(terms: RefundTerms, receipt: EvmRefundReceipt, tx: { hash: string; to: string | null; value: bigint }, finalized: { number: bigint; hash: string }, canonicalHash: string): RefundProof {
  if (receipt.status !== "success" || receipt.transactionHash.toLowerCase() !== terms.transactionHash.toLowerCase() || tx.hash.toLowerCase() !== terms.transactionHash.toLowerCase() || receipt.blockNumber > finalized.number || receipt.blockHash !== canonicalHash) mismatch("The source refund is not a successful canonical finalized transaction");
  const token = terms.source.contractAddress, receiver = terms.refundTo.toLowerCase(), prefix = `${terms.source.blockchain}:${terms.transactionHash.toLowerCase()}`;
  if (!token) {
    if (tx.value === 0n && tx.to?.toLowerCase() !== receiver) return attestation(terms, "The finalized transaction may contain an internal native-asset transfer. This integration does not verify execution traces", { blockNumber: receipt.blockNumber.toString(), blockHash: receipt.blockHash, finality: "finalized" });
    if (tx.to?.toLowerCase() !== receiver || tx.value !== BigInt(terms.refundedAmount)) mismatch("The finalized native source transfer does not match the original refund address and amount");
    return { ...baseProof(terms), provenance: "final_chain_receipt", eventKeys: [`${prefix}:native`], detail: { blockNumber: receipt.blockNumber.toString(), blockHash: receipt.blockHash, finality: "finalized", kind: "native_transfer" } };
  }
  if (!isAddress(token)) mismatch("The source token has no verified EVM contract identity");
  let incoming = 0n;
  const eventKeys: string[] = [];
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== token.toLowerCase() || log.removed) continue;
    let event;
    try { event = decodeEventLog({ abi: transferAbi, data: log.data as Hex, topics: log.topics as [Hex, ...Hex[]] }); } catch { continue; }
    const { from, to, value } = event.args;
    if (from.toLowerCase() === receiver) mismatch("The refund transaction also spends this token from the recovery address");
    if (to.toLowerCase() !== receiver) continue;
    if (log.logIndex === null) mismatch("The final token event has no stable log identity");
    incoming += value; eventKeys.push(`${prefix}:${token.toLowerCase()}:${log.logIndex}`);
  }
  if (!eventKeys.length || new Set(eventKeys).size !== eventKeys.length || incoming !== BigInt(terms.refundedAmount)) mismatch("Final token events do not match the exact source refund quantity and address");
  return { ...baseProof(terms), provenance: "final_chain_receipt", eventKeys, detail: { blockNumber: receipt.blockNumber.toString(), blockHash: receipt.blockHash, finality: "finalized", kind: "erc20_transfer", tokenContract: token } };
}

interface SolanaTokenBalance { accountIndex: number; mint: string; owner?: string; uiTokenAmount: { amount: string; decimals: number } }
export function inspectSolanaRefund(terms: RefundTerms, result: { slot: number; signatures: string[]; accounts: string[]; meta: { err: unknown; fee: number; preBalances: number[]; postBalances: number[]; preTokenBalances?: SolanaTokenBalance[] | null; postTokenBalances?: SolanaTokenBalance[] | null } }): RefundProof {
  if (result.meta.err !== null || result.signatures[0] !== terms.transactionHash) mismatch("The finalized Solana refund is unsuccessful or has another signature");
  let amount = 0n;
  if (terms.source.contractAddress) {
    const quantity = (balances: SolanaTokenBalance[] | null | undefined) => (balances ?? []).filter(item => {
      if (item.mint === terms.source.contractAddress && !item.owner) mismatch("The source refund token balance has no verified account owner");
      return item.mint === terms.source.contractAddress && item.owner === terms.refundTo;
    }).reduce((sum, item) => {
      if (item.uiTokenAmount.decimals !== terms.source.decimals) mismatch("The refund mint decimals differ from the original source asset");
      return sum + atomic(item.uiTokenAmount.amount, true);
    }, 0n);
    amount = quantity(result.meta.postTokenBalances) - quantity(result.meta.preTokenBalances);
  } else {
    const index = result.accounts.indexOf(terms.refundTo);
    if (index < 0 || ![result.meta.preBalances[index], result.meta.postBalances[index], result.meta.fee].every(value => Number.isSafeInteger(value) && value >= 0)) mismatch("The finalized SOL balance cannot be read without losing precision");
    amount = BigInt(result.meta.postBalances[index]) - BigInt(result.meta.preBalances[index]);
    if (index === 0) amount += BigInt(result.meta.fee);
  }
  if (amount !== BigInt(terms.refundedAmount)) mismatch("The finalized Solana credit differs from the exact source refund amount");
  return { ...baseProof(terms), provenance: "final_chain_receipt", eventKeys: [`sol:${terms.transactionHash}:${terms.source.assetId}:${terms.refundTo}`], detail: { slot: result.slot, finality: "finalized", kind: terms.source.contractAddress ? "spl_balance_credit" : "native_balance_credit", tokenContract: terms.source.contractAddress } };
}

async function verifyReceipt(terms: RefundTerms): Promise<RefundProof> {
  const network = terms.source.blockchain;
  if (network === "near" && terms.source.contractAddress) {
    if (terms.source.assetId !== `nep141:${terms.source.contractAddress}` || !terms.senderAccountId) throw new ApiError(422, "Enter the original NEAR refund transaction signer for this exact NEP-141 asset", "FUNDING_REFUND_SIGNER_REQUIRED");
    const proof = await verifyTokenReceipt({ organization_id: "", near_account_id: terms.refundTo, network: "mainnet", token_contract: terms.source.contractAddress }, terms.transactionHash, terms.senderAccountId, terms.refundTo, terms.refundedAmount);
    return { ...baseProof(terms), provenance: "final_chain_receipt", eventKeys: proof.events.map(event => `near:${proof.tokenContract}:${event.receiptId}:${event.logIndex}:${event.dataIndex}`), detail: { ...proof } };
  }
  const chain = EVM_CHAINS[network];
  if (chain) {
    if (!/^0x[a-f0-9]{64}$/i.test(terms.transactionHash) || !isAddress(terms.refundTo)) throw new ApiError(422, "Enter a valid EVM refund transaction and original recovery address", "FUNDING_REFUND_HASH_INVALID");
    const client = createPublicClient({ chain, transport: http(process.env[`FUNDING_REFUND_RPC_${network.toUpperCase()}`], { timeout: 15_000, retryCount: 0 }) });
    if (await client.getChainId() !== chain.id) mismatch("The refund RPC serves another source network");
    const hash = terms.transactionHash as Hex;
    const [receipt, tx, finalized] = await Promise.all([client.getTransactionReceipt({ hash }), client.getTransaction({ hash }), client.getBlock({ blockTag: "finalized" })]);
    const canonical = await client.getBlock({ blockNumber: receipt.blockNumber });
    return inspectEvmRefund(terms, receipt, tx, { number: finalized.number, hash: finalized.hash }, canonical.hash);
  }
  if (network === "sol") {
    const { Connection, clusterApiUrl } = await import("@solana/web3.js");
    const canonical = new Connection(clusterApiUrl("mainnet-beta"), "finalized"), connection = new Connection(process.env.SOLANA_RPC_URL || clusterApiUrl("mainnet-beta"), "finalized");
    const [mainnetGenesis, actualGenesis] = await Promise.all([canonical.getGenesisHash(), connection.getGenesisHash()]);
    if (mainnetGenesis !== actualGenesis) mismatch("The refund RPC is not Solana mainnet");
    const result = await connection.getParsedTransaction(terms.transactionHash, { commitment: "finalized", maxSupportedTransactionVersion: 0 });
    if (!result?.meta) mismatch("The Solana refund has no finalized transaction metadata");
    return inspectSolanaRefund(terms, { slot: result.slot, signatures: result.transaction.signatures, accounts: result.transaction.message.accountKeys.map(key => key.pubkey.toBase58()), meta: result.meta });
  }
  return attestation(terms, "Razor has no final source-chain receipt verifier for this asset. The closure relies on the linked funder's or authorized company reporter's explicit attestation");
}

export async function verifySourceRefund(terms: RefundTerms): Promise<RefundProof> {
  try { return await verifyReceipt(terms); }
  catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(503, "The source-chain refund proof is unavailable or not final. Keep this source leg held and retry its receipt check", "FUNDING_REFUND_RPC_UNAVAILABLE");
  }
}
