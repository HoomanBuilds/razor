# Shared NEAR treasury and company registration

`razor-treasury` is deployed once. It holds separately accounted company balances and enforces each company's owner, approval policy, budgets, recipients, exact payment attempts and recovery states. Company activation registers state inside that contract, without creating another NEAR account or copying its WASM code.

`razor-clearing` verifies each participant's registration in that shared treasury before accepting invoice-setoff consent or finalization. Optional subscription collection uses `razor-billing`. The old `razor-factory` source is retained as legacy reference and is excluded from the supported build/deployment path. It must not be used to deploy the shared contract as an isolated child.

## Build and verify

Use Rust with the `wasm32-unknown-unknown` target and Binaryen `wasm-opt` version 130. Check available memory and stop development servers before building. The guarded scripts serialize compiler activity and use one Rust build job.

```sh
bash contracts/build.sh
bash contracts/check.sh
```

The build optimizes treasury, clearing and billing separately, validates the WASMs and publishes their hashes in `.tools/wasm/manifest.json` with architecture `shared_v1` and `treasuryStateVersion: 2`. Artifacts and compiler caches remain ignored. Deployment planning verifies each exact file against this manifest; stale manifests are rejected. Version 2 adds standing-authority collections to each company's Borsh state. Use fresh empty deployment accounts with atomic initialization. Populated version-1 state cannot be upgraded with these artifacts; no migration is implemented. See [native standing authority](../docs/specs/native-standing-authority.md).

The native checks exercise financial state machines and company isolation. The optional actual-WASM runtime tool is documented in [wasm-checks/README.md](wasm-checks/README.md). These are local checks, not live settlement or measured mainnet gas evidence.

## Operator deployment

Choose distinct funded shared-treasury, clearing and owner accounts. Generate unsigned deployment commands with:

```sh
npm run prepare:deployment -- --network mainnet --treasury YOUR_TREASURY.near --clearing YOUR_CLEARING.near --owner YOUR_OWNER.near
```

The treasury initializes atomically with `new({owner_id,token_contract})`. Clearing initializes with `new({owner_id,treasury_id,token_contract})`. The planner fixes mainnet to canonical native NEAR USDC. Testnet requires `--testnet-token`; it cannot establish live Intents support. Add the billing arguments documented in [billing operations](../docs/billing-operations.md) when using paid checkout.

Create fresh deployment accounts, review code-storage stake and gas, and deploy with initialization in the same transaction. Register the shared treasury on its USDC token once using the token's live `storage_balance_bounds` and `storage_deposit`. Verify code, configuration and registration with `npm run check:setup -- --remote`. No contract deployment or funds are created by the planner or preflight.

Set `NEAR_TREASURY_ID`, `NEAR_TREASURY_CODE_HASH`, `NEAR_CLEARING_ID` and `NEAR_CLEARING_CODE_HASH` from the reviewed deployment. This is a new storage layout and ABI; do not deploy it over an existing isolated treasury, factory or clearing state. Existing funds require a separate explicit migration or withdrawal workflow.

A deployment account with a full-access key can replace contract code. After code/configuration verification, token registration and owner-role setup, review and remove every access key from the deployed contract accounts before company funding. Confirm an empty `view_access_key_list` at finality. This makes code immutable and removes future upgrade/account-deletion access; separate company and platform owner accounts retain their contract roles. Do not remove keys from those owner wallets. The unsigned planner includes this key-retirement checklist, and remote setup blocks a shared treasury with remaining keys. Shared code concentrates the impact of an implementation defect. Company isolation must be checked in both the contract and application.

## Company activation

1. Sign in and create the application company, then link and verify its NEAR owner wallet.
2. Razor binds the company to an onchain ID formed from its organization UUID and the hash suffix of its initial owner. The identifier stays fixed through ownership transfer.
3. Read `get_platform_config()` and `quote_registration({company_id})`. Check the reviewed code hash, `architecture: "shared_v1"`, native settlement token, registration allowance and selected network.
4. Sign `register_company({company_id,per_payment_limit,daily_limit})` with the quoted storage deposit. Limits are microUSDC strings. The owner comes from the transaction predecessor; it is not a client-supplied owner argument.
5. Confirm the final `get_company({company_id})` record and save the shared account plus exact onchain company ID. Every later config, balance, payment and callback is company-scoped.

The registration deposit funds the company's initial state allowance. It excludes another code deployment or account creation. Gas remains additional. `get_storage({company_id})` reports storage credit, used and available values in yoctoNEAR; `add_storage({company_id})` funds further history. Neither operation deposits USDC or pays a software subscription.

## Funding, execution and recovery

NEP-141 funding uses `ft_transfer_call` with a strict message identifying the company and unique deposit ID. Cross-chain funding asks NEAR Intents for the same `customRecipientMsg`. The provider quote must preserve that message and the shared destination. Credit is proven by the final token receipt plus `get_deposit({company_id,deposit_id})`, not a pooled account balance or client-submitted transaction hash alone.

Direct transfers without attribution are not assigned to a company. Company refresh reads its contract ledger and never copies `ft_balance_of(shared-account)` into one company's cash. A duplicate deposit ID cannot credit a second company.

Approvals, execution, retained assets, callbacks, withdrawals and refunds carry the exact onchain company ID. The platform refund reporter is a trusted attribution role for unmatched external refunds; it must verify final evidence before submitting a globally deduplicated refund claim. Global liabilities and pending transfers remain protected. A missing callback or unknown route does not permit a second payout.

Private payroll documents and identity records remain offchain. NEAR balances, calls and settlement amounts are public. See [treasury ABI](razor-treasury/README.md) for the complete financial methods and trust boundaries.
