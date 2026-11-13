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

Build the three contracts serially with `bash contracts/build.sh`. Keep the WASMs and manifest under ignored `.tools/wasm/`. Choose your own distinct NEAR factory and clearing deployment accounts and an owner account. Names in command arguments are operator choices, not published Razor deployments.

```sh
npm run prepare:deployment -- --network mainnet --factory YOUR_FACTORY.near --clearing YOUR_CLEARING.near --owner YOUR_OWNER.near
```

Replace each example account with a valid account that you control before running the planner. It prints exact deploy-plus-initialize arguments and reviewed hashes. It does not create accounts, contact an RPC, sign or submit transactions. On testnet, provide `--network testnet` and an explicit `--testnet-token` account; testnet tokens never establish mainnet USDC or Intents settlement.

Review the output, fund your operator accounts for code/storage and gas, and run the exact atomic deployment and initialization transactions through your NEAR operator tooling. Never leave an uninitialized factory or clearing deployment available for someone else to claim. Follow [NEAR's contract deployment documentation](https://docs.near.org/smart-contracts/release/deploy) and the repository's [contract setup](../contracts/README.md). These contracts require fresh deployments; no legacy treasury storage migration is provided.

Copy the resulting public account IDs and code-hash pins into the matching `.env.local` fields. Mainnet factory initialization must use the canonical native USDC token already defined by the application. Rebuild the app when changing `NEXT_PUBLIC_PRIVY_APP_ID`, because the browser bundle reads it at build time.

```sh
npm run check:setup -- --remote
```

Remote mode only reads public NEAR network, deployed factory/clearing configuration, code hashes and the configured worker's treasury/key permissions. It verifies initialized settings and the factory's embedded treasury hash. It never signs or broadcasts a transaction. A paused factory or treasury is reported as blocked. A matching public code hash establishes deployment identity, not security certification or a successful payment.

## Configure the live services

1. Configure Privy Google/email methods, allowed browser origins, matching server/browser app IDs, a valid ES256 verification key or HTTPS JWKS URL, and the app secret for verified profile/email retrieval. Create a new user, return after logout and exercise the provider's recovery flow. Linking a NEAR owner wallet remains separate from app sign-in.
2. Create a company treasury through the reviewed factory with an owner-controlled NEAR wallet. Register native USDC storage, verify ownership and refresh the confirmed balance. NEAR Intents funding and payouts require mainnet; the app must keep testnet evidence separate.
3. Give a dedicated worker account the treasury executor role and a function-call key limited to that treasury's `execute_payment` method. It must not be the owner or an approver. Set the exact account, treasury, network and private key in ignored environment configuration. Enable the bounded company mandate as its owner, then run `npm run worker -- --once` under supervision. That worker command can execute already authorized due routes; it is different from the read-only preflight.
4. Configure the NEAR AI model, API key, approved model/gateway compose hashes, retention period and attestation age. Review approved measurements before enabling inference. Send fictional documents through the actual application and retain successful required verification evidence, a rejection example and deletion/expiry results. Configuration alone cannot prove private inference.
5. For optional email, configure a verified Resend sender/domain and the transport key. A recipient must opt in with a verified email identity. Confirm actual arrival separately from provider acceptance; messages contain sign-in links without private payment details.

## Complete financial evidence

Use a deliberately funded company and confirmed fictional payees under your own control. Before each real transfer, review the exact amount, fee ceiling, asset/network identity, receiving address, backup consent and signer. Preserve final receipts with the company accounting export.

Record a source deposit, canonical NEAR USDC credit, primary payout and reconciled balance. Exercise permitted backup, a delayed or unknown outcome, source refund and terminal partial delivery. An unknown original transfer must remain held instead of creating another payout. Never intentionally send a duplicate payment to demonstrate recovery.

For worker evidence, prepare and approve an exact route near its execution window. A recurring calendar template creates drafts; it does not grant authority to approve a new route or changed amount/destination. Demonstrate interruption recovery with the same signed transaction and enforce pause, expiry and budget limits.

Update the [build checklist](build-checklist.md) only with the behavior actually observed. Keep local fixtures, testnet results, read-only deployment checks and real mainnet settlements distinct.
