# Razor billing contract

Dedicated NEAR token receiver for optional company software subscriptions. It does not hold payroll, client reserves or company treasury balances. Deploy and initialize atomically using the reviewed artifact and the [billing operator guide](../../docs/billing-operations.md).

`new` accepts `owner_id`, `token_contract`, `network` and an `ed25519:` `issuer_public_key`. Mainnet accepts only canonical native NEAR USDC. The application requires six token decimals and registered token storage before checkout. The merchant owner must be distinct from the contract account. The server issuer signs offers and cannot debit wallets, refund or withdraw funds.

Views: `get_config`, `get_invoice({invoice_id})`, `get_refund({refund_id})`. Accepted token transfers use `ft_transfer_call` with a JSON envelope containing the exact `quote_json` and its base58 `signature`. The signed quote binds invoice/company/plan identifiers, payer, receiver contract, token, network, microUSDC amount, terms hash and a bounded expiry. The sender must be the signed payer. Invalid or duplicate invoices return the transfer; excess funds return to the same sender. NEAR gas remains payable.

The owner can call `set_paused({paused})`, `set_issuer_key({issuer_public_key})`, `refund_payment({invoice_id,refund_id,amount})` and `withdraw({amount})`, each with exactly one yoctoNEAR. Refunds only return to the original payer and cannot exceed the remaining invoice amount. Withdrawal only pays the owner and available reserve. Matching private callbacks restore failed transfers once; unresolved transfers remain pending without a timer-based second attempt. Collection pause preserves refunds. The owner can top up reserve through token `ft_transfer_call` message `razor-billing-reserve`.

The contract records opaque commercial identifiers and financial amounts publicly. Private company invoice documents remain in encrypted application storage. Contract receipts prove collection/refund, while SQLite applies frozen commercial periods and quotas. Contract code/configuration and receipts are read at the same final block before subscription activation. Testnet evidence does not prove mainnet USDC revenue.

```sh
CARGO_TARGET_DIR="$PWD/.tools/cargo-target" cargo test --locked --jobs 1 --manifest-path contracts/razor-billing/Cargo.toml --lib
```

Build the release WASM with the serialized repository build script. This source requires a fresh billing deployment; no legacy-state migration is provided.
