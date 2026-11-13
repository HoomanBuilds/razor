# Retained NEAR token holdings

Razor can hold owner-approved NEP-141 tokens in the company NEAR treasury without immediately converting them to operating USDC. This is an optional treasury workflow. Payroll, bills, payment reservations and cash availability continue to use canonical company USDC only.

## Supported scope

- New approvals and deposits use the current NEAR Intents mainnet catalog, restricted to exact `nep141:<NEAR token contract>` identities. External-chain native assets and native NEAR are outside this holding flow. Native NEAR is not automatically wrapped.
- The application compares catalog contract, symbol and decimals with the token contract's `ft_metadata`. The owner explicitly signs each allowance. A treasury can register at most 16 token contracts over its lifetime.
- Canonical company USDC cannot be registered, deposited with the retained message, refreshed or withdrawn through the retained-token methods.
- Retiring a token disables new retained deposits. Existing holdings stay visible and withdrawable even when the token leaves the catalog. An approved token's recorded identity and decimals cannot be changed.
- This contract state layout requires a new reviewed treasury deployment. It does not silently reinterpret older contract state.

## Funding and withdrawal

1. The company owner reviews and signs an exact token allowance.
2. A company member with payment preparation permission selects a verified NEAR wallet holding that token. The application checks its actual balance and prepares any required token storage registration.
3. The wallet calls the token's `ft_transfer_call` with the company treasury receiver, exact base-unit amount and `razor:retain` message. The contract observes the token's actual treasury balance rather than trusting the announced transfer amount.
4. Holdings show token quantity, observed time, recorded contract quantity and any discrepancy. A discrepancy requires a signed balance refresh before withdrawal.
5. The owner can withdraw actual held token units to their verified NEAR wallet. The preview includes network, token contract, signer, quantity, receiver, storage deposits and wallet calls. There is no automatic conversion to payroll cash.

The application checks the reviewed treasury code hash before preparing operations. Wallet signing checks the configured NEAR network, exact required signer and preview expiry. Deposits and withdrawals are unavailable while company execution is paused; balance observations, retirement and callback reconciliation remain available.

## Accounting and valuation

Retained token balances never credit `treasury_balances`, payment reserves, income records or available USDC. Final deposit receipts are stored as encrypted, deduplicated retained-token audit events with actor and token identity.

Quantities use the originally approved token decimals. Indicative USD values require verified current catalog identity, an observed quantity, no unresolved withdrawal and a usable catalog price. Calculation uses integer arithmetic. Values are not executable quotes or proof of liquidity. When the provider supplies no price update time, the interface identifies the catalog observation time and explicitly says that the provider update time is unavailable. Catalog failure does not hide observed quantities or block withdrawal of previously approved tokens.

## Pending transfers and recovery

Withdrawals debit the recorded quantity before dispatch and carry a unique withdrawal ID. Only one withdrawal per token can remain pending. Definitive failure restores the debit once. Duplicate or older callbacks cannot restore it again. Balance probes use epochs so an older observation cannot overwrite a later deposit, withdrawal or reconciliation.

A missing callback stays unresolved. Neither elapsed time nor a balance probe proves that a transfer failed. The recovery API requires a FINAL original transaction, the exact treasury withdrawal event and a linked child token-transfer receipt bound to token, receiver, amount and withdrawal ID. Successful receipts also require the corresponding NEP-141 transfer event. An owner then signs an explicit outcome attestation, which the contract trusts, followed by a fresh token balance observation.

Ownership transfer requires the treasury to be paused, zero pending USDC source callbacks, zero unresolved payment settlements, zero pending retained withdrawals and a reachable approval quorum after the ownership change. A bounded counter tracks active payments through source, delivery and verified refund completion. Cancellation and reconciliation continue to work while paused.

## Integration

- Mount `retainedAssetRoutes` from `src/server/retained-assets/index.ts` at the authenticated organization path `/retained-assets`.
- Render `RetainedAssetsPanel` from `src/components/workspace/retained-assets.tsx` inside the treasury workspace.
- Migration `024-retained-assets.sql` stores retained deposit evidence. Existing database migration discovery applies it normally.
- Contract views: `get_retained_assets`, `get_retained_asset`; `get_config` advertises `retained_assets_enabled` and `max_retained_assets`.
- Contract actions: `set_retained_asset`, `refresh_retained_balance`, `withdraw_retained_asset`, `recover_retained_withdrawal`. Owner actions require one yoctoNEAR; refresh requires none.

Focused TypeScript fixtures cover token identity, amount and price boundaries, source receipt binding, permission checks, pause handling, delisted withdrawals, registry limits and unchanged USDC accounting. Rust fixtures cover retained balances, stale observations, withdrawal callback idempotency, retirement and ownership recovery. Live wallet, token storage, catalog and settlement behavior still require deployment credentials and actual NEAR receipts; local fixtures do not establish live settlement.
