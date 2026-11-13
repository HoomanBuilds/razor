# Source funding refund closure

Razor separates a returned source deposit from recipient payout recovery. Closing a failed top-up records the original asset returning to the original `refundTo` address. It never credits company USDC, marks an obligation paid or proves closure of a recipient payout attempt.

## Evidence and authorization

A company member with payment preparation permission can request a refund review. They must control a linked original recovery wallet or have company payment approval permission to act as an explicit reporter. Every review freezes the immutable original quote hash, source token identity, source network, original refund address, actual provider-reported refund amount and selected refund transaction. Public funding links do not authorize refund attestations.

The application fetches current status through the existing signed-quote-verifying NEAR Intents client. Only `REFUNDED` permits closure. The reported source refund must be positive, cannot exceed a reported deposited amount and cannot coexist with a positive destination output or credited destination receipt. `FAILED`, `INCOMPLETE_DEPOSIT`, timeouts and unknown outcomes remain unresolved. A reported destination delivery conflicting with refund evidence remains held.

The selected refund hash must appear in the original quote's provider-reported origin-chain transaction list. It must differ from the original deposit hash when that hash is recorded. An attested recovery requires both distinct hashes to be provider-linked. No receiving address or token can be substituted during review. Frozen source token metadata is reused for public funding requests and approved-obligation funding tasks; legacy legs without it require current catalog identity before preparing a review.

The [NEAR Intents status documentation](https://docs.near-intents.org/integration/distribution-channels/1click-api/quickstart/making-a-request) and its published SDK distinguish the quoted output from actual `swapDetails.amountOut`, and define `swapDetails.refundedAmount` in the original source asset. Razor uses actual returned source units rather than inferring a refund from the original quote amount.

## Final chain proof and attestation

- NEAR NEP-141 refunds require the FINAL original transaction, its signer, exact token contract, receiver and incoming transfer quantity.
- Supported EVM sources require the correct mainnet chain ID, a successful canonical transaction at or below the finalized block and exact native transfer or ERC-20 transfer events. Removed logs, unrelated tokens, outgoing receiver-token transfers, wrong receivers and mismatched quantities are rejected. RPC or finality failures do not downgrade to an attestation.
- Solana sources require mainnet genesis identity and finalized transaction metadata. SPL mint, account owner, decimals and net incoming token quantity must match. Native SOL uses exact safe-integer lamport changes with payer fees separated. These are final transaction balance-credit proofs, not a claim that every internal instruction has been independently traced.
- Networks without a receipt verifier, native NEAR outside NEP-141, and finalized EVM internal native transfers without trace support require an explicit linked-funder or company-reporter receipt attestation. The original deposit hash, distinct provider-linked refund hash and terminal provider closure are still required. This path is labeled unverified chain transfer and stored as `refunded_attested`.

Actual chain proof records `refunded_verified` with `final_chain_receipt` provenance. Human-confirmed closure records `refunded_attested` with `funder_or_reporter_attestation` provenance. These labels remain distinct in history and CSV. Provider completion remains a trusted input for route closure; source-chain proof establishes receipt of the returned asset rather than independently proving the provider cannot ever process another transfer.

## Confirmation and accounting

Reviews expire after two minutes. Confirmation rechecks role or funder authority, the original quote, terminal provider evidence, source transaction identity and receipt proof. Conflicting updates invalidate the review. Receipt event keys cannot be reused for another funding leg. Repeating the same completed confirmation is idempotent.

Evidence, provider response and explicit attestation text are encrypted at rest. The audit records actor, time and proof provenance. Original source units, reported deposited units and any difference remain distinct from USDC or a verified fee. The dedicated accounting CSV includes original quote linkage, source and refund hashes, quantity, provenance and zero company-USDC credit. An unexplained source difference is not labeled a fee or business loss in USDC.

Closed refund legs release their public funding-quote lease, while the request's unreceived USDC target stays outstanding. Resuming the old quote cannot send another deposit. Public status polling preserves closed refunds. A new approved-obligation funding quote can cover the remaining need only after deliberate review; unknown source outcomes continue to hold that task.

## Integration and limits

Mount `fundingRefundRoutes` from `src/server/funding-refunds/index.ts` at `/organizations/:orgId/funding-refunds`, behind existing company authentication. Render `FundingRefundsPanel` from `src/components/workspace/funding-refunds.tsx` in Treasury. Endpoints are `GET /`, `GET /export`, `POST /:id/prepare` and `POST /:id/confirm`. Migration `026-funding-refunds.sql` stores reviews, closures and replay-protected receipt keys.

Supported EVM networks follow the installed viem chain definitions used by the existing source-wallet connector. An optional `FUNDING_REFUND_RPC_<NETWORK>` override must serve that exact mainnet. Solana accepts `SOLANA_RPC_URL` only after checking it against mainnet genesis identity. No server wallet or money-moving key is used for these read-only receipt checks.

Local policy, receipt and database fixtures do not establish live source refunds. Provider configuration, public RPC availability, finalized real receipts and a correctly linked original recovery wallet remain required for a live demonstration. General client access and company reporter access are separate: a public payer who has no company membership must supply evidence to the authorized company reporter.
