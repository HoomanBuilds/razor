# Operator setup and live verification

Razor starts without seeded users or funded balances. Configuration, deployed contract verification and completed financial workflows are different evidence. The commands below never establish that a payment happened merely because configuration is present.

## Check configuration

Use Node 24.22.1 or later. Create the ignored `.env.local` from `.env.example` and configure the values for your own deployment. Do not replace an existing data encryption key: older encrypted company records still require it. Back up the database and its original key together, with restricted access.

```sh
npm run check:setup
npm run check:setup -- --json
```

This checks runtime, browser origin, data-key format, Privy verification/profile configuration, NEAR network and artifacts, private inference, worker settings and optional email configuration. It does not create a database, mutate accounts, send email, send documents to an AI provider or sign transactions. Reports contain setting names and fixed explanations, without configured secret values.

A blocked result exits with status 1. Unsupported arguments exit with status 2. Optional email may be disabled while in-app notifications remain available. A successful configuration check still leaves the listed live journeys unverified.

## Deploy reviewed contracts

Build the shared treasury, clearing and billing contracts serially with `bash contracts/build.sh`, with Binaryen `wasm-opt` version 130 available. The treasury code is deployed once; company activation later adds company-specific state. Keep the optimized WASMs and `shared_v1` manifest under ignored `.tools/wasm/`. Choose distinct shared treasury, clearing and recoverable owner accounts. Optional paid subscription collection uses a separate billing deployment with a dedicated public issuer key; see [billing operations](billing-operations.md). Names in command arguments are operator choices, not published Razor deployments.

```sh
npm run prepare:deployment -- --network mainnet --treasury YOUR_TREASURY.near --clearing YOUR_CLEARING.near --owner YOUR_OWNER.near
```

Replace each example account with a valid account that you control before running the planner. It prints exact deploy-plus-initialize arguments and reviewed hashes. It does not create accounts, contact an RPC, sign or submit transactions. On testnet, provide `--network testnet` and an explicit `--testnet-token` account; testnet tokens never establish mainnet USDC or Intents settlement.

Review the output, fund your operator accounts for code/storage and gas, and run the exact atomic deployment and initialization transactions through your NEAR operator tooling. Never leave an uninitialized treasury or clearing deployment available for someone else to claim. Follow [NEAR's contract deployment documentation](https://docs.near.org/smart-contracts/release/deploy) and the repository's [contract setup](../contracts/README.md). These contracts require fresh deployments; no legacy treasury storage migration is provided. After verifying deployment, registering token storage and configuring recoverable owner roles, review the planner's key-retirement checklist and remove every access key from the deployed contract accounts with your operator wallet. Query `view_access_key_list` at finality and require an empty key list before company funds arrive. This makes their code immutable and prevents later upgrades or account deletion; owner-role operations still use the separate owner accounts. Do not remove owner-wallet keys. The remote shared-treasury check blocks accounts that still have access keys.

Copy the resulting public account IDs and code-hash pins into the matching `.env.local` fields. Mainnet shared treasury initialization must use the canonical native USDC token already defined by the application. Rebuild the app when changing `NEXT_PUBLIC_PRIVY_APP_ID`, because the browser bundle reads it at build time.

```sh
npm run check:setup -- --remote
```

Remote mode only reads public NEAR network, shared treasury/clearing configuration, code hashes, shared USDC registration and the configured worker's company-specific role and key permissions. It never signs or broadcasts a transaction. A paused treasury is reported as blocked. A matching public code hash establishes deployment identity, not security certification or a successful payment.

## Configure the live services

1. Configure Privy Google/email methods, allowed browser origins, matching server/browser app IDs, a valid ES256 verification key or HTTPS JWKS URL, and the app secret for verified profile/email retrieval. Create a new user, return after logout and exercise the provider's recovery flow. Linking a NEAR owner wallet remains separate from app sign-in.
2. Register native USDC storage for the shared treasury once as operator. Activate each company through its verified owner wallet with only the quoted company state allowance, verify its owner-bound onchain company ID, then refresh its company-scoped balance. NEAR Intents funding and payouts require mainnet; the app must keep testnet evidence separate.
3. Give a dedicated worker account the treasury executor role and a function-call key limited to that treasury's `execute_payment` method. It must not be the owner or an approver. Set the exact account, shared treasury, onchain company ID, network and private key in ignored environment configuration. Enable the bounded company mandate as its owner, then run `npm run worker -- --once` under supervision. That worker command can execute already authorized due routes; it is different from the read-only preflight.
4. Configure the NEAR AI model, API key, approved model/gateway compose hashes, retention period and attestation age. Review approved measurements before enabling inference. Send fictional documents through the actual application and retain successful required verification evidence, a rejection example and deletion/expiry results. Configuration alone cannot prove private inference.
5. For optional email, configure a verified Resend sender/domain and the transport key. A recipient must opt in with a verified email identity. Confirm actual arrival separately from provider acceptance; messages contain sign-in links without private payment details.

## Recover shared treasury callbacks and refunds

Set the shared treasury's `refund_reporter` to a dedicated recoverable operator account through its platform owner. Link that account to an actual Razor operator user using verified NEAR wallet linking. The operator does not need a company membership; the command verifies the current onchain platform reporter, reviewed treasury code, network and the selected company's immutable binding before granting a narrow local admin context. Audit entries retain the operator user's own identity.

Inspect the original final receipts first. This command reuses the application's exact provider, token-transfer and callback recovery checks. It cannot approve a timeout, move arbitrary funds or choose an unrelated recipient. Amounts below are integer microUSDC, so `1000000` is 1 USDC.

```sh
npm run recovery:admin -- --company COMPANY_ID --operator-user OPERATOR_USER_ID --account REPORTER.near --network mainnet --kind refund --attempt ATTEMPT_ID --hash REFUND_NEAR_TX_HASH --sender REFUND_TX_SIGNER.near --refund-amount 1000000
npm run recovery:admin -- --company COMPANY_ID --operator-user OPERATOR_USER_ID --account REPORTER.near --network mainnet --kind source --attempt ATTEMPT_ID --hash ORIGINAL_SOURCE_NEAR_TX_HASH --sender ORIGINAL_TX_SIGNER.near
npm run recovery:admin -- --company COMPANY_ID --operator-user OPERATOR_USER_ID --account REPORTER.near --network mainnet --kind retained --token RETAINED_TOKEN.near --hash ORIGINAL_WITHDRAWAL_NEAR_TX_HASH --sender ORIGINAL_TX_SIGNER.near
```

The default prints one verified unsigned call with the exact company, method, arguments, operator and zero attached deposit. Review it in the operator wallet. It records the review and receipt evidence without broadcasting. A refund transaction must appear in that route's provider report and match its final canonical USDC receipt. Source and retained recovery must reference the exact original transfer with a missing callback.

For optional CLI broadcasting, set `RAZOR_RECOVERY_ACCOUNT_ID`, `RAZOR_RECOVERY_NETWORK` and `RAZOR_RECOVERY_PRIVATE_KEY` in ignored configuration. Give that account a function-call key whose receiver is exactly `NEAR_TREASURY_ID`, whose nonempty method list contains only `confirm_refund`, `recover_source_transfer` and/or `recover_retained_withdrawal`, and whose bounded allowance covers 100 Tgas at the live network gas price. The key must include the selected method. Full-access keys, empty or broader method lists, wrong receivers and insufficient allowances are refused before preparing attestations. Keep this key separate from the ordinary company executor key. The reporter calls require the freshly reviewed shared contract version that accepts zero attached deposit for this role.

Append `--send` to the reviewed command to sign and broadcast. Signed transaction bytes are encrypted and journaled in the database before broadcast. Keep the original database and encryption key together. An uncertain outcome stays held: repeating the exact command checks its original transaction, and `--send` can only rebroadcast those same saved bytes. A changed proof or another recovery for the same unresolved entity cannot create a replacement signature. While any signed transaction from this reporter is unresolved, other companies and attempts cannot reuse the signer to create another transaction. Reconcile the original signature first. Never delete the journal to retry an unknown outcome.

A final transaction and a matching company-scoped recovery state are both required for confirmation. A conclusive transaction failure or a callback that returns false requires review. After fixing its cause, repeat the exact command with `--send --retry-final` to recheck the proof and create a fresh signature; this flag is refused while the original outcome is unknown. Prior signed submissions remain in the audit journal. No recovery broadcasts have been performed by local implementation checks.

## Complete financial evidence

Use a deliberately funded company and confirmed fictional payees under your own control. Before each real transfer, review the exact amount, fee ceiling, asset/network identity, receiving address, backup consent and signer. Preserve final receipts with the company accounting export.

Record a source deposit, canonical NEAR USDC credit, primary payout and reconciled balance. Exercise permitted backup, a delayed or unknown outcome, source refund and terminal partial delivery. An unknown original transfer must remain held instead of creating another payout. Never intentionally send a duplicate payment to demonstrate recovery.

For worker evidence, prepare and approve an exact route near its execution window. A recurring calendar template creates drafts; it does not grant authority to approve a new route or changed amount/destination. Demonstrate interruption recovery with the same signed transaction and enforce pause, expiry and budget limits.

Update the [build checklist](build-checklist.md) only with the behavior actually observed. Keep local fixtures, testnet results, read-only deployment checks and real mainnet settlements distinct.
