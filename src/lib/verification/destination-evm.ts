import type { DestinationTransfer } from "./destination-packet";
import {
  boundedDestinationFetch,
  DestinationUnavailable,
  requireDestination,
} from "./destination-rpc";
export async function observeEvmDestination(
  ref: Extract<DestinationTransfer, { kind: "evm" }>,
  endpoint: string,
  minimumConfirmations = 1,
  transport?: typeof fetch,
) {
  const { createPublicClient, http, parseAbiItem, decodeEventLog } =
      await import("viem"),
    bounded = boundedDestinationFetch(endpoint, transport),
    client = createPublicClient({
      transport: http(endpoint, {
        fetchFn: bounded,
        retryCount: 0,
        timeout: 12000,
        maxResponseBodySize: 2 * 1024 * 1024,
      }),
    });
  const equal = (one: string, two: string) =>
      one.toLowerCase() === two.toLowerCase(),
    transactionHash = ref.transactionHash as `0x${string}`,
    token = ref.tokenContract as `0x${string}`,
    recipient = ref.recipient as `0x${string}`;
  requireDestination(
    (await client.getChainId()) === ref.chainId,
    "The selected EVM RPC has a different chain ID",
  );
  const receipt = await client.getTransactionReceipt({ hash: transactionHash });
  requireDestination(
    equal(receipt.transactionHash, ref.transactionHash),
    "The EVM receipt belongs to a different transaction",
  );
  requireDestination(
    receipt.status === "success",
    "The EVM transaction reverted",
  );
  const finalized = await client.getBlock({ blockTag: "finalized" });
  if (finalized.number === null || receipt.blockNumber > finalized.number)
    throw new DestinationUnavailable(
      "The receipt is not included in the RPC's finalized chain head",
    );
  if (
    finalized.number - receipt.blockNumber + 1n <
    BigInt(minimumConfirmations)
  )
    throw new DestinationUnavailable(
      "The independently selected minimum finalized-confirmation count has not been reached",
    );
  const block = await client.getBlock({ blockNumber: receipt.blockNumber });
  requireDestination(
    block.hash !== null &&
      equal(block.hash, receipt.blockHash) &&
      block.transactions.some(
        (value) =>
          typeof value === "string" && equal(value, ref.transactionHash),
      ),
    "The receipt is not in the canonical finalized block returned by this RPC",
  );
  const selectedLogs = receipt.logs.filter(
      (item) => item.logIndex === ref.logIndex,
    ),
    log = selectedLogs[0];
  requireDestination(
    selectedLogs.length === 1 &&
      log &&
      !log.removed &&
      equal(log.address, ref.tokenContract) &&
      equal(log.transactionHash, ref.transactionHash) &&
      equal(log.blockHash, receipt.blockHash) &&
      log.topics.length === 3 &&
      /^0x[0-9a-fA-F]{64}$/.test(log.data),
    "The exact selected ERC20 log identity does not match the successful receipt",
  );
  const event = parseAbiItem(
    "event Transfer(address indexed from,address indexed to,uint256 value)",
  );
  let parsed;
  try {
    parsed = decodeEventLog({
      abi: [event],
      data: log.data,
      topics: log.topics,
      strict: true,
    });
  } catch {
    throw new DestinationUnavailable(
      "The selected token log does not use the supported standard ERC20 Transfer encoding",
    );
  }
  requireDestination(
    equal(parsed.args.from, ref.sender) &&
      equal(parsed.args.to, ref.recipient) &&
      parsed.args.value === BigInt(ref.amount),
    "The ERC20 sender, recipient or exact base-unit amount differs",
  );
  const code = await client.getBytecode({
    address: token,
    blockNumber: receipt.blockNumber,
  });
  requireDestination(
    !!code && code !== "0x",
    "The expected token contract has no bytecode at the transfer block",
  );
  const incoming = await client.getLogs({
      address: token,
      event,
      args: { to: recipient },
      blockHash: receipt.blockHash,
      strict: true,
    }),
    outgoing = await client.getLogs({
      address: token,
      event,
      args: { from: recipient },
      blockHash: receipt.blockHash,
      strict: true,
    });
  if (
    incoming.length !== 1 ||
    incoming[0].logIndex !== ref.logIndex ||
    !equal(incoming[0].transactionHash, ref.transactionHash) ||
    outgoing.length
  )
    throw new DestinationUnavailable(
      "Other recipient transfers share this block. This bounded verifier cannot isolate the recipient's transaction balance delta",
    );
  if (receipt.blockNumber === 0n)
    throw new DestinationUnavailable(
      "The ERC20 parent-block balance is unavailable",
    );
  const balanceAbi = [
    parseAbiItem("function balanceOf(address owner) view returns (uint256)"),
  ] as const;
  const before = await client.readContract({
      address: token,
      abi: balanceAbi,
      functionName: "balanceOf",
      args: [recipient],
      blockNumber: receipt.blockNumber - 1n,
    }),
    after = await client.readContract({
      address: token,
      abi: balanceAbi,
      functionName: "balanceOf",
      args: [recipient],
      blockNumber: receipt.blockNumber,
    });
  if (after - before !== BigInt(ref.amount))
    throw new DestinationUnavailable(
      "The actual recipient balance delta differs from the event amount. Fee-bearing, rebasing or other nonstandard behavior is not verified",
    );
  requireDestination(
    (await client.getChainId()) === ref.chainId,
    "The RPC changed EVM chain during verification",
  );
  return {
    network: `eip155:${ref.chainId}`,
    transaction: ref.transactionHash,
    blockHash: receipt.blockHash,
    blockHeight: receipt.blockNumber.toString(),
    amount: ref.amount,
    recipient: ref.recipient,
    token: ref.tokenContract,
    selector: String(ref.logIndex),
    scope:
      "Successful canonical ERC20 Transfer plus exact recipient balance increase across an isolated finalized block; archive balance queries and independently reviewed standard token identity are required. L2 RPC finality is not an independently verified L1 settlement proof.",
  };
}
