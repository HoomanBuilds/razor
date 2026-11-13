# Razor

Company payments and payroll using NEAR treasury contracts and NEAR Intents. Companies prepare obligations in USDC, fund through supported source assets, and pay confirmed recipients on their preferred supported network. Recipient-consented native USDC backup routes remain blocked while an earlier transfer could still deliver.

## Run locally

Use Node 24.22.1 or later. The pinned version is in `.nvmrc`.

```sh
nvm install
nvm use
npm ci
cp .env.example .env.local
npm run dev
```

Open `http://localhost:3000`. The application starts with sign-in and company creation. There is no seeded administrator or fake funding balance. Wallet login works without Privy credentials. Google and email require the Privy application ID and verification configuration. `APP_URL` must exactly match the browser origin.

SQLite migrations run automatically into `.data/razor.sqlite`. Use persistent local storage for the application server. Configure a 32-byte `DATA_ENCRYPTION_KEY` as hex or base64 for production private records. Back up the database and that key together. Development generates a private local key if none is configured.

## NEAR setup

Company treasury ownership is separate from application login. Link the NEAR owner wallet, create or connect a Razor treasury, register its native USDC token storage and refresh the confirmed balance. NEAR Intents uses mainnet; a testnet treasury cannot execute cross-chain settlement. The live asset catalog and signed route quotes are fetched from NEAR Intents rather than a fixed asset snapshot.

Build the NEAR contracts with `bash contracts/build.sh`, using Binaryen `wasm-opt` version 130 alongside Rust. The guarded, serialized build optimizes treasury, factory, clearing and billing WASMs under `.tools/wasm/`, generates a build manifest and prints four public code-hash pins for the corresponding `.env.example` fields. The factory embeds the exact optimized treasury WASM. Use those published artifacts and hashes rather than raw Cargo output. These artifacts use the current storage layout and require fresh deployments; no legacy treasury migration is provided. Compiling artifacts does not deploy contracts or move funds.

Prepare an unsigned deployment plan with the account names you intend to create and fund:

```sh
npm run prepare:deployment -- --network mainnet --factory YOUR_FACTORY.near --clearing YOUR_CLEARING.near --owner YOUR_OWNER.near
```

Replace the uppercase placeholders with valid lowercase account names. The planner validates the local WASM manifest and embedded treasury, then prints exact NEAR CLI deployment commands with initialization in the same transaction. It does not create accounts, sign, send or overwrite configuration. Its output includes the code pins to configure after successful deployment. Testnet requires an explicit `--testnet-token` and cannot establish Intents settlement.

See the [treasury interface](contracts/razor-treasury/README.md) for contract setup and trust boundaries. The owner or appointed reporter attests external destination settlement. Razor does not claim a cryptographic external-chain proof from a provider status response.

Private inference requires configured NEAR AI Cloud credentials, approved deployment measurements and successful verification. Missing credentials never switch invoice contents to another provider. Manual invoice preparation remains available.

## Operator setup checks

```sh
npm run check:setup
npm run check:setup -- --remote
```

The first command checks local configuration. The second also reads deployed NEAR code and authority. Neither sends payments, emails or private inference requests. Missing or invalid setup remains blocked; a successful configuration check does not establish a live payment or provider recovery. Use the [operator runbook](docs/operator-setup.md) for setup and live evidence requirements.

## Company subscriptions

Razor adds zero percentage markup to payment principal. Optional company plans fund the software. The versioned pilot offers are Free, Pro at 29 USDC/month and Business at 99 USDC/month. Default pilot mode grants bounded complimentary Pro access; enforced mode uses confirmed paid periods. Existing payments, financial records, ownership controls and recovery remain accessible. Subscription payments use a dedicated NEAR contract, require explicit wallet consent and never deduct from payroll. Renewals are manual.

The [billing operator guide](docs/billing-operations.md) covers deployment, private issuer setup, versioned catalog administration, refunds and the reconciliation worker. Paid collection stays unavailable until its deployment, issuer and token configuration pass verification. Local checks are not paid revenue.

## Build and review

```sh
npm run typecheck
npm test
npm run build
```

Application builds and type checks use a 1.5 GB Node heap cap, and Next.js uses one worker. A shared worktree lock serializes application and contract builds and prevents compilation alongside a Razor development server. Compilation requires 4 GB of available memory to start and stops if available memory stays below 3 GB. The contract script uses one Cargo job and one Binaryen thread. Run other Rust checks with one job and serialize them with application builds. Stop the development server before a production build.

The [product specifications](docs/README.md), [build checklist](docs/build-checklist.md) and [source notices](THIRD_PARTY_NOTICES.md) describe intended behavior, verified progress and reused source. An implemented screen is not evidence of a live payment. Public deployment, provider credentials, onchain setup and real settlement verification must be completed before advertising those integrations as live.
