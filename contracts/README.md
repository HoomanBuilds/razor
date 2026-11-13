# NEAR contracts and self-service setup

`razor-treasury` holds company USDC, enforces approvals and budgets, and funds exact NEAR Intents routes. `razor-factory` lets a payer create a treasury from their own NEAR wallet. The deployed child has no access keys; the caller's existing NEAR account becomes its contract owner. The factory receives no authority to spend its USDC.

## Build

```sh
./contracts/build.sh
```

Requires Node 24.22.1 or later, Rust 1.86 or newer, the installed `wasm32-unknown-unknown` target and [Binaryen version 130](https://github.com/WebAssembly/binaryen/releases/tag/version_130). Put `wasm-opt` on PATH or set `WASM_OPT` to its executable. The contracts pin near-sdk to 5.26.1.

The script builds and optimizes the treasury first, embeds those exact optimized bytes into the factory, then builds and optimizes factory, clearing and billing. Binaryen uses `-Oz`, strips debug/function names and producer metadata, and preserves the compiler's WebAssembly feature metadata. Factory memory packing is skipped so the embedded treasury remains byte-verifiable. Overflow checks, financial guards, serialized state and public methods remain intact.

Artifacts are staged and validated before publication under ignored `.tools/wasm`. The manifest records the optimizer version and final deployment hashes. Use these optimized artifacts for deployment; raw Cargo target files have different sizes and hashes. The build shares the application compiler lock, uses one Cargo job and one optimizer thread, and applies the same available-memory guard. Set `CARGO_TARGET_DIR` to reuse a build cache. No binary needs to be committed.

For focused checks:

```sh
CARGO_TARGET_DIR="$PWD/.tools/cargo-target" cargo test --locked --jobs 1 --manifest-path contracts/razor-treasury/Cargo.toml --lib
RAZOR_TREASURY_WASM="$PWD/.tools/wasm/razor_treasury.wasm" CARGO_TARGET_DIR="$PWD/.tools/cargo-target" cargo test --locked --jobs 1 --manifest-path contracts/razor-factory/Cargo.toml --lib
```

Run all four native suites through the shared memory/compilation guard with `bash contracts/check.sh`. Pass a baseline artifact directory as its optional argument to also run the actual-Wasm comparison.

Tests run locally with NEAR's SDK. They do not deploy or spend funds.

For changes to code generation or optimization, the optional [built Wasm compatibility tool](wasm-checks/README.md) compares real baseline and optimized modules using NEAR's local runtime. Its results supplement native unit checks and do not establish live mainnet execution.

The dedicated [billing contract](razor-billing/README.md) collects optional software subscriptions separately from company funds. Its deployment is optional in the planner until paid checkout is enabled.

## Platform setup

An operator must deploy `razor_factory.wasm` to a funded NEAR account and initialize it atomically with:

```json
{
  "owner_id": "factory-admin.testnet",
  "token_contract": "verified-native-usdc.testnet"
}
```

The token account above is a placeholder. Verify the genuine native USDC contract for the selected network and ensure the application uses the same network and token. The factory's token choice is fixed at initialization. Initialize the factory in the deployment transaction to avoid an uninitialized deployment being claimed by someone else.

The operator must fund the factory's own deployed code/storage stake and native NEAR gas reserve. Configure its account in the application's environment for that network. This repository does not publish a factory address or claim that a factory has been deployed.

## Payer setup

1. Connect the payer's NEAR wallet and call `get_config({})` on the configured factory. Verify its token, pause state and embedded treasury hash against the reviewed artifact. `treasury_wasm_hash` is base58 SHA-256, matching NEAR's RPC `code_hash` encoding.
2. Call `quote_creation({owner_id,slug})` as a view. The owner must be the wallet account that will submit creation. Slugs contain 1 to 24 lowercase letters, digits or hyphens and cannot start or end with a hyphen. The generated account also contains an owner hash, and its full NEAR account ID must fit 64 characters.
3. Sign `create_treasury({slug,per_payment_limit,daily_limit})` with the quoted `minimum_deposit` and 150 Tgas. Monetary limits are microUSDC strings. The owner is always the predecessor wallet, not a freely supplied argument.
4. Poll `get_treasury({owner_id,slug})`. Only `status: "ready"` proves the account, code and initialization batch succeeded. Duplicate owner/slug requests are rejected before another deployment is scheduled.
5. Query `storage_balance_bounds({})` on native USDC and `storage_balance_of({account_id})`. If unregistered, sign the token's `storage_deposit({account_id,registration_only:true})` with the live minimum. Treasury creation does not register token storage or prove cash has arrived.
6. Verify the child with `get_config`, then save the company-to-treasury association. The owner can appoint approvers, executors and an optional trusted settlement reporter, then configure amount-dependent distinct-wallet approval tiers. Fresh treasuries require one approval until the owner changes that policy. Other NEAR and external-chain funding assets enter through NEAR Intents before becoming treasury USDC.

The creation quote returns `account_id`, `owner_id`, `token_contract`, `treasury_wasm_hash`, `minimum_deposit`, `treasury_funding` and `factory_storage_fee`. All deposit fields are decimal yoctoNEAR strings, including the minimum. The minimum covers deployed code bytes, 8 KiB of initial treasury state, a 0.05 NEAR operating reserve and 2 KiB of factory record storage. Code storage makes this larger than a token transfer. Quote the live amount in the UI. Gas and token storage registration are separate. Any amount above the minimum goes to the child; the factory retains its disclosed record-storage allowance.

## Creation recovery

`get_creation({account_id})` and `get_treasury({owner_id,slug})` return the same record: account, owner, slug, generation, token, monetary limits, `status`, `treasury_funding`, `factory_storage_fee`, `refund_amount` and `created_at_ms`. Status is `pending`, `ready`, `failed`, `refunding` or `refunded`.

A failed atomic create/deploy/init batch records a claim for the full forwarded treasury funding. Its native NEAR refund may arrive after the callback. The owner calls `claim_refund({slug})` with exactly 1 yoctoNEAR and at least 40 Tgas once the factory has available cash. Only that owner's failed record can be claimed. A failed refund transfer restores the claim. The factory's record-storage allowance remains with the factory. After `refunded`, the same owner and slug can be created again with a new generation; stale callbacks cannot change it.

For a missing creation callback, `refresh_creation({owner_id,slug})` with zero deposit and at least 40 Tgas probes the child's initialized configuration. A matching owner, token and limits recover `ready`. A failed probe remains `pending`, since lack of a response cannot prove the original batch will never create the account. There is no automatic timeout refund. A missing refund-transfer callback remains `refunding` and needs operator investigation of its final NEAR receipt; the contract never unlocks a second refund on a timer.

The factory admin can pause new creation with `set_paused({paused})` and exactly 1 yoctoNEAR. Pausing leaves status reads and recovery available. Private callback methods are internal.

Payment settlement, refund trust boundaries and the complete treasury ABI are documented in [razor-treasury/README.md](razor-treasury/README.md). Company balances remain public on NEAR. The factory creates immutable keyless children; changing their deployed code is not supported by this version.

Full external delivery calls now include `actual_output` in destination base units: `report_settlement({payment_id,attempt_id,outcome:"delivered",receipt,actual_output})`. Missing or short output cannot close a payment as paid. Terminal short delivery uses the separate `report_partial_settlement({payment_id,attempt_id,expected_quote_hash,actual_output,credited_amount,route_closed:true,receipt})` interface. `credited_amount` is an explicitly reviewed microUSDC entitlement credit. The application records this terminal result before preparing an independently approved remainder. See the treasury ABI for output bounds, reporter trust and deployment compatibility.
