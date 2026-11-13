# Shared company treasury

Razor deploys treasury code once on NEAR. Companies activate separate ledgers in that contract rather than creating accounts and deploying another copy of the code. Clearing and subscription collection remain separate contracts.

## Company authority and accounting

Each registration binds an application organization to an initial NEAR owner. Its onchain ID combines the organization UUID with the first 16 hexadecimal characters of the initial owner's SHA-256 hash. Registration checks that suffix against the transaction caller, preventing someone else from occupying the intended owner's registration. The ID stays unchanged after an authorized ownership transfer.

Recipients, payment IDs, approvals, limits, roles, policy versions, retained assets, reservations, in-flight transfers and recovery state belong to that company ID. The shared wallet's aggregate token balance is not a company's available balance. Refresh reads the company ledger and never assigns pooled funds to a caller.

Pending outgoing transfers remain part of aggregate liabilities until their outcomes resolve. Available-funds withdrawals use unique callback IDs. Repeated or mismatched callbacks cannot restore credit twice.

## Funding and receipts

Funding quotes deliver native NEAR USDC through NEAR Intents. Their signed `customRecipientMsg` contains:

```json
{"company_id":"<registered-company-id>","deposit_id":"<funding-leg-id>","kind":"funding"}
```

The authenticated NEP-141 callback credits the exact transferred units to the named company. Retained-token deposits use `kind: "retained"` and an owner-approved NEAR token contract; they do not create USDC payment cash.

Every actual accepted transfer has an immutable credit record. Reusing a public deposit tag for another real transfer does not occupy or overwrite the intended transfer's credit. Application verification binds the final canonical-token transfer, its descendant company-credit event and the exact immutable onchain credit record. A provider success report alone cannot allocate funds.

Plain transfers to the shared account do not identify a company. They remain unallocated. Funding screens therefore direct users through the quoted route and exact deposit message. Intents documents withdraw-to-contract messages as experimental; live quotes, token storage and final receipt behavior must be demonstrated before claiming live support.

## Refunds and manual recovery

Ordinary successful callbacks resolve automatically. A failed source or retained-token callback can require manual recovery from the exact final token-transfer receipt. Restoring a shared-wallet balance through manual attestation requires the configured platform recovery reporter. Company owners cannot claim an unidentified pooled refund or recreate spent credit by reporting failure.

Positive Intents refund allocation additionally requires the route's completed refund report, a bound final NEAR transaction, the exact returned amount and globally unique token-receipt attribution. Aggregate-liability and pool-epoch checks reject stale or concurrent observations. Delivery or uncertain outcomes never authorize a replacement payment.

The recovery reporter is a narrow attribution trust boundary. Its restricted signing key must target only the reviewed shared treasury's recovery methods. Platform operators act under their own recorded identities; they do not need membership in the customer's private workspace. See [operator setup](../operator-setup.md).

## Storage and deployment costs

Initial registration prepays 8,192 bytes of company state. The contract measures actual state growth against that company's storage allowance and retains a callback reserve. Owners can add storage through Treasury without deploying more code or affecting USDC balances. Storage funding and wallet gas are explicit network costs, separate from Razor subscriptions.

At mainnet block 224391286 on 13 November 2026, the queried storage price was `10^19` yoctoNEAR per byte. The initial allowance is therefore **0.08192 NEAR**, excluding execution gas. The preceding isolated factory required **4.01036 NEAR** for a company creation deposit, largely because it copied the entire treasury WASM. These amounts are storage capital and allowances, not equivalent burned transaction fees.

Build and deploy the shared treasury, clearing and optional billing contracts using the current manifest and deployment planner. The old factory is excluded from the supported deployment path. Complete token registration, role configuration and deployment-key retirement as described in [contract deployment](../../contracts/README.md). An account retaining a deployment key can still have its code replaced.

Existing isolated configurations remain explicitly marked `isolated_v1`. This change does not migrate their assets, retag their balances or change immutable deployed contracts. A fresh shared deployment and deliberate migration are required.

## Evidence boundary

Local application, native contract and compiled-WASM checks establish the behavior recorded in the [build checklist](../build-checklist.md). They do not establish a mainnet deployment, successful cross-chain settlement, live subscription collection or configured provider access. No funds were moved to implement this change.
