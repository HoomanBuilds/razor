import type { DestinationTransfer } from "./destination-packet";
import {
  boundedDestinationFetch,
  DestinationUnavailable,
  requireDestination,
} from "./destination-rpc";
export async function observeSolanaDestination(
  ref: Extract<DestinationTransfer, { kind: "solana" }>,
  endpoint: string,
  transport?: typeof fetch,
) {
  if (ref.tokenProgram !== "legacy_spl")
    throw new DestinationUnavailable(
      "Token-2022, fee/hook/confidential extensions and gross transfer amounts are unsupported. No net SPL delivery is inferred.",
    );
  const [{ Connection, PublicKey }, { TOKEN_PROGRAM_ID }] = await Promise.all([
      import("@solana/web3.js"),
      import("@solana/spl-token"),
    ]),
    connection = new Connection(endpoint, {
      commitment: "finalized",
      fetch: boundedDestinationFetch(endpoint, transport),
      disableRetryOnRateLimit: true,
    });
  requireDestination(
    (await connection.getGenesisHash()) === ref.genesisHash,
    "The selected Solana RPC has a different genesis hash",
  );
  const tx = await connection.getParsedTransaction(ref.transactionSignature, {
    commitment: "finalized",
    maxSupportedTransactionVersion: 0,
  });
  if (!tx || !tx.meta)
    throw new DestinationUnavailable(
      "The finalized parsed Solana transaction metadata is unavailable",
    );
  requireDestination(
    tx.transaction.signatures[0] === ref.transactionSignature,
    "The Solana response belongs to another transaction",
  );
  requireDestination(tx.meta.err === null, "The Solana transaction failed");
  if (
    !Number.isSafeInteger(tx.slot) ||
    tx.slot < 0 ||
    tx.transaction.message.accountKeys.length > 1024
  )
    throw new DestinationUnavailable(
      "The Solana transaction exceeds supported slot or account bounds",
    );
  const statuses = await connection.getSignatureStatuses(
      [ref.transactionSignature],
      { searchTransactionHistory: true },
    ),
    status = statuses.value[0];
  if (
    !status ||
    status.confirmationStatus !== "finalized" ||
    status.slot !== tx.slot
  )
    throw new DestinationUnavailable(
      "A matching finalized signature status is unavailable",
    );
  requireDestination(
    status.err === null,
    "The finalized Solana signature reports failure",
  );
  const instructions =
    ref.innerIndex === undefined
      ? tx.transaction.message.instructions
      : tx.meta.innerInstructions?.find(
          (group) => group.index === ref.instructionIndex,
        )?.instructions;
  const instruction = instructions?.[ref.innerIndex ?? ref.instructionIndex];
  requireDestination(
    instruction &&
      instruction.programId.equals(TOKEN_PROGRAM_ID) &&
      "parsed" in instruction,
    "The selected instruction is not a parsed canonical legacy SPL Token transfer",
  );
  const parsed = instruction.parsed as {
    type?: string;
    info?: {
      source?: string;
      destination?: string;
      authority?: string;
      mint?: string;
      amount?: string;
      tokenAmount?: { amount?: string; decimals?: number };
    };
  };
  if (parsed.type !== "transfer" && parsed.type !== "transferChecked")
    throw new DestinationUnavailable(
      "Only canonical legacy SPL transfer and transferChecked instructions are supported",
    );
  const info = parsed.info,
    actualAmount =
      parsed.type === "transferChecked"
        ? info?.tokenAmount?.amount
        : info?.amount;
  requireDestination(
    info?.source === ref.sourceTokenAccount &&
      info.destination === ref.destinationTokenAccount &&
      info.authority === ref.authority &&
      actualAmount === ref.amount &&
      (parsed.type !== "transferChecked" || info.mint === ref.mint),
    "The SPL token accounts, authority, mint or exact instruction amount differ",
  );
  const keys = tx.transaction.message.accountKeys.map((key) =>
      key.pubkey.toBase58(),
    ),
    sourceIndex = keys.indexOf(ref.sourceTokenAccount),
    destinationIndex = keys.indexOf(ref.destinationTokenAccount);
  requireDestination(
    sourceIndex >= 0 &&
      destinationIndex >= 0 &&
      sourceIndex !== destinationIndex,
    "The SPL source and destination accounts are not distinct transaction accounts",
  );
  const balances = (
    index: number,
    which: "preTokenBalances" | "postTokenBalances",
  ) => {
    const found = tx.meta![which]?.filter(
      (value) => value.accountIndex === index,
    );
    if (!found || found.length !== 1)
      throw new DestinationUnavailable(
        "Exact historical pre/post token-account balances are required; newly created or closed token accounts remain unsupported",
      );
    return found[0];
  };
  const sourcePre = balances(sourceIndex, "preTokenBalances"),
    sourcePost = balances(sourceIndex, "postTokenBalances"),
    destPre = balances(destinationIndex, "preTokenBalances"),
    destPost = balances(destinationIndex, "postTokenBalances");
  for (const [entry, owner] of [
    [sourcePre, ref.sourceOwner],
    [sourcePost, ref.sourceOwner],
    [destPre, ref.recipientOwner],
    [destPost, ref.recipientOwner],
  ] as const) {
    if (typeof entry.owner !== "string" || typeof entry.programId !== "string")
      throw new DestinationUnavailable(
        "Historical SPL owner and token-program metadata are required",
      );
    requireDestination(
      entry.mint === ref.mint &&
        entry.owner === owner &&
        entry.programId === TOKEN_PROGRAM_ID.toBase58(),
      "Historical SPL mint, owner or token program differs from the reviewed expectation",
    );
    if (
      !/^(0|[1-9]\d{0,19})$/.test(entry.uiTokenAmount.amount) ||
      BigInt(entry.uiTokenAmount.amount) >= 2n ** 64n
    )
      throw new DestinationUnavailable(
        "The SPL balance is not an exact supported u64 string",
      );
  }
  requireDestination(
    BigInt(sourcePre.uiTokenAmount.amount) -
      BigInt(sourcePost.uiTokenAmount.amount) ===
      BigInt(ref.amount) &&
      BigInt(destPost.uiTokenAmount.amount) -
        BigInt(destPre.uiTokenAmount.amount) ===
        BigInt(ref.amount),
    "The actual SPL debit and recipient credit differ from the expected base-unit amount",
  );
  requireDestination(
    sourcePre.uiTokenAmount.decimals === sourcePost.uiTokenAmount.decimals &&
      sourcePost.uiTokenAmount.decimals === destPre.uiTokenAmount.decimals &&
      destPre.uiTokenAmount.decimals === destPost.uiTokenAmount.decimals &&
      (parsed.type !== "transferChecked" ||
        info?.tokenAmount?.decimals === destPost.uiTokenAmount.decimals),
    "SPL token precision changed across the selected transfer",
  );
  const mint = await connection.getAccountInfo(
    new PublicKey(ref.mint),
    "finalized",
  );
  if (!mint || !mint.owner.equals(TOKEN_PROGRAM_ID))
    throw new DestinationUnavailable(
      "The expected mint is not currently available under the canonical legacy Token program",
    );
  requireDestination(
    (await connection.getGenesisHash()) === ref.genesisHash,
    "The RPC changed Solana genesis during verification",
  );
  return {
    network: `solana:${ref.genesisHash}`,
    transaction: ref.transactionSignature,
    blockHash: tx.transaction.message.recentBlockhash,
    blockHeight: String(tx.slot),
    amount: ref.amount,
    recipient: ref.recipientOwner,
    token: ref.mint,
    selector:
      ref.innerIndex === undefined
        ? `outer:${ref.instructionIndex}`
        : `inner:${ref.instructionIndex}:${ref.innerIndex}`,
    scope:
      "Finalized canonical legacy SPL instruction with exact historical source debit and recipient-owner token-account credit. Recent blockhash is transaction context, not proof of the containing block hash. Token-2022 and fee-bearing extensions are not supported.",
  };
}
