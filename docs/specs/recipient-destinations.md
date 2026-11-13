# Recipient destinations and preview support

Recipients choose an exact catalog asset, its network and their receiving address. Address validation uses the selected network's format and checksum where available. The asset catalog remains the source of current token support; an address format alone never selects a network or proves a payment can execute.

## Receiving tags and memos

- XRP accepts a classic address without a tag, or a classic address plus a whole-number destination tag from `0` through `4294967295`. Razor encodes a supplied tag into a mainnet X-address before saving the profile. A valid supplied X-address is retained, and its embedded tag is shown separately for review.
- An explicit tag must match an existing X-address. Changing that tag requires the classic address plus the replacement tag, or the correctly encoded replacement X-address. Test-network addresses and checksum failures are rejected.
- Separate receiving memos or comments on Stellar, TON and other networks are unsupported by the configured 1Click interface. A destination requiring one must use a compatible personal wallet or another supported route. Razor rejects a supplied unsupported memo rather than omitting it.
- The enabled USDC backup networks do not accept a separate receiving memo. Backup consent and the different-network rule for native-USDC primaries still apply.

The current official [1Click request model](https://github.com/defuse-protocol/one-click-sdk-typescript/blob/main/src/models/QuoteRequest.ts) carries the complete destination in `recipient`. It has no separate recipient memo field. Its `depositMode` concerns source deposits; `customRecipientMsg` is an experimental NEAR contract-call message and is not a general receiving memo. The [official chain address reference](https://docs.near-intents.org/resources/chain-support) documents XRP X-addresses and excludes classic addresses with separately supplied tags from 1Click.

The payer form, recipient confirmation form and optional CSV `primary_memo` column accept the XRP tag. Saved profiles expose `primary_memo` alongside the canonical `primary_address`. Both become part of each version and immutable payment snapshot. A payer edit clears prior confirmation and consent. A recipient change creates a new version; existing approved obligations retain their previous terms.

Payout preparation validates the exact stored destination again. An XRP tag reaches the signed quote and contract authorization through the full encoded address, which is also covered by the quote hash. Attempt records retain the selected tag for review and receipts. The application does not add an unsupported memo field to provider requests.

## Address validation

Validated families include NEAR accounts, EVM addresses, Solana/Fogo public keys, Bitcoin-family legacy and witness formats, supported Bitcoin Cash forms, XRP, Tron, Stellar, TON, Sui/Aptos/Movement, Starknet, Aleo and supported Cardano Shelley forms. Network prefixes, checksums and payload sizes are checked where their format provides them. Cardano destinations are limited to mainnet Shelley base or enterprise addresses. Zcash destinations are transparent addresses.

A newly cataloged network without a reviewed address validator is reported as unverified and cannot be saved or executed by guessing its family. Existing unavailable assets remain visible in saved preferences and payment history. Neither validation nor the catalog establishes address ownership, receiving-account activation, exchange deposit requirements, liquidity or final delivery.

## Batch preapproval previews

Payroll and invoice-batch previews show primary and backup support for every obligation snapshot, in addition to recipient confirmation, amounts, funding needs and cost ceilings:

- `supported`: the exact asset is in the current catalog on the matching network and the destination format passes validation.
- `unsupported`: the asset is absent, the backup network is disabled, or the backup lacks consent or complete details.
- `invalid`: the destination or metadata is malformed, or a native-USDC backup repeats its primary network.
- `unknown`: catalog data or reviewed address validation is unavailable.

Previews also flag missing non-USDC valuations. Catalog responses may be cached for up to 60 seconds. Every preview reports that it created no payable quote and cannot establish execution readiness. Amount limits, liquidity, current authority and actual costs are checked during payment preparation. A supported backup is never automatically selected by the preview.

Catalog health and its observation time are attached outside the review token. Changes to those transient observations do not invalidate otherwise unchanged approved terms. Immutable profile and payment terms remain bound to the review. Preview catalog calls run outside database transactions and do not create attempts, deposit instructions or source funding legs.

Focused checks cover canonical XRP vectors and tag boundaries, mismatches and unsupported memos, network validation, versioned confirmation, immutable snapshots, catalog outages and removals, disabled backups and read-only preview token stability. These are local checks, not live deposit or payout evidence.
