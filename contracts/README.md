# Shared NEAR treasury and company registration

`razor-treasury` is deployed once. It holds separately accounted company balances and enforces each company's owner, approval policy, budgets, recipients, exact payment attempts and recovery states. Company activation registers state inside that contract, without creating another NEAR account or copying its WASM code.

`razor-clearing` verifies each participant's registration in that shared treasury before accepting invoice-setoff consent or finalization. Optional subscription collection uses `razor-billing`. The old `razor-factory` source is retained as legacy reference and is excluded from the supported build/deployment path. It must not be used to deploy the shared contract as an isolated child.

## Build and verify

Use Rust with the `wasm32-unknown-unknown` target and Binaryen `wasm-opt` version 130. Check available memory and stop development servers before building. The guarded scripts serialize compiler activity and use one Rust build job.

```sh
bash contracts/build.sh
bash contracts/check.sh
```

The build optimizes treasury, clearing and billing separately, validates the WASMs and publishes their hashes in `.tools/wasm/manifest.json` with architecture `shared_v1` and `treasuryStateVersion: 3` and `clearingStateVersion: 2`. Artifacts and compiler caches remain ignored. Deployment planning verifies each exact file against this manifest; stale manifests are rejected. Treasury version 3 includes standing authority, claimable distributions and creation tombstones; clearing version 2 includes optional cash-backed rounds. Use fresh empty deployment accounts with atomic initialization. Populated earlier treasury or clearing state cannot be upgraded with these artifacts; no migration is implemented. See [native standing authority](../docs/specs/native-standing-authority.md).

The release build keeps checked arithmetic, LTO and one codegen unit. Binaryen first runs `-Oz`, then refines that artifact with `-Oz --converge` and retains the smaller valid result. The manifest records the effective Rust optimization level, Binaryen version and pass strategy. Build size is measured rather than inferred from a flag name.

The native checks exercise financial state machines and company isolation. The optional actual-WASM runtime tool is documented in [wasm-checks/README.md](wasm-checks/README.md). These are local checks, not live settlement or measured mainnet gas evidence. For a behavior/gas/storage comparison against a preserved current-layout baseline, run `bash contracts/check.sh --shared-compare /absolute/baseline-directory`. Legacy isolated artifacts are incompatible with this current shared-layout comparison.

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

## Measured optimization review, 14 November 2026

Contract source `893e470` preserves treasury state version 3, clearing state version 2, canonical approval hashes, public exports/imports and stored financial state. It computes company collection prefixes once instead of repeating twelve SHA-256 calls, reuses a payment hash for route-status calculation and avoids a second clearing-manifest parse/clone. Billing token-transfer callbacks inspect bounded result status without copying unused response bodies; oversized successful responses cannot restore already transferred funds. Checked arithmetic, approvals, callbacks and financial features remain enabled.

| Artifact | Before, bytes | After, bytes | Bytes saved |
| --- | --- | --- | --- |
| Shared treasury | 663,687 | 663,385 | 302 |
| Clearing | 332,649 | 332,296 | 353 |
| Billing | 181,483 | 181,298 | 185 |
| Total | 1,177,819 | 1,176,979 | 840 |

This is a modest 0.0713% code-size reduction. Four Binaryen strategies and an actual Rust `s` build were measured; the larger variants were rejected and Rust `z` remains configured. No claim of globally minimal bytecode or gas is made. The shared architecture still avoids deploying this code for each company. Actual company state and registration storage allowances did not shrink.

The pinned local runtime comparison used 178 scenario calls for each artifact set, 356 executions in total. Returns, semantic errors, event bytes, promise actions, persisted trie state and committed state-storage deltas matched; Rust panic source coordinates are normalized while raw diagnostics are retained. Every sampled candidate call used no more burnt gas than its baseline. Successful company registrations fell from about 1.9303-1.9306 to 1.7217-1.7220 local Tgas, a 10.8% reduction. Sampled clearing round registrations fell 3.6% to 4.9%. These are local VM measurements, not transaction totals or measured mainnet fees; protocol88 is requested but the pinned runtime's latest applicable configuration is 84. Query-only methods do not incur wallet gas when accessed through ordinary RPC views.

Validation passed 89 native contract checks (58 treasury, 21 clearing, 10 billing), the comparison tool's diagnostic-normalization unit check and 11 application artifact/deployment/storage checks. An unsigned core deployment plan was regenerated against current artifacts without network signing or submission. Final hashes are in ignored `.tools/wasm/manifest.json`; do not reuse earlier code-hash pins.

A read-only mainnet snapshot at final block `224496430` (`9GRzEY72GamaJc2JwaQP63eB9gNpZJKxhy1CYcp3ABxo`, protocol88) reported `10^19` yoctoNEAR per byte and `10^8` yoctoNEAR per gas. Code storage stake for all three artifacts therefore changes from 11.77819 to 11.76979 NEAR, saving 0.0084 NEAR. This excludes initial state, accounts, keys, receipts, token registration, principal, routing and operating buffers. Code stake remains locked while that code is retained; Razor's immutable code does not provide a code-storage refund operation. Deployment action protocol fees are separate from storage capital and do not represent the full deployment bill. See [NEAR storage staking](https://docs.near.org/protocol/storage/storage-staking) and [block-specific gas prices](https://docs.near.org/api/rpc/gas).

Reproduction evidence is saved in ignored `.data/contract-optimization-*` logs and summary JSON, with the exact pre-change artifacts in ignored `.tools/contract-optimization-2026-11-14/before/`. These are reference measurements, not runtime fee configuration. No live deployment or token transfer was performed. Live settlement, missing-callback recovery limits and remaining product work retain their open checklist status.
