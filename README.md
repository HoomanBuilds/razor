# FLOAT

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

SQLite migrations run automatically into `.data/float.sqlite`. Use persistent local storage for the application server. Configure a 32-byte `DATA_ENCRYPTION_KEY` as hex or base64 for production private records. Back up the database and that key together. Development generates a private local key if none is configured.

## NEAR setup

Company treasury ownership is separate from application login. Link the NEAR owner wallet, create or connect a FLOAT treasury, register its native USDC token storage and refresh the confirmed balance. NEAR Intents uses mainnet; a testnet treasury cannot execute cross-chain settlement. The live asset catalog and signed route quotes are fetched from NEAR Intents rather than a fixed asset snapshot.

See the [treasury interface](contracts/float-treasury/README.md) for contract setup and trust boundaries. The owner or appointed reporter attests external destination settlement. FLOAT does not claim a cryptographic external-chain proof from a provider status response.

Private inference requires configured NEAR AI Cloud credentials, approved deployment measurements and successful verification. Missing credentials never switch invoice contents to another provider. Manual invoice preparation remains available.

## Build and review

```sh
npm run typecheck
npm test
npm run build
```

Builds use a capped Node heap and one Next.js worker. A shared worktree lock prevents concurrent FLOAT development servers and production builds. Compilation requires 4 GB of available memory to start and stops if available memory stays below 3 GB. Run Rust builds with one job and serialize them with application builds. Stop the development server before a production build.

The [product specifications](docs/README.md), [build checklist](docs/build-checklist.md) and [source notices](THIRD_PARTY_NOTICES.md) describe intended behavior, verified progress and reused source. An implemented screen is not evidence of a live payment. Public deployment, provider credentials, onchain setup and real settlement verification must be completed before advertising those integrations as live.
