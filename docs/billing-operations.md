# Subscription billing operations

Razor earns optional company software subscriptions with zero percentage markup on payment principal. The database stores immutable plan versions; the operator CLI is their administration workflow. Free, Pro and Business bootstrap offers are pilot policy, not a market pricing feed. Customer purchases freeze a version and its terms.

## Modes and collection

`RAZOR_BILLING_MODE=pilot` is the default. It grants bounded complimentary Pro capabilities and displays that state. `enforced` uses a confirmed paid period or Free. Neither mode debits a wallet automatically. Recipient access, manual obligations, ownership/security controls, existing approvals, reconciliation, exports and fund recovery remain available. New batch payroll, recurring work, private AI and clearing proposals require their commercial capability. Existing recurring rules wait for renewal without losing their cycle.

The initial offers are 29 USDC/month with 10 finance seats and 50 shared private-AI attempts, or 99 USDC/month with 50 seats and 500 attempts. Pending valid finance invitations count toward seats. Existing members retain access after a downgrade. AI dispatch failures count as attempts; invalid input and missing provider configuration do not. Invoice analysis and finance planning share one atomic allowance. Upgrading preserves that usage window.

## Dedicated NEAR deployment

The billing owner is a merchant operator wallet. It is separate from the shared company treasury, the clearing account and the server's offer-signing key. Generate a dedicated issuer secret into a new ignored private file:

```sh
npm run billing:admin -- issuer-key --output .data/billing-issuer.env
```

This prints only the public key and secret file path. It writes a new file with `0600` permissions and refuses to overwrite it. Back it up securely and load its environment variable into the application server. Do not put the secret into a deployment argument, public client setting or git. Keep the existing data encryption key unchanged.

Build contracts serially with `bash contracts/build.sh`, then prepare an unsigned atomic deployment using valid accounts you control:

```sh
npm run prepare:deployment -- --network mainnet --treasury YOUR_TREASURY.near --clearing YOUR_CLEARING.near --owner YOUR_OPERATOR.near --billing YOUR_BILLING.near --issuer-public-key YOUR_ED25519_PUBLIC_KEY
```

The public issuer uses the `ed25519:` prefix. Replace placeholders before using the command. The planner verifies all artifacts and never signs or sends. Fund deployment/storage and gas through your operator tooling. Register the billing contract's token storage on canonical native NEAR USDC, and register the operator and any payer that needs token storage before their transfer. The contract owner cannot be the billing contract itself. Configure:

- `NEAR_NETWORK` and its matching `NEAR_RPC_URL`.
- `RAZOR_BILLING_CONTRACT_ID` and the reviewed `RAZOR_BILLING_CODE_HASH`.
- `RAZOR_BILLING_ISSUER_PRIVATE_KEY`, matching the initialized public issuer.
- For testnet only, `RAZOR_BILLING_TESTNET_TOKEN_CONTRACT`, using a token with six decimals. Test tokens do not establish live USDC revenue or Intents support.

Run `npm run check:setup -- --remote`. Collection requires matching final code/configuration, network, issuer, six-decimal token metadata and token storage. Existing-invoice recovery uses the invoice's frozen deployment and works after collection pause or issuer rotation without the old server secret. Keep deployed artifacts and the persistent database backed up.

## Customer checkout and renewal

Only the actual company owner sees subscription invoices, chooses a plan, cancels or requests a refund. Other company users see their capabilities and usage without private billing details. The owner links a verified NEAR payer, prepares an invoice, reviews the exact USDC amount, dates, network, token, receiver and signer, then explicitly signs its token transfer.

Quotes are short lived and bind the invoice, company, plan version, payer, contract, token, amount and terms hash. Refresh keeps the same invoice and all signed offer hashes. The contract accepts that invoice once and returns invalid, duplicate and excess transfers. Gas still applies to a rejected or duplicate call. The app claims the invoice before opening the wallet. A hash alone never activates a plan; final reviewed-contract invoice state does. A lost callback is recoverable without a hash.

Calendar-month periods retain their original anchor day. Early renewal prepays a next period without resetting current usage. Upgrades charge the disclosed prorated increment and preserve usage. A saved next-plan preference is not a payment or future entitlement. Cancellation preserves all prepaid access. Renewal always requires another explicit payment. Concurrent stale paid checkouts enter refund review instead of granting conflicting periods. An unused offer closes only after the final chain has passed every saved offer's expiry.

## Catalog and private operator controls

```sh
npm run billing:admin -- catalog
npm run billing:admin -- publish-plan --input /path/to/reviewed-plan.json
npm run billing:admin -- publish-plan --input /path/to/reviewed-plan.json --apply
npm run billing:admin -- retire-plan --id PLAN_VERSION --apply
npm run billing:admin -- status --company COMPANY_ID
npm run billing:admin -- invoices --company COMPANY_ID --page 1 --page-size 25
```

A publication JSON contains `code` (`free`, `pro` or `business`), `name`, `monthlyAmount` in integer microUSDC, all four boolean `features` (`batch_payroll`, `recurring`, `private_ai`, `clearing`), and `limits` (`financeSeats`, `aiAttempts`). Free must cost zero; paid plans must be positive. Private AI requires a positive bounded allowance. Publishing creates a new immutable version. Retiring requires another available version of that code. New quotes use the latest published offer; existing frozen terms remain recoverable. Preview before applying a change.

```sh
npm run billing:admin -- reconcile-invoice --company COMPANY_ID --id INVOICE_ID --apply
npm run billing:admin -- prepare-refund --id REFUND_REQUEST_ID --apply
npm run billing:admin -- reconcile-refund --id REFUND_REQUEST_ID --apply
npm run billing:admin -- prepare-withdrawal --amount 100
```

Reconciliation records observed final chain state. Refund preparation produces unsigned actions for the verified merchant owner and original payer. It never broadcasts, holds an owner key or redirects a refund. Sign the reviewed action with the operator wallet, then reconcile. Pending refunds cannot be signed again. Refund a dependent incremental upgrade before its base purchase. Full final refunds revoke the associated access; a requested or pending refund does not. Existing financial recovery remains accessible.

Withdrawals are unsigned owner-bound actions, with one yoctoNEAR and their exact amount. Retain enough merchant reserve for expected refunds. An operator can replenish USDC through `ft_transfer_call` to the billing contract with message `razor-billing-reserve`. Withdrawal and refund failures restore available funds only through their matching callback. A pending callback never unlocks a second transfer on a timer.

## Worker and evidence

`npm run worker` also observes claimed/submitted billing invoices, active paid receipts and prepared/pending refunds. Its separate private queue persists leases and retries. It does not sign renewals or refunds. Billing details are absent from finance users' ordinary operations queues and notifications. `npm run worker -- --once` can also execute already authorized company payout work, so use it with the same care as the existing executor.

Owners can download exact subscription JSON receipts and CSV history in Plans & billing. Subscription cash is merchant revenue, separate from company available/reserved funds, salary entitlements and cleared invoice value. Source transaction hashes are labelled submitted until independently verified. A contract invoice without its transaction hash remains usable final proof.

Local unit/VM checks establish source behavior. Before collecting real subscriptions, deploy the reviewed contract and demonstrate a final checkout, duplicate return, early renewal, cancellation, quota exhaustion, original-payer refund and unchanged financial recovery. Record that evidence in the build checklist. Configuration and testnet payments do not establish mainnet revenue.
