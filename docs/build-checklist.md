# Razor build checklist

Use this document to compare the actual build with the intended product throughout development.

Product: a NEAR-based company payments and payroll platform with easy onboarding, connected source wallets, supported-asset funding, recipient preferences, USDC backup, private financial analysis and optional business netting.

## How to use this checklist

- A checked box means the stated behavior was verified against a recorded build, with evidence in the review log below.
- Leave partial, blocked, untested or simulated-only integration work unchecked. Unchecked means unverified, not necessarily unimplemented.
- Reference the feature or scenario IDs when recording tests, screenshots, transaction receipts, recordings or issues. One evidence record can cover several related checks.
- Clear a checkbox if a later change causes a regression; record the failure and affected build. Keep earlier review entries for context.
- Review changed areas and their relevant journeys during normal development. Perform a complete applicable review before calling the product complete.
- The [feature catalog](specs/features.md) defines behavior. Update the catalog and this checklist together when product scope changes.

Current catalog coverage: **90 feature requirements: 82 core and 8 optional**. End-to-end, recovery and track checks below are additional verification gates, not extra features to inflate that count.

The evidence review on 13 November 2026 verifies **12 of 127 checks: 11 of 82 core requirements and 1 additional scenario**. None of the 8 optional requirements is verified. This is a partial implementation review, not a completion percentage: a requirement stays unchecked when only some of its behavior has evidence. See the [implementation status and remaining verification](specs/implementation-status.md) for the implemented areas behind the unchecked boxes.

| Review field | Current value |
| --- | --- |
| Last full build review | Pending; targeted local production-build review passed on 2026-11-13 |
| Build or deployment reviewed | Local production candidate `26ced9d`; no deployed payment or private-inference evidence |
| Selected optional features | Project/cost-center reporting, retained assets and consented netting integrated. None of the optional requirements is fully verified |
| Target track evidence | Planned: Real-World Money, Autonomous Business, Privacy & Private AI; live demonstrations pending |

## 1. A new payer can arrive and start working

- [ ] `AUTH-01` A fresh user can sign up and return with Google or a simple email option without a company invitation, operator setup or pre-existing wallet.
- [x] `AUTH-02` A supported wallet-first user authenticates through a verified, fresh, domain-bound challenge; a connected address alone cannot impersonate its owner.
- [ ] `AUTH-03` A signed-in user creates a company, becomes its initial owner and reviews editable USDC and time-zone defaults without manual database setup.
- [x] `AUTH-04` A new company can add payees and prepare and preview payroll or bills before funding; execution clearly identifies missing authority or money.
- [ ] `AUTH-05` Social login and wallet linking require verified control and return the user to the same authorized workspaces without email-only account merging.
- [ ] `AUTH-06` Invitations can be accepted, expired and revoked; assigned roles are enforced beyond the interface.
- [ ] `AUTH-07` Switching between companies keeps records, drafts, approvals and payment attribution isolated to the chosen company.
- [ ] `AUTH-08` Return visits restore the correct identity and company; logout or expired sessions prevent new unauthenticated interactive actions while saved drafts remain recoverable.
- [ ] `AUTH-09` Identity and signer recovery have a demonstrated path; sensitive ownership and credential changes require appropriate fresh authentication.
- [ ] `AUTH-10` A resumable onboarding guide shows company setup, treasury authority, payees, funding and the first payment, with actionable blocked steps.

## 2. Payers can connect and use their own wallets

- [ ] `WAL-01` An existing supported NEAR wallet connects, displays its account and network and authorizes a permitted company action with appropriately limited permissions.
- [ ] `WAL-02` Supported EVM and Solana source wallets can fund through Intents; routes without a connector show correct explicit deposit instructions rather than a fake connection flow.
- [ ] `WAL-03` A payer can link and deliberately select among several wallets; external balances remain distinct from confirmed company funds.
- [ ] `WAL-04` A social-login user can establish a NEAR-capable signer and owner-controlled treasury without manually importing a seed phrase; ownership, recovery and any sponsored setup actually work.
- [ ] `WAL-05` Every wallet action previews purpose, source, token, amount, network, destination and costs before requesting the necessary signature or approval; Razor never requests a private key or seed phrase.
- [ ] `WAL-06` Unsupported wallets, rejected signatures, wrong networks, insufficient native gas and connection interruption produce actionable errors without losing the draft or claiming payment success.
- [ ] `WAL-07` Account or network changes revalidate stale previews and selections; disconnecting preserves the company and monitoring of already submitted transfers.
- [ ] `WAL-08` App identity, funding wallets, company treasury authority, agent mandates and recipient addresses remain separate; connecting one wallet does not grant every financial role.

## 3. Company workspace and permissions

- [ ] `ORG-01` Company details, NEAR treasury ownership, settlement asset and financial policies are visible and correctly associated.
- [ ] `ORG-02` Preparer, approver and accountant permissions restrict records and actions; unrelated staff cannot inspect salaries or private documents.
- [ ] `ORG-03` Approval thresholds, approver requirements, recurring mandates and fee ceilings are enforced on the actual financial action.
- [ ] `ORG-04` Emergency pause prevents new authorizations and agent execution while existing transfers continue to be reconciled.
- [ ] `ORG-05` Each approval retains the exact policy and recipient versions; changed unexecuted terms trigger appropriate revalidation or reapproval.

## 4. Treasury, multiple assets and payment funding

- [ ] `TRE-01` Funding choices reflect validated supported assets and networks, with an executable quote for the chosen amount and route.
- [ ] `TRE-02` Several supported assets can fund one company through independently tracked deposits, quotes, amounts, statuses and receipts.
- [ ] `TRE-03` Default approved top-ups settle into USDC; only confirmed net destination credits increase the funded balance.
- [ ] `TRE-04` Confirmed holdings, client reserves, commitments, payment reservations, reserved fees and available operating cash reconcile without double counting.
- [ ] `TRE-05` A client or internal funding request contains its amount, purpose and expiry and tracks the resulting settlement.
- [ ] `TRE-06` Failed or refunded funding is recorded and reconciled to the company's confirmed recovery destination.
- [ ] `TRE-07` Upcoming obligations and permitted costs are compared with actual spendable money; shortfalls appear before execution.
- [ ] `TRE-08` **Optional:** retained original assets show quantities and indicative values separately from confirmed USDC payment reserves.
- [ ] `TRE-09` A payer can fund a specific approved obligation from a connected wallet and complete its NEAR-authorized payout; both legs, excess and refunds stay linked, including funding success followed by payout failure.

## 5. Employees, contractors and other payees

- [ ] `REC-01` Employee, contractor, freelancer and supplier profiles preserve their relationship and payment status.
- [x] `REC-02` Authenticated recipients can confirm their own payout details and view only their own records.
- [ ] `REC-03` Primary preferences store the exact token, network, compatible address and required supported destination metadata.
- [x] `REC-04` A distinct recipient-confirmed native USDC backup is available on an enabled curated network, with explicit fallback consent.
- [ ] `REC-05` Invalid addresses, unsupported assets and temporarily unavailable routes are distinguished from ready destinations; an EVM address does not imply a network.
- [ ] `REC-06` Destination changes are versioned and notified; affected unexecuted payments cannot silently follow changed addresses.
- [x] `REC-07` CSV import validates individual rows, invites recipients and resolves missing data before automated payout activation.

## 6. Employee payroll

- [ ] `PAY-01` Pay periods, dates and time zones work consistently and preserve each employee's entitlement for the relevant period.
- [x] `PAY-02` Manual entry and CSV import handle approved amounts, bonuses, supplied adjustments and invalid rows with references.
- [x] `PAY-03` A pay-run preview shows entitlements, primary and backup destinations, exceptions, funding needs and maximum costs before approval.
- [ ] `PAY-04` Approval binds the exact run version and reserves both obligations and permitted costs.
- [ ] `PAY-05` A durable scheduler initiates due approved payments and reports missed or blocked execution without changing their terms.
- [ ] `PAY-06` Results are reported per recipient; a partly completed run is not presented as fully paid.
- [ ] `PAY-07` Each employee's payment record shows period, entitlement, actual asset and network, delivery receipt and backup usage where applicable.
- [ ] `PAY-08` Retrying or resuming a run processes only unresolved obligations; a completed pay-period item cannot be paid twice.

## 7. Contractor, freelancer and supplier payments

- [x] `BILL-01` Invoice or structured-request intake records supplier, reference, amount, settlement unit, line items and due date.
- [ ] `BILL-02` NEAR AI Cloud produces a private draft extraction with missing or inconsistent fields flagged; human review precedes approved liability creation.
- [x] `BILL-03` Reused invoice references, document fingerprints and suspiciously similar local requests are flagged before another payment.
- [ ] `BILL-04` A milestone payout links to approved terms and acceptance evidence; missing acceptance prevents release.
- [ ] `BILL-05` Bills can be queued and approved individually or in a batch with due dates and project or cost-center references.
- [ ] `BILL-06` Recurring vendor mandates remain bounded; amount or destination changes trigger the applicable policy.
- [ ] `BILL-07` Agreed partial payments preserve the remaining liability; only satisfied amounts are closed.
- [ ] `BILL-08` Disputed requests stay held under their resolution terms; AI summaries do not unilaterally decide who receives the money.

## 8. Routing, backup and payment recovery

- [ ] `ROUTE-01` Before execution, quotes are checked for asset and network identity, supported amount, expiry, fees and expected destination receipt.
- [ ] `ROUTE-02` The agreed net recipient amount is protected within the company's total cost ceiling; fees do not silently reduce pay.
- [ ] `ROUTE-03` A valid permitted primary is preferred; expired pre-execution quotes are refreshed within the same mandate before considering backup.
- [ ] `ROUTE-04` USDC backup executes only with the confirmed profile, allowed trigger, recipient consent, company approval, available funds and permitted cost.
- [ ] `ROUTE-05` Each logical obligation has distinct execution-attempt identities, route evidence and correctly reserved funds.
- [x] `ROUTE-06` Unknown, contradictory or delayed outcomes hold the payment for reconciliation without automatically issuing another payout.
- [ ] `ROUTE-07` Recovered funds and incurred fees are confirmed before backup or reservation release; a reported refund alone is insufficient.
- [ ] `ROUTE-08` Invalid backups, insufficient funds, partial delivery and changed terms remain visible with the appropriate next action.
- [ ] `ROUTE-09` Company and recipient notices show actual delivered amount, network, receipt and reason for backup or hold without exposing unrelated private data.

### Backup and recovery scenarios

Run these against the defined [fallback rules](specs/payouts-and-fallback.md). Record scenario evidence separately from the feature implementation checks.

- [ ] `FALL-01` An unsupported primary before commitment produces exactly one authorized USDC backup payout.
- [ ] `FALL-02` A permitted valid primary is used even if backup is cheaper, unless the accepted mandate allows cost-based selection.
- [ ] `FALL-03` A pending primary, timeout or unavailable status endpoint produces no backup transfer.
- [ ] `FALL-04` A completed primary followed by a duplicate or stale failure message produces no second payout.
- [ ] `FALL-05` A refund with unreconciled funds stays in recovery; only confirmed closure, recovered availability and permitted costs enable backup.
- [ ] `FALL-06` A profile change after approval cannot silently redirect payment to a new primary or backup address.
- [ ] `FALL-07` An over-budget backup or insufficient balance holds the obligation without reducing entitlement or exceeding authorization.
- [x] `FALL-08` A primary already using USDC needs another confirmed network to establish a distinct backup.
- [ ] `FALL-09` Worker concurrency, duplicate callbacks and service restarts do not create overlapping payable attempts.
- [ ] `FALL-10` Partial delivery is reconciled before a separately authorized remainder payment; the full obligation is not resent.
- [ ] `FALL-11` An Intents outage cannot trigger an unapproved alternate-provider, direct-chain or third-destination payment.
- [ ] `FALL-12` A recurring automatic mandate requires a valid backup and consent; a manual-only recipient remains usable through explicit exception handling.

## 9. Private finance assistant and constrained agents

- [ ] `AI-01` Invoice and expense analysis uses the configured private NEAR AI Cloud path with only the required inputs.
- [ ] `AI-02` Required attestation freshness, identities and request bindings are verified and results are inspectable; fetching a report alone does not pass.
- [ ] `AI-03` The assistant prepares pay runs, explains coverage gaps and flags unusual changes without approving its own proposals.
- [ ] `AI-04` Every automated financial action identifies the agent, permitted recipients, amounts, time window, actions and maximum cost.
- [ ] `AI-05` The actual contract or verified custody boundary rejects unauthorized destinations, amounts, duplicates and paused execution even if the model requests them.
- [x] `AI-06` Private inference failure or failed required verification does not leak documents to another provider; allowed manual workflows still function.
- [ ] `AI-07` The owner can inspect, pause and revoke agent activity without losing the financial history.

## 10. Privacy, accounting and audit

- [ ] `DATA-01` Cross-company and cross-role access checks prevent another company, employee or contractor from reading unrelated private records.
- [ ] `DATA-02` Private storage encryption, minimal inference inputs, retention, deletion and exports behave as documented.
- [ ] `DATA-03` Ordinary logs, public storage and transaction arguments contain no unnecessary document plaintext, full prompts or payroll personal details.
- [ ] `DATA-04` The ledger reconciles funding, reservations, delivered principal, actual costs, recoveries and remaining liabilities.
- [ ] `DATA-05` Approval and agent history retain accepted terms, profile versions, decisions and reasons for backup usage.
- [ ] `DATA-06` An accountant-readable CSV connects periods and invoices to settlement amounts, actual payout assets, conversion terms, fees and receipts.
- [ ] `DATA-07` Unmatched credits, stale attempts, disputed receipts and requested-versus-delivered differences appear in a reconciliation queue.
- [ ] `DATA-08` **Optional:** project and cost-center views attribute income and costs without labeling refundable client reserves as earned margin.

## 11. Optional business netting

These checks apply when business netting is included in the build. Ordinary company payroll must work without it.

- [ ] `NET-01` Only explicitly accepted mutual business obligations with compatible assets, terms and settlement windows enter a round.
- [ ] `NET-02` A proposal shows original obligations, exact reductions and each company's residual position.
- [ ] `NET-03` Every required company consents to the exact round, obligation versions and fees before clearing.
- [ ] `NET-04` Accepted clearing preserves each agreed net position and prevents concurrent payment or another round from reusing the obligations.
- [ ] `NET-05` Remaining obligations use the same approved payment, receipt and reconciliation workflow.
- [ ] `NET-06` Reports distinguish discharged invoice value, residual transfer volume and starting liquidity; cancelled face value is not reported as profit.

## 12. Operational readiness

- [ ] `OPS-01` Current support and route health are checked rather than assuming a previously supported asset remains executable.
- [ ] `OPS-02` Only reviewed native USDC backup networks are enabled; disabling one blocks new use without silently migrating recipients.
- [ ] `OPS-03` Scheduling and execution recover from interruption without generating a second logical payment.
- [ ] `OPS-04` Configured notifications reach authorized audiences with enough information to resolve the event and no unrelated salary data.
- [ ] `OPS-05` Company owner access and agent credentials have demonstrated recovery, revocation and appropriate protection.

## 13. Complete user journeys

Feature checks alone do not establish that the product works as a connected workflow.

- [ ] `FLOW-01` Fresh Google or email user creates a company, drafts an obligation without funds, establishes NEAR authority, connects a funding wallet and completes the first reconciled payment.
- [ ] `FLOW-02` Existing wallet user signs in, creates or opens the correct company, funds through supported assets and pays without creating a duplicate identity or workspace.
- [ ] `FLOW-03` A company funds a pay run from two separately quoted source assets; only settled credits become spendable and all costs reconcile.
- [ ] `FLOW-04` A payroll run contains a primary success, a permitted backup success and a held recipient; statuses, notices and ledger agree, and a retry touches only the unresolved item.
- [ ] `FLOW-05` A contractor submits an invoice, private analysis is verified, finance approves it, payment completes and resubmission does not pay it again.
- [ ] `FLOW-06` A connected-wallet funding leg succeeds but payout cannot complete; reopening the task resumes recovery or authorized backup without requesting another full deposit.
- [ ] `FLOW-07` A changed recurring bill or recipient destination requires the correct reapproval, while an unchanged authorized obligation can execute on schedule.
- [ ] `FLOW-08` An injected invoice, over-budget agent action and revoked mandate fail at the actual financial authority boundary.
- [ ] `FLOW-09` A recipient sees only personal records and an accountant traces an obligation through approval, attempts, fees and final receipt or recovery.
- [ ] `FLOW-10` **Optional netting:** two-company reciprocal offsets and a three-company cycle clear only with consent; residual transfers and final net positions reconcile, while a stale plan makes no partial changes.

## 14. Product usability and integration truth

- [ ] `UX-01` Public entry, sign-in, company creation and first-payment guidance work without a pre-seeded administrator account or developer console actions.
- [ ] `UX-02` Desktop and mobile web flows expose readable forms, actionable validation, loading, empty, error and in-flight states; wallet cancellation remains recoverable.
- [ ] `UX-03` Financial amounts, token and network names, receiving addresses and maximum costs are understandable before approval, with detailed receipts available afterward.
- [ ] `UX-04` A payer can find upcoming obligations, available funds, approvals and failed or held payments without navigating technical logs.
- [ ] `INT-01` NEAR accounts and contracts materially enforce company financial authority; the application is not only a wallet connection over unrelated payment infrastructure.
- [ ] `INT-02` Advertised cross-chain funding and payout paths execute through NEAR Intents with recorded quotes and actual completion or recovery evidence.
- [ ] `INT-03` The chosen social-login provider demonstrates NEAR signing, linked external-wallet funding, return access and recovery; necessary production credentials are available before claiming public production onboarding.
- [ ] `INT-04` NEAR testnet results, dry quotes, simulations and actual mainnet settlements are labeled separately; a mocked receipt cannot pass a live settlement check.
- [ ] `INT-05` Gas sponsorship, custody and privacy claims match implemented behavior, including source-chain fees and visibility of public receiving-chain transfers.

## 15. Track evidence

These checks support claims described in [NEAR track alignment](specs/near-track-alignment.md). They do not represent organizer preapproval.

- [ ] `TRACK-RWM` Demonstrate a company obligation from funding through approval and payout, with a real receipt or explicit recovery and a reconciled accounting export.
- [ ] `TRACK-BUS` Demonstrate a bounded company agent completing a permitted financial task, plus an enforced limit and owner pause or revocation.
- [ ] `TRACK-PRV` Demonstrate private NEAR AI Cloud analysis with verified required evidence, a failed-verification path, fictional inputs and accurate data-retention behavior.
- [ ] `TRACK-SEC` **Conditional:** demonstrate reproducible recipient substitution, prompt injection, overspending or duplicate-payment attacks being rejected by the real authorization boundary.
- [ ] `TRACK-SWM` **Conditional:** demonstrate independently authorized company agents coordinating a clearing round with identifiable participants, separate mandates and financial consequences.
- [ ] `TRACK-DFI` **Conditional:** demonstrate a substantive clearing or separately developed financing protocol with verifiable financial rules; payment routing alone does not pass this planned claim.

## Later extensions

Receivable financing, fiat bank payouts, tax and statutory payroll engines, full ERP synchronization and general agent procurement are outside the current core completion count. Add approved scope and verification criteria before treating them as product requirements or advertising them as available.

## Review log and evidence

Append a row for each meaningful review. Use the same IDs as the checkboxes. Evidence should identify the actual build and reproducible result, such as an existing test command and output, recording, transaction receipt or issue. A screenshot can establish interface behavior but cannot alone establish settlement, authorization enforcement or private computation.

| Review date | Build or deployment | IDs reviewed | Result | Evidence and unresolved issues |
| --- | --- | --- | --- | --- |
| No build review recorded | - | - | Unreviewed | All checks remain unverified |
| 2026-11-12 | Earlier local development candidate; hash not recorded | `AUTH-02`, `AUTH-03` | Verified locally | Actual signed EVM challenge and company creation in `.data/workflow-check-result.json`; identity checks cover domain, expiry, replay, forged signatures, owner role and editable company defaults. This does not establish social or NEAR wallet onboarding. |
| 2026-11-12 | Source through `6f3edfa`; focused identity, import and recipient-workspace checks reported passing | `REC-02`, `REC-04`, `REC-07`, `BILL-01`, `FALL-08` | Verified local behavior | Recipient confirmation was exercised in the local API workflow. Focused checks cover recipient isolation, invitation expiry versus permanent access, exact intake terms, idempotent imports, pending confirmation and full native-USDC asset identity when rejecting a same-network backup. No backup payout was performed. |
| 2026-11-12 | Payment policy, assistant checks and treasury VM tests reported passing | `ROUTE-06`, `AI-06` | Verified local rejection paths | Unresolved attempts block backup, provider success is only reported delivery, and source-sent is not paid. Missing private-inference configuration sends no document to a provider; invalid required evidence is rejected and manual invoice intake remains usable. These checks do not establish live settlement or successful private inference. |
| 2026-11-12 | Earlier local API and browser candidate; later feature slices reviewed in source | All remaining core requirements, journeys and track gates | Partial or unverified | Recorded workflow reached invoice and payroll `approved_unfunded`, prevented an exact duplicate and returned 403 for an unrelated company. Treasury stayed zero. Browser overview and payroll rendered without console exceptions or horizontal overflow at 390 px. A live catalog returned 230 assets across 39 chains at that moment. No funds, contract deployment or private inference was executed. |
| 2026-11-12 | Integrator follow-ups after `6f3edfa` | `AUTH-04`, `DATA-03`, `TRE-05`, `PAY-03`, `PAY-04`, `BILL-05`, `UX-02` | Changes integrated; final verification pending | Payment-management routes and panel were wired; plaintext dispute text was removed from ordinary activity; resumed unsigned public funding quotes now revalidate the frozen treasury target and can disable deposits while preserving tracking. Integrator reports TypeScript checks passing. Combined HTTP, test and production-build checks for the final candidate remain pending; planner and client-reserve gates stay open. |
| 2026-11-13 | `26ced9d`, local production server with fresh signed wallet sessions | `AUTH-02`, `AUTH-04`, `REC-02`, `REC-04`, `PAY-02`, `PAY-03`, `BILL-01`; partial `BILL-04`, `BILL-05`, `TRE-04`, `DATA-06`, `UX-02` | Targeted local verification passed | `npm run typecheck`, all 50 application tests and the serialized memory-capped `npm run build` passed. `.data/final-workflow-result.json` and `.data/final-browser-result.json` record the source commit. Fresh company setup, employee and contractor confirmation, recipient isolation, exact payroll changes, stale-review rejection, milestone acceptance and human-agreed foreign-currency intake worked. A 204 USDC payroll with a 1 USDC ceiling showed a 205 USDC shortfall before unfunded approval. All newly integrated routes responded; zero-cash earmarks were rejected; scoped CSV exports retained payroll references and earmark columns. Browser review covered payroll, Treasury and recipient history with no exceptions or 390 px overflow. No source funding, deployment, payout or private inference was executed. |
| 2026-11-13 | `26ced9d`, checklist correction | `AUTH-03` | Cleared prior checkbox | Company creation, ownership and editable time zones work. The settlement denomination is fixed at USDC; the literal requirement also includes an editable asset default, so this requirement is not fully satisfied. No requirement was narrowed to preserve the earlier count. |

| 2026-11-13 | `8fc1f9b`, local focused review | `BILL-03`; partial `DATA-07`, `NET-06`, `TRE-09` | Duplicate safeguards verified locally; integrations remain open | Invoice intake rejects changed reused references and source-document copies; similar requests appear in the exact approval review and a new warning invalidates an older review token. Thirteen focused invoice/reconciliation checks passed. Cleared-debt reports have nine passing project/clearing checks; six clearing contract VM checks passed. Pay-from-wallet has twelve passing focused checks and its mounted integration passes TypeScript. These are local checks, not live funding, refund, clearing or payout evidence. |

Record in-progress, blocked or failed work in the log while leaving its checkbox unchecked. When a failure is corrected, add a new verification entry rather than rewriting history.
