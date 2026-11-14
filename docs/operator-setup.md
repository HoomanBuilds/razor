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

Review the output, fund your operator accounts for code/storage and gas, and run the exact atomic deployment and initialization transactions through your NEAR operator tooling. Never leave an uninitialized contract available for someone else to claim. This release uses fresh money-handling contracts with `--upgrade-policy owner_controlled`. Keep the approved deployment keys in the secure operator keychain, pin their exact public keys in `NEAR_CONTRACT_UPGRADE_KEYS`, and verify both code and key policy at a single finalized block. Do not expose upgrade keys to ordinary application workers or company signers. The operator can replace code and affect all funds; disclose that authority before activation and funding.

The separate stateless evidence account is the only immutable exception. After verifying its exact code/initialization and returning spare native funds while reserving required storage and retirement gas, remove all evidence access keys and confirm an empty final key list. Do not remove keys from the four money-handling contracts or the separate owner wallet. Evidence needs no later operating topups. Its optional timing-proof verifier still requires historical keyless code and never treats a mutable account as immutable.

The current manifest requires `treasuryStateVersion: 4`. Native operating-reserve recovery protects prepaid company storage and cannot read populated earlier state as an upgrade. The planner rejects stale manifests and produces fresh-account plans only; it does not inspect targets or implement a funded-state migration. Follow [native standing authority](specs/native-standing-authority.md) before enabling that optional worker.

The current clearing manifest also requires `clearingStateVersion: 3` and a fresh empty clearing account. Optional cash-backed mode is disabled by deployment. Follow `optionalCashClearingSetup` in the unsigned plan: inspect native USDC `storage_balance_of` for the clearing contract, obtain the live `storage_balance_bounds.min` if registration is needed, and explicitly authorize token storage. The separate owner then calls `enable_cash` once with the network and null test token on mainnet, or the explicit configured test token on testnet. Existing debt-discharge clearing needs no cash-mode enablement. Company deposits, round storage, recipient storage and withdrawals remain separate authorized operations. See [cash-backed clearing](specs/funded-business-clearing.md).

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

## Connect QuickBooks Online or Xero

Accounting is optional and records bookkeeping entries. It does not move bank or crypto funds. Missing operator credentials leave the provider pending setup. Configure a confidential web OAuth application with the provider and keep these settings in ignored operator configuration:

| Setting | Purpose |
| --- | --- |
| `APP_URL` | Exact public HTTPS origin for the hosted application and callbacks; HTTP is for local development |
| `QUICKBOOKS_CLIENT_ID`, `QUICKBOOKS_CLIENT_SECRET` | Matching Intuit application credentials |
| `QUICKBOOKS_ENVIRONMENT` | `sandbox` by default; explicitly use `production` with the corresponding credentials |
| `XERO_CLIENT_ID`, `XERO_CLIENT_SECRET` | Matching Xero confidential web application credentials |
| `DATA_ENCRYPTION_KEY` | Existing persistent encryption key for saved grants and accounting records; preserve it with the database |

Register these exact redirect URLs, replacing the origin with `APP_URL`:

```text
https://YOUR_HOST/api/accounting-oauth/quickbooks/callback
https://YOUR_HOST/api/accounting-oauth/xero/callback
```

QuickBooks requests `com.intuit.quickbooks.accounting`. Xero requests `offline_access accounting.invoices accounting.payments accounting.contacts.read accounting.settings.read`. These are accounting APIs; they do not enable a bank payment service. Provider setup follows the [Intuit OAuth guide](https://developer.intuit.com/app/developer/qbo/docs/develop/authentication-and-authorization/oauth-2.0) and [Xero web authorization flow](https://developer.xero.com/documentation/guides/oauth2/auth-flow/).

Start consent from the company's Accounting panel while signed in with current `company:read`, `company:manage`, `payments:read` and `reports:read` permissions. Finish in the same browser within ten minutes. The server binds one-use state to the initiating user, company, exact live Razor session and a separate random browser nonce. The nonce uses an HttpOnly `SameSite=Lax` cookie so a top-level provider return can work without the application's `SameSite=Strict` session cookie. HTTPS uses `__Host-razor_accounting_oauth_PROVIDER` with `Secure`, `Path=/` and no `Domain`; local HTTP uses the unprefixed name. Preserve the public HTTPS origin and `Set-Cookie` headers through the proxy. Do not relax the ordinary session cookie or require it on the callback. Copied consent links, missing or mismatched browser cookies, expired state and a revoked initiating session cannot authorize a code exchange. Current session and company access are checked again before saving a grant.

Successful consent leaves the connection awaiting explicit legal-entity selection. Choose the company verified by that provider grant, then check its actual name and functional currency. No first Xero tenant is selected implicitly. Load the provider's current accounts, contacts and tax codes, paging if needed. An approver with `payments:approve` must map company payees to actual provider contacts, an expense account, a functional-currency bookkeeping clearing bank account and a verified zero-tax code. Tax calculations are unsupported. Catalog selections must be fresh; preflight revalidates their identities and active status.

Supported functional currencies are USD, EUR, GBP, CAD, AUD, NZD, INR and SGD. Approve an explicit positive integer numerator/denominator for functional-currency units per USDC, with its source and date. USD is not automatically treated as equivalent to USDC. Amounts use exact integer arithmetic and must fit two decimal places within the supported bound; fractional cents are held instead of rounded. Mapping changes require fresh posting review. Record any closed-through date before preparing plans.

The supported writes are accepted company bills and verified full-principal installment settlements against their reconciled original bills. QuickBooks receives a Bill or BillPayment; Xero receives an ACCPAY draft invoice or accounting Payment, with its invoice authorized in Xero before payment recording. The bill's original due instant is converted to a provider calendar date using the company timezone and kept separate from the posting date. An unscheduled bill requires an explicitly reviewed provider due date. The connector never invents today's maturity or silently changes the source bill. Amounts, payees, account/tax mappings, dates and provider matches remain bound to the saved review.

Preparing a plan sends no financial write. Inspect its exact disclosure, source and FX terms, then approve that exact plan. The Accounting panel can process one approved request. The ordinary worker also dispatches one accounting request per tick and supports company scoping:

```sh
npm run worker -- --once --organization=COMPANY_ID
```

This worker also runs the other configured operations and can execute already authorized financial work; it is not an accounting-only dry run. Durable leases serialize requests per connection. Stable request IDs and a saved write fence prevent blind resubmission after a lost response. Failed read-only preflight can be retried after review. After any uncertain write, use **Read provider record** to reconcile the existing marker; a missing result does not prove no write occurred and never permits an automatic second POST. External financial changes or revisions enter held/conflict review instead of overwriting Razor's ledger. A matching revision can be acknowledged explicitly. Provider status never credits company cash or proves token delivery.

Disconnect stops local future access, removes saved tokens and attempts provider revocation. An already sent request can still complete. If revocation is unconfirmed, revoke the app in the provider account. Keep unknown requests and their original journals for reconciliation. Automatic bank matching, payroll-row exports, fee/FX journals, credit-note posting, noncash-setoff exports and NetSuite synchronization remain unsupported. Before claiming live support, separately demonstrate actual consent, entity/catalog selection, exact reviewed posting, refresh/revocation and unknown/conflict recovery against the configured provider. Local injected-transport checks establish none of those provider-live outcomes.

## Run company-operated private invoice processing

Companies may run the private invoice tool on their own computer using the reviewed source and its installed dependencies. Use Node.js 24.22.1 or later with the 512 MB heap cap. Configure the company's own `NEAR_AI_API_KEY`, `NEAR_AI_MODEL`, approved `NEAR_AI_MODEL_COMPOSE_SHA256` and `NEAR_AI_GATEWAY_COMPOSE_SHA256` in a restricted local environment file outside git. Comma-separated measurement allowlists must come from independent review of the intended deployment. Optional `NEAR_AI_MAX_ATTESTATION_AGE_MS` retains the same bounded freshness policy as hosted inference. PDF processing additionally requires Linux and local `prlimit`, `pdfinfo`, `pdftotext` and `pdftoppm` tools.

Run from the checkout, replacing paths with distinct absolute local paths and choosing new output filenames:

```sh
node --max-old-space-size=512 --env-file=/absolute/company-private.env --import tsx scripts/process-invoice-private.ts --input /absolute/invoice.pdf --output /absolute/review.json --packet /absolute/evidence.json
```

The CLI accepts regular UTF-8 TXT, PDF, PNG and JPEG files up to 3 MB. Input leaves cannot be symbolic or hard links. Text is limited to 20,000 characters, PDFs to eight pages, and images to 4,000 pixels per side and 12 megapixels. Processing and output sizes are bounded. New output files are written atomically with mode `0600` and never overwrite an existing file. Parent-directory access and local machine security remain the company's responsibility.

The command uses required gateway/model verification, encryption and signed-response checks through the existing NEAR AI client. Missing settings or failed verification stop processing without a Razor-hosted fallback. The company's NEAR AI account pays for inference. The command sends no source, key, extraction or evidence packet to a Razor endpoint and creates no hosted AI draft. CLI retention is forced to zero for hosted-retention configuration; this does not delete local files or revoke the provider key.

`review.json` contains plaintext extracted fields and is sensitive. The optional evidence packet contains encrypted wire bytes and public attestation data by default. Use `--packet-mode metadata` to redact wire bytes or omit `--packet` to save no evidence file. Neither packet mode exports decryption keys or authenticates separately supplied plaintext invoice fields. The local `/verify` page reports each claim's limits; exporter metadata and fixture signatures do not establish real hardware attestation.

Open the review JSON in the company's private-processing panel and compare it with the original document. Reading the local file uploads nothing through the reviewed client, but its full plaintext becomes accessible to the website code in that browser. Use the company CLI without opening its output in the website if all plaintext must remain outside hosted browser code. A finance preparer with document access may explicitly import only the reviewed source hash/type, confirmed payee, reference, description, agreed USDC amount, cost ceiling and optional due date into an ordinary bill draft. The raw document, complete extraction, payment instructions, credentials and evidence packet are excluded. Foreign-currency amounts require a separately agreed USDC obligation; import does not convert them or approve payment. These selected fields are human assertions. Exact retries return the existing bill; conflicting terms or reuse of the source under another reference are rejected.

Original documents, environment files and exported artifacts remain until the company removes them. Razor deletion or expiry cannot revoke downloaded copies; revoke the API key in the company's NEAR AI account when appropriate. The local SDK-fixture checks are not evidence of successful live private inference, real hardware verification or real payment settlement.

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

## Operate private support intake

The public `/help` page has searchable product guides. Signed-in users record and manage their own private cases there or in the company Help & support section. Company association never shares a case with coworkers. The service verifies optional references at submission and hides their context after access is revoked. Support messages are plain text with no attachments, payment authority or outbound notifications. Recording a case does not promise staffing, priority service or a response time.

Explicitly allowlist actual existing operator user IDs in the server-only `RAZOR_SUPPORT_OPERATOR_USER_IDS` environment setting. The local operator CLI uses OS/database access; no remote operator route is exposed. Keep access to the database and `DATA_ENCRYPTION_KEY` restricted. Start with:

```sh
node --max-old-space-size=512 --env-file-if-exists=.env.local --import tsx scripts/support-admin.ts --help
```

Commands are `list`, `inspect`, `reply` and `status`, with an exact `--operator-user`. Inspect prints private case text to that terminal. Replies use a regular bounded UTF-8 `--message-file`; never put credentials or raw customer documents into it. Replies and status changes require a stable `--key` UUID, and status changes require the current `--version`. Removing an operator from the allowlist immediately blocks future operations. These controls cannot send a payment, refund, email or Slack message.

`RAZOR_SUPPORT_RETENTION_DAYS` defaults to 90 and permits 7 through 365. Each case keeps its original expiry even if policy later changes. The ordinary unscoped worker expires at most 1000 cases per tick; company-scoped ticks skip this global housekeeping task. Reads also hide expired text/context immediately. Sender deletion removes active conversation/context and retains minimal idempotency/audit metadata. Apply the same retention policy to operator exports and backups.

## Recover unused native operating funds

Use the final reviewed contract's `get_native_reserve` view before a withdrawal. The `withdrawable` field is an integer yoctoNEAR amount after code/state backing and prepaid customer storage protection. It is not the contract's USDC balance. For the treasury:

```sh
near contract call-function as-read-only YOUR_TREASURY.near get_native_reserve json-args '{}' network-config mainnet now
```

After reviewing the quoted capacity, the actual stored platform owner can sign a positive amount with one yoctoNEAR attached. Replace the example amount and both account names before signing:

```sh
near contract call-function as-transaction YOUR_TREASURY.near withdraw_native_reserve json-args '{"amount":"100000000000000000000000"}' prepaid-gas '30 Tgas' attached-deposit '1 yoctoNEAR' sign-as YOUR_OWNER.near network-config mainnet sign-with-keychain send
```

The example withdraws 0.1 NEAR only to the owner stored in the contract. Clearing, credit and billing offer the same methods and owner-bound destination. A new quote is required after other transactions change state or balances. Never withdraw operating funds from customer company/token balances or spend prepaid storage on the platform. Keep desired future state-growth reserve in the contract deliberately, and retain the remainder in the separate owner wallet. Evidence needs no operating topups and has no corresponding withdrawal method. See [native reserve boundaries](../contracts/README.md#native-near-operating-reserves).

## Mutable commercial and financial settings

Subscription prices, feature access, finance-seat limits, private-AI allowances and optional creation policies are versioned application records. An authorized operator publishes a new catalog version through `billing:admin publish-plan`; changing a new offer needs no contract redeployment. Existing accepted invoices and prepaid periods retain their frozen terms. The billing contract checks each signed offer's exact amount, payer, expiry and terms hash, rather than hardcoding the 29/99 USDC pilot prices. Its owner can rotate the public issuer key and pause new collection while refunds remain available.

Razor currently takes zero percentage markup on payment principal and clearing requires zero platform fee. A payment's maximum fee is a company-approved execution-cost ceiling, not a Razor commission. Lending interest and fees belong to each explicitly accepted lender agreement and cannot be repriced retroactively.

Company owners can update spend limits, approval tiers, roles, recipient destinations, backup settings, settlement reporter, standing-mandate status and company ownership through their existing contract methods. Platform owners retain the supported pause and refund-reporter controls. Token identities, state layouts, financial validation rules and arbitrary new functionality are code, rather than editable fee settings. Replacing code is separate from changing configuration and must preserve existing state and liabilities. Deployment-key retirement permanently disables replacement and account deletion. The selected policy keeps the four money-handling contracts upgradable, with exact public-key pins and explicit disclosure. Only the separate stateless evidence account retires its keys. Do not represent an operator-upgradable deployment as immutable.

### Configure reviewed upgrade authority

Add `--upgrade-policy owner_controlled` to the unsigned planner command. After creating the fresh contract accounts, inspect their public full-access keys and record an explicit account-to-public-key JSON object in the ignored local setting `NEAR_CONTRACT_UPGRADE_KEYS`. Keep `NEAR_CONTRACT_UPGRADE_POLICY=owner_controlled`. Public-key pins are review decisions, not an automatically adopted RPC response. Check each key against the operator's secure keychain before recording it. Normal worker keys remain separate and narrowly scoped. No private deployment key belongs in `.env.local`.

New subscription prices and access limits still use versioned application billing offers. Owner-controlled code replacement is only needed for actual implementation changes. Future replacements require compatible storage or a specifically reviewed migration and updated code pins. No generic populated-state migration is currently provided.
