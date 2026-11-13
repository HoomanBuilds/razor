# Razor treasury

A NEAR contract holding one configured NEP-141 native USDC token for company payroll, contractor and supplier obligations. The application converts supported funding assets through NEAR Intents before they enter this treasury. Token amounts use integer microUSDC strings. Each company deploys its own treasury account and retains a separate owner account for recovery.

## Build

```sh
cargo test --locked --lib
cargo build --locked --target wasm32-unknown-unknown --release
```

The artifact is `target/wasm32-unknown-unknown/release/razor_treasury.wasm`. Rust 1.86 or newer is declared; development checks use Rust 1.92 and near-sdk 5.26.1. No contract is deployed by these commands.

Before funding, register the treasury account with the configured USDC contract's storage management interface. Direct NEAR recipients and Intents deposit accounts must also accept that token. Keep enough native NEAR in the treasury for storage and the 1 yoctoNEAR attached to each FT transfer.

## Trust and accounting

- The owner configures the genuine native USDC contract for the selected NEAR network. The contract does not infer a token's issuer from its name.
- Only owner-appointed approvers reserve funds and authorize exact routes. Executors can propose obligations, prepare routes and execute approved routes. Their automatic spending trust budget is always zero. A NEAR function-call key's gas allowance is separate from these monetary limits.
- Each immutable obligation binds a unique reference, recipient revision, entitlement, fee ceiling and expiry. Recipient or policy changes require fresh approval or cancellation and a new obligation. Reusing an obligation reference is rejected even after cancellation.
- A route binds source deposit account, exact input, exact output, quote identifier, quote hash and expiry to one attempt. The owner or approver must verify the quote's destination, refund destination, valuation and provider terms before authorizing it. The contract cannot validate a remote provider's quote hash itself.
- Reservations prevent concurrent obligations from spending the same cash. Input amounts consume UTC daily limits before the FT promise is issued. A failed FT transfer restores the input and daily allowance; if released fee headroom was spent concurrently, the obligation is held until funded again.
- Intents source transfer success means `source_sent`. It never means the employee or supplier has received payment. Only direct NEAR USDC transfer success closes delivery without an external settlement report.
- The owner or explicitly configured settlement reporter attests external delivery and route closure. This authority can misreport external state. A receipt is an audit reference, not a contract-verified external-chain proof. No worker receives this authority by default.
- A refund needs both a trusted closure attestation and an actual `ft_balance_of` check. Cash is replaced with the observed token balance, never increased synthetically by the claimed refund. Lost input reduces the remaining fee budget. Existing company cash may support a reservation only after that explicit attestation; the balance observation alone cannot establish refund provenance.
- Backup execution is blocked while the prior route may still deliver. There is no timeout refund or automatic fallback. Only an unsent prepared route, failed source transfer or verified closed refund permits another attempt.
- The owner can recover a missing source callback using a final NEAR receipt. Declaring failure is safe only after proving the transfer cannot later execute. A subsequent callback is idempotent. Owner withdrawals use unreserved funds; pause does not prevent cancellation, reconciliation or owner recovery.
- Recipient consent is recorded by the owner from the application's authenticated preference flow. This contract does not verify an employee's off-chain identity or signature.

The treasury does not provide confidential balances, zero-knowledge privacy, insurance, fiat off-ramps or tax calculation. Contract state and event data are public. Keep personal payroll details off-chain; use opaque references.

## JSON interface

Amounts and timestamps below are decimal strings because the ABI uses `U128` and `U64`. IDs accept UUID strings. Owner, approver and executor identities are NEAR account IDs, never application session IDs.

Initialize once:

```json
{
  "owner_id": "company-owner.testnet",
  "token_contract": "configured-usdc.testnet",
  "per_payment_limit": "1000000000",
  "daily_limit": "10000000000"
}
```

Call this object with `new`. Examples use placeholder testnet token accounts, not verified deployments.

Views:

| Method | Arguments | Result |
| --- | --- | --- |
| `get_config` | `{}` | `owner_id`, `token_contract`, `paused`, limits, `policy_version`, `settlement_reporter`, zero `executor_trust_daily_budget`, approvers and executors |
| `get_balance` | `{}` | Confirmed `balance`, `reserved`, `available`, `in_flight`, `confirmed_at_ms` |
| `get_payment` | `{ "payment_id": "..." }` | Payment or null, including all attempts |
| `get_attempt` | `{ "payment_id": "...", "attempt_id": "..." }` | Attempt or null |
| `get_recipient` | `{ "recipient_id": "..." }` | Versioned recipient or null |
| `get_obligation` | `{ "reference": "..." }` | Existing payment ID or null |
| `get_backup_asset` | `{ "network": "near" }` | Owner-verified native USDC asset ID or null |
| `get_daily_spend` | `{ "day": "20769" }` | Source amount spent in UTC epoch day |
| `list_payments` | `{ "from_index": 0, "limit": 25 }` | Up to 100 payments |

Company setup, each requiring owner authorization and exactly 1 yoctoNEAR:

| Method | Arguments |
| --- | --- |
| `set_paused` | `{ "paused": true }` |
| `set_policy` | `{ "per_payment_limit": "...", "daily_limit": "..." }` |
| `set_role` | `{ "account_id": "...", "role": "approver", "enabled": true }`; role may also be `executor` |
| `set_settlement_reporter` | `{ "account_id": "reporter.testnet" }`; null removes the reporter |
| `transfer_ownership` | `{ "new_owner_id": "..." }` |
| `set_backup_asset` | `{ "network": "base", "asset_id": "verified-catalog-asset-id" }`; null disables |
| `set_recipient` | Recipient object below |

`set_backup_asset` accepts NEAR, Base, Arbitrum, Polygon, Solana and Ethereum network names, including the catalog aliases `arb`, `pol`, `sol` and `eth`. The owner must verify the exact native USDC asset ID and six decimals against the live catalog. Only the configured NEAR treasury token is enabled at initialization. A registry change invalidates prior policy approval.

```json
{
  "recipient_id": "recipient-uuid",
  "primary": {
    "asset_id": "nep141:configured-usdc.testnet",
    "network": "near",
    "address": "employee.testnet"
  },
  "backup": null,
  "backup_consent": false,
  "active": true
}
```

`backup` has the same destination shape and must match the configured USDC registry. Setting the recipient always increments its version. Read before preparing wallet actions and omit unchanged recipient updates.

Payment actions in order:

1. Executor `propose_payment({payment_id,recipient_id,amount,max_fee,expires_at_ms,reference})`, zero deposit. The entitlement is denominated in microUSDC even when the recipient chooses another asset.
2. Approver `approve_payment({payment_id})`, 1 yoctoNEAR. Reserves entitlement plus remaining approved fees from confirmed cash.
3. Executor `create_attempt({payment_id,attempt_id,use_backup,route})`, zero deposit. Route shape below.
4. Approver `authorize_attempt({payment_id,attempt_id})`, 1 yoctoNEAR.
5. Executor `execute_payment({payment_id,attempt_id})`, zero deposit and at least 50 Tgas. 100 Tgas is recommended for wallet actions.

```json
{
  "kind": "intents",
  "source_receiver": "quoted-deposit.testnet",
  "input_amount": "100500000",
  "output_amount": "100000000",
  "quote_id": "provider-correlation-id",
  "quote_hash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "deadline_ms": "1800000300000"
}
```

For `kind: "direct"`, destination must be NEAR treasury USDC, `source_receiver` must equal the recipient account and input/output must equal the entitlement. Quotes for registry-recognized USDC or any backup must also output the exact entitlement. Other primary asset outputs are fixed at the explicitly approved quoted amount. The quote hash must be SHA-256 of the application's exact serialized provider response, including destination and refund terms.

Read on-chain state when resuming partial wallet batches. Do not blindly repeat setup and proposal calls. An executor can `discard_attempt({payment_id,attempt_id})` only while the latest route is still prepared and unsent. Create a replacement with a new attempt ID and authorize it again. Never replace a route that may already deliver.

Reconciliation actions, zero deposit unless noted:

| Method | Authority and arguments |
| --- | --- |
| `report_settlement` | Owner or reporter: `{payment_id,attempt_id,outcome,receipt}`; outcome is `delivered`, `uncertain` or `refund_pending` |
| `confirm_refund` | Owner or reporter: `{payment_id,attempt_id,refund_amount,receipt}` after `refund_pending`; queries actual token balance |
| `recover_source_transfer` | Owner, 1 yoctoNEAR: `{payment_id,attempt_id,succeeded,receipt}`; only a still-`sending` attempt with conclusive source receipt evidence |
| `cancel_payment` | Approver, 1 yoctoNEAR: `{payment_id}`; only obligations without a potentially delivering attempt |
| `refresh_balance` | Anyone: `{}`; call with at least 40 Tgas and no pending source callback |
| `withdraw_available` | Owner, 1 yoctoNEAR: `{receiver_id,amount}`; only unreserved cash |

`ft_on_transfer({sender_id,amount,msg})` accepts empty messages and only the configured token predecessor. Its async balance query observes cash instead of trusting additive credits. If a source callback is pending, it accepts the deposit and leaves cash recognition to a later `refresh_balance`. Direct FT transfers that do not invoke `ft_on_transfer` also require `refresh_balance`.

Payment states are `proposed`, `approved`, `in_flight`, `retryable`, `recovery_pending`, `held`, `paid`, `cancelled`. Attempt states are `prepared`, `discarded`, `sending`, `source_sent`, `uncertain`, `refund_pending`, `refund_verifying`, `refunded`, `transfer_failed`, `delivered`. Full serialized field definitions are in `src/types.rs`. Private callbacks are called only by this treasury account. Events follow NEP-297 with standard `razor`, version `1.0.0`.

NEAR's independent asynchronous receipts require explicit callback recovery, as described in the [official cross-contract documentation](https://docs.near.org/smart-contracts/anatomy/crosscontract).

## Reused source

The FT promise/callback pattern, confirmed-balance reconciliation and failure accounting adapt [Agent Treasury](https://github.com/iskander-kudashev-13/agent-treasury). Exact owner-authorized Intents deposit terms and zero default executor trust adapt [GetLeash](https://github.com/Onasachi/Getleash). Source is pinned to a compatible SDK rather than copying their newer dependency requirements. Required MIT notices are preserved in `NOTICE`.
