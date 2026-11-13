# Consented business invoice clearing

Razor can offset accepted company-to-company USDC invoices before paying the remaining liabilities. This optional workflow works alongside ordinary payroll and company payments. Employee wages and personal contractor payments cannot enter clearing.

For example, company A owes B 100 USDC and B owes A 70 USDC. Both owners may agree to discharge 70 USDC of each invoice. A retains a 30 USDC payment draft. The invoice ledger records 140 USDC of discharged invoice face value, 30 USDC of planned transfers and zero delivered tokens until an ordinary payout settles. Canceling debt does not create treasury cash or profit.

## Company and invoice authority

- Each company explicitly opts in using its actual Razor owner. Its company registration must belong to the configured reviewed shared NEAR treasury, use the same settlement token and network, and have an unpaused policy. The exact owner-bound onchain company ID is snapshotted separately from the application company ID. The owner links and verifies the wallet that currently owns that treasury.
- A business recipient profile must be confirmed by the receiving company's registered owner. A payer cannot choose an unrelated company as the creditor of an invoice.
- Both companies accept the exact invoice terms and settlement window. Invoice details are encrypted offchain and visible only to the authorized counterparties.
- A larger cycle requires both counterparties to authorize sharing the invoice amount with every additional participant. These participants receive the amount and opaque IDs, without the private invoice reference, description or documents.

Eligible invoices must have a complete unapproved business payment draft, no funding legs, payout attempts, client cash commitment, previous approved installments or delivered funds. Required work acceptance must already be recorded. Splitting an invoice into a smaller payment draft makes it ineligible until the complete remaining liability is represented.

## Preview, agreement and settlement

The deterministic bigint calculation supports 2 to 32 obligations across 2 to 8 companies. It cancels reciprocal and longer directed cycles while preserving each company's net position. Every preview shows original value, exact per-obligation reduction, residual transfers and before/after positions. Per-company discharge is checked against the contract's u128 range.

A saved proposal freezes the exact reviewed manifest, including opaque payment IDs, accepted terms hashes, company registration versions, treasury owners, treasury policy versions, zero clearing fee and a common settlement window ending within 24 hours. The selected invoice drafts are held against approval, funding, payout, replacement and concurrent clearing. No debt has been discharged yet.

Owners register the exact manifest with the separate `razor-clearing` NEAR contract, then every participant signs its own consent. Registration verifies the company-specific configuration in the shared treasury. The manifest binds both the application company ID and its persisted onchain treasury company ID. Consent rechecks current treasury owner, token, pause state and policy version. A debtor's consent locks only its own outgoing obligations, so a public creditor cannot pre-lock another company's invoice. Per-round request IDs reject superseded asynchronous consent and finalization callbacks.

Finalization requires every distinct company consent, a live settlement window, intact obligation locks and fresh configuration checks for every treasury. Participants may revoke an unfinished round; anyone may expire it after the window. Revoked, rejected and expired rounds release their obligation locks. Finalized obligations cannot be reused.

The server reconciles a final NEAR block and verifies the pinned clearing and shared treasury code hashes. It also reads the exact finalized block, checks the recorded finalization and rechecks each company registration, owner, policy and token at that block. A stale owner, different policy, missing consent, changed invoice or unverified historical state prevents all local setoff changes.

Only then does one database transaction retire the original drafts, record each debt discharge and create any residual invoice drafts. Invoice face value stays immutable. Residual drafts preserve recipient preferences, invoice lineage, project attribution and fee limits, and use the existing approval, funding, payout and receipt workflow. A retired draft cannot be funded, paid or reissued as a replacement. An unregistered proposal can be revoked by registering its exact manifest and publishing its revocation in the same wallet transaction, preventing a saved late registration action from reviving it.

## Accounting and privacy

`bills.setoff_amount` is cumulative microUSDC debt discharge. Remaining liability is original invoice amount minus actual delivered funds minus this amount. `clearing_setoffs` preserves the round, bill, original and residual payment IDs, manifest hash and final proof block. This record never credits the treasury ledger or counts as delivered tokens, source cost or revenue.

Invoice terms, recipient history and accounting exports show discharge separately. Exported round totals distinguish discharged invoice face value, planned residual transfer volume, actual residual deliveries and indicative starting liquidity. Round totals must not be summed across participant exports. Starting liquidity is a mathematical lower bound that assumes timely reuse of incoming USDC; destination chains, timing and payout costs may require more funding.

The public NEAR manifest exposes treasury accounts, opaque obligation IDs and USDC amounts. Clearing does not provide confidential onchain amounts or hide graph relationships. Sensitive invoice descriptions, source documents and payroll remain outside that manifest.

## Deployment and integration

- Build `contracts/razor-clearing` with the existing serialized contract build script. The artifact is `razor_clearing.wasm`; compiled artifacts stay ignored.
- Deploy and initialize a separate clearing account using `new({ owner_id, treasury_id, token_contract })`. Use the reviewed shared treasury account and its native NEAR USDC token. This contract holds no USDC and transfers no payment funds.
- Configure `NEAR_CLEARING_ID`, `NEAR_CLEARING_CODE_HASH`, `NEAR_TREASURY_ID`, `NEAR_TREASURY_CODE_HASH` and `NEAR_NETWORK`. Code hashes can come from locally built reviewed artifacts where supported by the shared artifact verifier. `NEAR_RPC_URL` must serve the selected network and the historical finalized block needed for reconciliation; use an archival endpoint when old blocks are no longer available.
- Mount `clearingRoutes` under the authenticated company API at `/clearing`, and mount `BusinessClearing` in the company workspace. Map `CLEARING_LOCKED` and `CLEARED_LIABILITY` database guards to HTTP 409.
- Registration attaches a non-refundable NEAR storage budget. Consent, finalization and revocation attach one yoctoNEAR and wallet gas. Users review exact arguments and sign in the linked NEAR wallet. No server key signs owner consent.

Focused automated fixtures exercise bigint conservation, authority and privacy boundaries, draft locking, incomplete consent, stale treasury owners at finality, atomic discharge and residual accounting. Contract test source covers conservation, shared registration authority and company isolation, debtor-only locks, request replay, policy rotation, finalization and revocation. These checks do not establish a live deployment or live settlement. Live verification requires deployed reviewed contracts, company owner wallets and a funded residual payment executed through the normal workflow.
