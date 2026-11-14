# Native supplier standing authority

This optional G07 mode removes repeated onchain route signatures for an already accepted native-USDC supplier bill. It does not approve invoice contents. The existing exact-route workflow remains available, including during the supplier activation delay. Cross-chain standing execution stays disabled.

## Owner grant and supplier scope

The Automation screen lets the company owner propose immutable terms for one confirmed business supplier receiving native NEAR USDC without a memo. The owner reviews the exact NEAR grant transaction with supplier/profile version, destination, dedicated executor account and public key, per-payment maximum input, anchored period and lifetime maximum input, start, expiry and the application invoice condition. A grant has at most 366 days of validity and a period from 1 to 366 days.

The company owner's signature starts the grant. The highest current company approval quorum must also activate those exact terms. Policy changes invalidate existing authority. The executor must remain a dedicated executor account, distinct from owner and approvers. Changing its key requires a new reviewed grant.

Creating a new grant rebinds the current onchain recipient and starts a fresh 24-hour activation delay. Changed receiving details invalidate affected local automation and cannot regain eligibility by changing away and back. The contract checks the recipient's exact active version and destination at execution. The interface exposes holds and the exact-review alternative.

## Execution and budgets

Only an existing human-approved, funded, eligible bill may enter the worker. Supplier matching and purchasing commitments are application review gates. Their database checks are not advertised as contract enforcement of invoice truth, quantity or PO scope.

The NEAR contract constructs the direct native-token route itself. It checks the exact actor account and signer public key, current policy/quorum, recipient version, cooldown, expiry, per-payment/period/lifetime limits, available company funds and existing obligation identity. Limits charge principal plus the complete accepted fee ceiling as permanent authorized usage. Failed routing does not restore that usage. Pending input closes once through the matching callback. Usage is distinct from actual token spending; native direct settlement spends principal and reports actual outcomes separately.

The period is anchored to the grant's start time. Usage resets when execution enters a new period; it never rolls over. Pending or failed old-period work cannot reopen an allowance. New mandate terms require a new grant, rather than editing a previously signed limit.

The worker uses a separate key restricted to exactly `execute_standing_payment` on the reviewed treasury. Full-access keys, unrestricted method sets and other receivers are rejected. Configure these in the ignored service environment only after reviewing and installing that restricted key:

```text
RAZOR_STANDING_EXECUTOR_ACCOUNT_ID
RAZOR_STANDING_EXECUTOR_TREASURY_ACCOUNT_ID
RAZOR_STANDING_EXECUTOR_COMPANY_ID
RAZOR_STANDING_EXECUTOR_NETWORK=mainnet|testnet
RAZOR_STANDING_EXECUTOR_PRIVATE_KEY
```

Source signing is serialized with the existing exact-route worker. Signed bytes and the transaction hash are durably recorded before broadcast. Unknown results remain fenced; retry uses the same signed bytes, never a new payout. Actor audit records identify the executor's NEAR account and grant, while the bill retains its human application approver.

Owners can stop local execution immediately and prepare explicit onchain pause, resume or permanent revocation transactions. Monitoring and reconciliation continue after pause, expiry or revocation. In-flight funds remain liabilities until evidence resolves them. The interface shows grant usage, next reset, pending input and decision history. No wallet signature or callback fixture establishes a live payout.

## Deployment boundary

The shared treasury remains one code deployment for separate company ledgers. Its state-version-2 company layout adds standing mandate, standing payment and recipient activation collections. It cannot deserialize populated version-1 company state as an upgrade. No funded-state migration is implemented.

Rebuild reviewed artifacts before deployment. The artifact manifest and unsigned deployment plan require `treasuryStateVersion: 2`; stale manifests are rejected. Deployment plans are for fresh empty accounts with atomic initialization only. They neither inspect target accounts nor authorize replacing populated state. Existing funded deployments require a separately designed migration. Compilation and local NEAR runtime checks do not establish mainnet deployment or delivery.
