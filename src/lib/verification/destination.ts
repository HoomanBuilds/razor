import {
  canonicalDestination,
  destinationEvidenceSchema,
  destinationTrustSchema,
  type DestinationEvidence,
  type DestinationTrust,
} from "./destination-packet";
import type { PortablePacket, VerificationClaim } from "./packet";
import { DestinationFailure } from "./destination-rpc";
export interface DestinationVerificationOptions {
  trust?: DestinationTrust;
  rpcUrl?: string;
  transport?: typeof fetch;
  sourcePacket?: PortablePacket;
}
export async function verifyDestinationEvidence(
  input: DestinationEvidence,
  options: DestinationVerificationOptions = {},
) {
  const evidence = destinationEvidenceSchema.parse(input),
    trust = options.trust
      ? destinationTrustSchema.parse(options.trust)
      : undefined,
    claims: VerificationClaim[] = [],
    add = (
      claim: string,
      status: VerificationClaim["status"],
      detail: string,
    ) => claims.push({ claim, status, detail });
  add(
    "destination_evidence_format",
    "passed",
    "Strict destination evidence v1 contains public transaction references only. No private keys, raw invoice content or decryption credentials are required.",
  );
  const matches = trust
    ? canonicalDestination(trust.expectedTransfer) ===
      canonicalDestination(evidence.transfer)
    : false;
  add(
    "independent_destination_expectation",
    trust ? (matches ? "passed" : "failed") : "not_checked",
    trust
      ? matches
        ? "The exact transaction/event, network, token, recipient and base-unit amount match the independently supplied expected transfer. Trust-file provenance is the verifier's responsibility."
        : "The evidence differs from the independently reviewed expected transfer."
      : "No independent expected destination was supplied. Packet-author token, recipient and amount declarations are not authenticated payment instructions.",
  );
  let observation:
    | Awaited<
        ReturnType<typeof import("./destination-near").observeNearDestination>
      >
    | Awaited<
        ReturnType<typeof import("./destination-evm").observeEvmDestination>
      >
    | Awaited<
        ReturnType<
          typeof import("./destination-solana").observeSolanaDestination
        >
      >
    | null = null;
  if (options.rpcUrl && (!trust || matches))
    try {
      if (evidence.transfer.kind === "near") {
        const { observeNearDestination } = await import("./destination-near");
        observation = await observeNearDestination(
          evidence.transfer,
          options.rpcUrl,
          options.transport,
        );
      } else if (evidence.transfer.kind === "evm") {
        const { observeEvmDestination } = await import("./destination-evm");
        observation = await observeEvmDestination(
          evidence.transfer,
          options.rpcUrl,
          trust?.minimumEvmConfirmations ?? 1,
          options.transport,
        );
      } else {
        const { observeSolanaDestination } = await import(
          "./destination-solana"
        );
        observation = await observeSolanaDestination(
          evidence.transfer,
          options.rpcUrl,
          options.transport,
        );
      }
      add(
        "destination_transfer_observation",
        "passed",
        `${observation.scope} This is a trusted selected-RPC observation, not a light-client proof, hardware assertion or authentication of a Razor payment.`,
      );
    } catch (error) {
      add(
        "destination_transfer_observation",
        error instanceof DestinationFailure ? "failed" : "unavailable",
        error instanceof DestinationFailure
          ? error.message
          : "Required finalized RPC evidence, supported token behavior or bounded archive data is unavailable. No fallback endpoint, latest/confirmed substitution, gross-amount inference or backend proxy was used.",
      );
    }
  else
    add(
      "destination_transfer_observation",
      "not_checked",
      options.rpcUrl
        ? "The independently reviewed destination differs, so no RPC lookup was performed."
        : "Offline mode: no destination RPC was authorized. Importing evidence or trust never starts a network lookup.",
    );
  const sourceMatches =
    !!trust?.expectedSource &&
    !!evidence.source &&
    canonicalDestination(trust.expectedSource) ===
      canonicalDestination(evidence.source) &&
    (!options.sourcePacket ||
      (!!options.sourcePacket.chain &&
        canonicalDestination(options.sourcePacket.chain) ===
          canonicalDestination(trust.expectedSource)));
  add(
    "independent_source_reference",
    trust?.expectedSource
      ? sourceMatches
        ? "passed"
        : "failed"
      : "not_checked",
    trust?.expectedSource
      ? sourceMatches
        ? "The separately reviewed source reference matches the declared source and any loaded portable packet. This equality is not authentication of source execution or destination causality."
        : "The independent source reference differs or the destination evidence omits it."
      : "No independent expected source reference was supplied. Equal self-asserted packet IDs establish no payment binding.",
  );
  add(
    "source_destination_association",
    "unavailable",
    "No authenticated cross-chain binding witness is verified by this format. Even a real finalized transfer and matching independently reviewed references do not prove that the transfer discharged this Razor payment. Historical NEAR execution, provider reports, encrypted inference, plaintext correctness and destination observation remain separate claims.",
  );
  return {
    schema: "razor.destination-verification-report" as const,
    version: 1 as const,
    mode: options.rpcUrl ? "selected-rpc" : "offline",
    observation,
    claims,
  };
}
